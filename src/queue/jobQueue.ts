/**
 * Bounded in-process job queue.
 *
 * - At most `concurrency` jobs run at once (each job owns one browser context).
 * - At most `maxSize` jobs wait; beyond that callers get QUEUE_FULL (HTTP 503)
 *   so overload is shed instead of piling up.
 * - Jobs wait at most `queueTimeoutMs` before failing with QUEUE_TIMEOUT.
 * - Every running job gets an AbortSignal that fires on its deadline or when
 *   the caller cancels (e.g. client disconnect). The caller is answered
 *   immediately; the slot is released once the job has cleaned up (or after a
 *   hard grace period, so a stuck job can never leak capacity).
 */
import { AppError, isAppError } from '../errors.ts';

export interface QueueOptions {
  concurrency: number;
  maxSize: number;
  queueTimeoutMs: number;
  /** Extra time a timed-out job may take to clean up before its slot is force-released. */
  cleanupGraceMs?: number;
}

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export type Task<T> = (signal: AbortSignal) => Promise<T>;

interface Waiting {
  start: () => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

export interface QueueStats {
  active: number;
  queued: number;
  concurrency: number;
  maxSize: number;
  completed: number;
  failed: number;
  rejectedFull: number;
  queueTimeouts: number;
  jobTimeouts: number;
}

export class JobQueue {
  private readonly opts: Required<QueueOptions>;
  private active = 0;
  private readonly waiting: Waiting[] = [];
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  private readonly counters = { completed: 0, failed: 0, rejectedFull: 0, queueTimeouts: 0, jobTimeouts: 0 };

  constructor(options: QueueOptions) {
    this.opts = { cleanupGraceMs: 15_000, ...options };
  }

  stats(): QueueStats {
    return {
      active: this.active,
      queued: this.waiting.length,
      concurrency: this.opts.concurrency,
      maxSize: this.opts.maxSize,
      ...this.counters,
    };
  }

  /** Estimated wait in seconds for a new job (used for Retry-After). */
  retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(((this.waiting.length + 1) / this.opts.concurrency) * 15));
  }

  run<T>(task: Task<T>, options: RunOptions): Promise<T> {
    if (this.closed) return Promise.reject(new AppError('SHUTTING_DOWN'));
    if (options.signal?.aborted) return Promise.reject(this.reasonOf(options.signal));
    return new Promise<T>((resolve, reject) => {
      const start = () => this.execute(task, options, resolve, reject);
      if (this.active < this.opts.concurrency) {
        start();
        return;
      }
      if (this.waiting.length >= this.opts.maxSize) {
        this.counters.rejectedFull++;
        reject(new AppError('QUEUE_FULL', { extra: { retry_after: this.retryAfterSeconds() } }));
        return;
      }
      const entry: Waiting = {
        start,
        reject,
        timer: setTimeout(() => {
          this.remove(entry);
          this.counters.queueTimeouts++;
          reject(new AppError('QUEUE_TIMEOUT', { extra: { retry_after: this.retryAfterSeconds() } }));
        }, this.opts.queueTimeoutMs),
        cleanup: () => undefined,
      };
      if (options.signal) {
        const onAbort = () => {
          this.remove(entry);
          reject(this.reasonOf(options.signal!));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => options.signal!.removeEventListener('abort', onAbort);
      }
      this.waiting.push(entry);
    });
  }

  private reasonOf(signal: AbortSignal): AppError {
    return isAppError(signal.reason) ? signal.reason : new AppError('CANCELLED');
  }

  private remove(entry: Waiting): void {
    const i = this.waiting.indexOf(entry);
    if (i >= 0) this.waiting.splice(i, 1);
    clearTimeout(entry.timer);
    entry.cleanup();
  }

  private execute<T>(task: Task<T>, options: RunOptions, resolve: (v: T) => void, reject: (e: unknown) => void): void {
    this.active++;
    const controller = new AbortController();
    let answered = false;
    let released = false;
    const answer = (fn: () => void) => {
      if (answered) return;
      answered = true;
      fn();
    };
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(deadline);
      clearTimeout(hardStop);
      if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
      this.active--;
      this.next();
    };
    let hardStop: NodeJS.Timeout | undefined;
    const onExternalAbort = () => {
      const reason = this.reasonOf(options.signal!);
      controller.abort(reason);
      answer(() => reject(reason));
      hardStop ??= setTimeout(release, this.opts.cleanupGraceMs);
    };
    if (options.signal) options.signal.addEventListener('abort', onExternalAbort, { once: true });
    const deadline = setTimeout(() => {
      this.counters.jobTimeouts++;
      const err = new AppError('TIMEOUT', { detail: `Resolution did not complete within ${options.timeoutMs} ms` });
      controller.abort(err);
      answer(() => reject(err));
      hardStop ??= setTimeout(release, this.opts.cleanupGraceMs);
    }, options.timeoutMs);

    let p: Promise<T>;
    try {
      p = task(controller.signal);
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (v) => {
        this.counters.completed++;
        answer(() => resolve(v));
      },
      (err: unknown) => {
        this.counters.failed++;
        answer(() => reject(controller.signal.aborted && isAppError(controller.signal.reason) ? controller.signal.reason : err));
      },
    ).finally(release);
  }

  private next(): void {
    while (this.active < this.opts.concurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      clearTimeout(entry.timer);
      entry.cleanup();
      entry.start();
    }
    if (this.active === 0 && this.waiting.length === 0) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((fn) => fn());
    }
  }

  /** Rejects queued jobs and stops accepting new ones; running jobs continue. */
  close(): void {
    this.closed = true;
    for (const entry of this.waiting.splice(0)) {
      clearTimeout(entry.timer);
      entry.cleanup();
      entry.reject(new AppError('SHUTTING_DOWN'));
    }
    if (this.active === 0) this.next();
  }

  onIdle(): Promise<void> {
    if (this.active === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

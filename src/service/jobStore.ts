/**
 * In-memory store for asynchronous resolution jobs (POST /api/resolve with
 * "async": true, polled through GET /api/jobs/:id). Jobs are owned by the API
 * key that created them. Pending jobs are never evicted; finished jobs expire
 * ASYNC_JOB_TTL_MS after completion and are evicted oldest-first when the
 * store is full.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.ts';

export type AsyncJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AsyncJob {
  id: string;
  ownerId: string;
  status: AsyncJobStatus;
  originalUrl: string;
  createdAt: string;
  updatedAt: string;
  httpStatus?: number;
  result?: Record<string, unknown>;
}

interface Entry {
  job: AsyncJob;
  /** Expiry for finished jobs (pending jobs do not expire). */
  expires: number;
}

const isFinished = (j: AsyncJob) => j.status === 'completed' || j.status === 'failed';

export class JobStore {
  private readonly jobs = new Map<string, Entry>();
  private readonly maxJobs: number;
  private readonly ttlMs: number;

  constructor(maxJobs: number, ttlMs: number) {
    this.maxJobs = maxJobs;
    this.ttlMs = ttlMs;
  }

  private prune(now = Date.now()): void {
    for (const [id, e] of this.jobs) if (isFinished(e.job) && e.expires <= now) this.jobs.delete(id);
  }

  create(ownerId: string, originalUrl: string): AsyncJob {
    this.prune();
    if (this.jobs.size >= this.maxJobs) {
      // Make room by dropping the oldest finished job; pending jobs are never evicted.
      let oldest: [string, Entry] | undefined;
      for (const entry of this.jobs) if (isFinished(entry[1].job) && (!oldest || entry[1].expires < oldest[1].expires)) oldest = entry;
      if (!oldest) throw new AppError('QUEUE_FULL', { detail: 'Too many asynchronous jobs are pending' });
      this.jobs.delete(oldest[0]);
    }
    const now = new Date().toISOString();
    const job: AsyncJob = { id: randomUUID(), ownerId, status: 'queued', originalUrl, createdAt: now, updatedAt: now };
    this.jobs.set(job.id, { job, expires: Number.POSITIVE_INFINITY });
    return job;
  }

  get(id: string, ownerId: string): AsyncJob | undefined {
    const e = this.jobs.get(id);
    if (!e) return undefined;
    if (isFinished(e.job) && e.expires <= Date.now()) {
      this.jobs.delete(id);
      return undefined;
    }
    // Jobs of other API keys are reported as not found (no information leak).
    return e.job.ownerId === ownerId ? e.job : undefined;
  }

  update(id: string, patch: Partial<Omit<AsyncJob, 'id' | 'ownerId'>>): void {
    const e = this.jobs.get(id);
    if (!e) return;
    Object.assign(e.job, patch, { updatedAt: new Date().toISOString() });
    if (isFinished(e.job)) e.expires = Date.now() + this.ttlMs;
  }

  get size(): number {
    return this.jobs.size;
  }

  get pending(): number {
    let n = 0;
    for (const e of this.jobs.values()) if (!isFinished(e.job)) n++;
    return n;
  }
}

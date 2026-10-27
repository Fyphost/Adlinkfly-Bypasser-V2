/** Small async helpers shared across modules. */

export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class AbortedError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortedError';
  }
}

/** Resolves after `ms`, rejecting early with AbortedError if the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Races a promise against a timeout. The underlying promise is not cancelled. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Swallows rejections (used for best-effort cleanup). */
export async function settle<T>(promise: Promise<T> | undefined): Promise<T | undefined> {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

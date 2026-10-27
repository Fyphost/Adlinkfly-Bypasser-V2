/**
 * In-memory store for asynchronous resolution jobs (POST /api/resolve with
 * "async": true, polled through GET /api/jobs/:id). Jobs are owned by the API
 * key that created them and expire after ASYNC_JOB_TTL_MS.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.ts';
import { TtlCache } from './ttlCache.ts';

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

export class JobStore {
  private readonly cache: TtlCache<AsyncJob>;
  private readonly maxJobs: number;

  constructor(maxJobs: number, ttlMs: number) {
    this.cache = new TtlCache<AsyncJob>(maxJobs, ttlMs);
    this.maxJobs = maxJobs;
  }

  create(ownerId: string, originalUrl: string): AsyncJob {
    this.cache.prune();
    const pending = this.cache.values().filter((j) => j.status === 'queued' || j.status === 'running').length;
    if (pending >= this.maxJobs) throw new AppError('QUEUE_FULL', { detail: 'Too many asynchronous jobs are pending' });
    const now = new Date().toISOString();
    const job: AsyncJob = { id: randomUUID(), ownerId, status: 'queued', originalUrl, createdAt: now, updatedAt: now };
    this.cache.set(job.id, job);
    return job;
  }

  get(id: string, ownerId: string): AsyncJob | undefined {
    const job = this.cache.get(id);
    // Jobs of other API keys are reported as not found (no information leak).
    return job && job.ownerId === ownerId ? job : undefined;
  }

  update(id: string, patch: Partial<Omit<AsyncJob, 'id' | 'ownerId'>>): void {
    const job = this.cache.get(id);
    if (!job) return;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.cache.set(id, job);
  }

  get size(): number {
    return this.cache.size;
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../../src/queue/jobQueue.ts';
import { AppError } from '../../src/errors.ts';
import { sleep } from '../../src/util.ts';

const isCode = (code: string) => (e: unknown) => e instanceof AppError && e.code === code;

test('never runs more than `concurrency` jobs at once', async () => {
  const q = new JobQueue({ concurrency: 2, maxSize: 10, queueTimeoutMs: 5000 });
  let running = 0;
  let peak = 0;
  const job = async () => {
    running++;
    peak = Math.max(peak, running);
    await sleep(40);
    running--;
    return 'ok';
  };
  const results = await Promise.all(Array.from({ length: 7 }, () => q.run(job, { timeoutMs: 1000 })));
  assert.equal(peak, 2);
  assert.deepEqual(results, Array(7).fill('ok'));
  assert.equal(q.stats().completed, 7);
});

test('rejects with QUEUE_FULL when the waiting room is full', async () => {
  const q = new JobQueue({ concurrency: 1, maxSize: 1, queueTimeoutMs: 5000 });
  const slow = () => sleep(100).then(() => 1);
  const a = q.run(slow, { timeoutMs: 1000 });
  const b = q.run(slow, { timeoutMs: 1000 });
  await assert.rejects(q.run(slow, { timeoutMs: 1000 }), isCode('QUEUE_FULL'));
  assert.deepEqual(await Promise.all([a, b]), [1, 1]);
});

test('fails queued jobs with QUEUE_TIMEOUT', async () => {
  const q = new JobQueue({ concurrency: 1, maxSize: 5, queueTimeoutMs: 50 });
  const a = q.run(() => sleep(200), { timeoutMs: 1000 });
  await assert.rejects(
    q.run(() => sleep(1), { timeoutMs: 1000 }),
    isCode('QUEUE_TIMEOUT'),
  );
  await a;
});

test('aborts running jobs on their deadline and frees the slot after cleanup', async () => {
  const q = new JobQueue({ concurrency: 1, maxSize: 5, queueTimeoutMs: 5000 });
  let sawAbort = false;
  const p = q.run(
    (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          setTimeout(() => reject(new Error('cleaned up')), 20);
        });
      }),
    { timeoutMs: 50 },
  );
  await assert.rejects(p, isCode('TIMEOUT'));
  assert.ok(sawAbort);
  assert.equal(await q.run(async () => 'next', { timeoutMs: 1000 }), 'next');
});

test('cancellation removes queued jobs and aborts running ones', async () => {
  const q = new JobQueue({ concurrency: 1, maxSize: 5, queueTimeoutMs: 5000 });
  const c1 = new AbortController();
  const running = q.run((signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('x')))), {
    timeoutMs: 5000,
    signal: c1.signal,
  });
  const c2 = new AbortController();
  const queued = q.run(async () => 'never', { timeoutMs: 5000, signal: c2.signal });
  c2.abort(new AppError('CANCELLED'));
  await assert.rejects(queued, isCode('CANCELLED'));
  c1.abort(new AppError('CANCELLED'));
  await assert.rejects(running, isCode('CANCELLED'));
  assert.equal(q.stats().queued, 0);
});

test('close() rejects waiting jobs and refuses new ones', async () => {
  const q = new JobQueue({ concurrency: 1, maxSize: 5, queueTimeoutMs: 5000 });
  const a = q.run(() => sleep(50), { timeoutMs: 1000 });
  const b = q.run(() => sleep(1), { timeoutMs: 1000 });
  q.close();
  await assert.rejects(b, isCode('SHUTTING_DOWN'));
  await assert.rejects(
    q.run(() => sleep(1), { timeoutMs: 1000 }),
    isCode('SHUTTING_DOWN'),
  );
  await a;
  await q.onIdle();
});

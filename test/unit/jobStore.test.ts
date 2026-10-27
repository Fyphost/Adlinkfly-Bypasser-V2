import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../../src/service/jobStore.ts';
import { AppError } from '../../src/errors.ts';

test('never evicts pending jobs; evicts the oldest finished job when full', () => {
  const store = new JobStore(3, 60_000);
  const running = store.create('k', 'https://a.example/1');
  store.update(running.id, { status: 'running' });
  const done1 = store.create('k', 'https://a.example/2');
  store.update(done1.id, { status: 'completed' });
  const done2 = store.create('k', 'https://a.example/3');
  store.update(done2.id, { status: 'failed' });
  const fresh = store.create('k', 'https://a.example/4');
  assert.ok(store.get(running.id, 'k'), 'running job survives');
  assert.equal(store.get(done1.id, 'k'), undefined, 'oldest finished job was evicted');
  assert.ok(store.get(done2.id, 'k'));
  assert.ok(store.get(fresh.id, 'k'));
});

test('rejects new jobs when every slot is pending', () => {
  const store = new JobStore(2, 60_000);
  store.create('k', 'u1');
  store.create('k', 'u2');
  assert.throws(
    () => store.create('k', 'u3'),
    (e: unknown) => e instanceof AppError && e.code === 'QUEUE_FULL',
  );
});

test('finished jobs expire after the TTL; jobs are visible to their owner only', async () => {
  const store = new JobStore(10, 30);
  const j = store.create('owner', 'u');
  assert.equal(store.get(j.id, 'someone-else'), undefined);
  store.update(j.id, { status: 'completed' });
  assert.ok(store.get(j.id, 'owner'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.get(j.id, 'owner'), undefined);
});

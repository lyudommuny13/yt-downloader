import test from 'node:test';
import assert from 'node:assert/strict';

import { createJobQueue } from '../src/lib/job-queue.js';

test('job queue requires a processor', async () => {
  await assert.rejects(
    createJobQueue({}),
    /processor is required/,
  );
});

test('job queue requires a PostgreSQL connection URL', async () => {
  await assert.rejects(
    createJobQueue({ processor: async () => ({ delivered: true }) }),
    /DATABASE_URL is required/,
  );
});

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL queue retries failed jobs and persists completed state across instances', {
  skip: !databaseUrl,
}, async () => {
  let executions = 0;
  const queueName = `download-tests-${process.pid}-${Date.now()}`;
  const queue = await createJobQueue({
    queueName,
    concurrency: 1,
    attempts: 2,
    backoffDelayMs: 10,
    databaseUrl,
    processor: async () => {
      executions += 1;
      if (executions === 1) {
        throw new Error('Expected first-attempt failure');
      }
      return { delivered: true };
    },
  });
  let queueClosed = false;

  try {
    const queuedJob = await queue.addJob({
      chatId: 123,
      fileType: 'mp3',
    });
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      const job = await queue.getJob(queuedJob.id);
      if (job && job.getState() === 'completed') {
        assert.equal(executions, 2);
        assert.equal(job.attemptsMade, 2);
        assert.deepEqual(job.returnvalue, { delivered: true });
        await queue.close();
        queueClosed = true;

        const restartedQueue = await createJobQueue({
          queueName,
          concurrency: 1,
          databaseUrl,
          processor: async () => {
            assert.fail('Completed jobs must not run again after restart.');
          },
        });
        try {
          const persistedJob = await restartedQueue.getJob(queuedJob.id);
          assert.equal(persistedJob.getState(), 'completed');
          assert.equal(persistedJob.attemptsMade, 2);
          assert.deepEqual(persistedJob.returnvalue, { delivered: true });
        } finally {
          await restartedQueue.close();
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.fail('Expected the retrying job to complete.');
  } finally {
    if (!queueClosed) await queue.close();
  }
});

test('PostgreSQL queue does not retry permanent job failures', {
  skip: !databaseUrl,
}, async () => {
  let executions = 0;
  const queue = await createJobQueue({
    queueName: `download-tests-${process.pid}-${Date.now()}`,
    concurrency: 1,
    attempts: 3,
    backoffDelayMs: 10,
    databaseUrl,
    processor: async () => {
      executions += 1;
      const error = new Error('Unsupported URL');
      error.retryable = false;
      throw error;
    },
  });

  try {
    const queuedJob = await queue.addJob({ chatId: 123, fileType: 'mp4' });
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      const job = await queue.getJob(queuedJob.id);
      if (job?.getState() === 'failed') {
        assert.equal(executions, 1);
        assert.equal(job.attemptsMade, 1);
        assert.match(job.error.message, /Unsupported URL/);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.fail('Expected the permanent failure to become terminal.');
  } finally {
    await queue.close();
  }
});

test('queue health reports PostgreSQL-backed state', { skip: !databaseUrl }, async () => {
  const queue = await createJobQueue({
    queueName: `download-tests-${process.pid}-${Date.now()}`,
    databaseUrl,
    processor: async () => ({ delivered: true }),
  });

  try {
    const stats = await queue.getStats();
    assert.equal(stats.provider, 'postgres');
    assert.deepEqual(stats.counts, {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    });
  } finally {
    await queue.close();
  }
});

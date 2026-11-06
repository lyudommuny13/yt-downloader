import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { logger } from './logger.js';
import { isPermanentJobError } from './job-errors.js';
import { metrics } from '../telemetry/metrics.js';

const { Pool } = pg;
const LOCK_DURATION_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

function mapJob(row) {
  if (!row) return null;

  return {
    id: row.id,
    name: 'download',
    data: row.data,
    opts: row.opts,
    state: row.state,
    attemptsMade: row.attempts_made,
    progress: row.progress,
    availableAt: new Date(row.available_at).getTime(),
    returnvalue: row.returnvalue ?? undefined,
    error: row.error ? new Error(row.error) : undefined,
    getState() {
      return this.state;
    },
  };
}

export async function createJobQueue({
  queueName = 'download_jobs',
  concurrency = 2,
  processor,
  databaseUrl,
  attempts = 3,
  backoffDelayMs = 5000,
}) {
  if (typeof processor !== 'function') {
    throw new TypeError('A download job processor is required.');
  }
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for the PostgreSQL job queue.');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: concurrency + 2 });
  const workerId = randomUUID();
  const activeTasks = new Set();
  let isClosed = false;
  let isPolling = false;
  let activeWorkers = 0;
  let pollTimer;
  let drainTask;

  pool.on('error', (error) => {
    logger.error('Unexpected PostgreSQL pool error.', { error: error.message });
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_user_id BIGINT PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        username TEXT,
        first_name TEXT NOT NULL,
        last_name TEXT,
        language_code TEXT,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS download_jobs (
        id TEXT PRIMARY KEY,
        queue_name TEXT NOT NULL,
        user_id BIGINT REFERENCES users(telegram_user_id),
        data JSONB NOT NULL,
        opts JSONB NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('waiting', 'active', 'delayed', 'failed', 'completed')),
        attempts_made INTEGER NOT NULL DEFAULT 0,
        progress INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        returnvalue JSONB,
        error TEXT,
        locked_by TEXT,
        lock_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      ALTER TABLE download_jobs
      ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(telegram_user_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS download_jobs_ready_idx
      ON download_jobs (queue_name, state, available_at, created_at)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS download_jobs_user_id_idx
      ON download_jobs (user_id)
      WHERE user_id IS NOT NULL
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS download_jobs_lock_idx
      ON download_jobs (queue_name, lock_until)
      WHERE state = 'active'
    `);
  } catch (error) {
    await pool.end();
    throw new Error(`Unable to initialize PostgreSQL download queue: ${error.message}`, { cause: error });
  }

  function scheduleDrain(delayMs = 0) {
    if (isClosed || pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      drainTask = drain();
    }, delayMs);
    pollTimer.unref();
  }

  async function claimNextJob() {
    const result = await pool.query(`
      UPDATE download_jobs AS job
      SET state = 'active',
          attempts_made = job.attempts_made + 1,
          locked_by = $2,
          lock_until = NOW() + ($3 * INTERVAL '1 millisecond'),
          updated_at = NOW()
      WHERE job.id = (
        SELECT candidate.id
        FROM download_jobs AS candidate
        WHERE candidate.queue_name = $1
          AND (
            candidate.state = 'waiting'
            OR (candidate.state = 'delayed' AND candidate.available_at <= NOW())
            OR (candidate.state = 'active' AND candidate.lock_until < NOW())
          )
        ORDER BY candidate.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING job.*
    `, [queueName, workerId, LOCK_DURATION_MS]);
    return mapJob(result.rows[0]);
  }

  async function updateProgress(jobId, value) {
    const result = await pool.query(`
      UPDATE download_jobs
      SET progress = $3, updated_at = NOW()
      WHERE id = $1 AND queue_name = $2 AND locked_by = $4
    `, [jobId, queueName, value, workerId]);
    if (result.rowCount !== 1) {
      throw new Error(`Unable to persist progress for download job "${jobId}".`);
    }
    return value;
  }

  async function processJob(job) {
    let heartbeat;
    try {
      heartbeat = setInterval(() => {
        void pool.query(`
          UPDATE download_jobs
          SET lock_until = NOW() + ($3 * INTERVAL '1 millisecond')
          WHERE id = $1 AND queue_name = $2 AND locked_by = $4 AND state = 'active'
        `, [job.id, queueName, LOCK_DURATION_MS, workerId]).catch((error) => {
          logger.warn('Unable to renew download job lock.', {
            jobId: job.id,
            error: error.message,
          });
        });
      }, Math.floor(LOCK_DURATION_MS / 3));
      heartbeat.unref();

      const result = await processor({
        ...job,
        updateProgress: (value) => updateProgress(job.id, value),
      });

      const completion = await pool.query(`
        UPDATE download_jobs
        SET state = 'completed', returnvalue = $3, error = NULL,
            locked_by = NULL, lock_until = NULL, updated_at = NOW()
        WHERE id = $1 AND queue_name = $2 AND locked_by = $4
      `, [job.id, queueName, JSON.stringify(result ?? null), workerId]);
      if (completion.rowCount !== 1) {
        throw new Error(`Download job "${job.id}" lost its lock before completion.`);
      }
      metrics.jobsCompleted.inc({ format: job.data.fileType });
      logger.info('Download job completed.', { jobId: job.id, chatId: job.data.chatId });
    } catch (error) {
      const permanentFailure = isPermanentJobError(error);
      const isTerminal = permanentFailure || job.attemptsMade >= (job.opts.attempts || 1);
      const nextState = isTerminal ? 'failed' : 'delayed';
      const delayMs = job.opts.backoffDelayMs ?? backoffDelayMs;

      try {
        const persistedFailure = await pool.query(`
          UPDATE download_jobs
          SET state = $3,
              error = $4,
              available_at = CASE WHEN $3 = 'delayed'
                THEN NOW() + ($5 * INTERVAL '1 millisecond')
                ELSE available_at
              END,
              locked_by = NULL,
              lock_until = NULL,
              updated_at = NOW()
          WHERE id = $1 AND queue_name = $2 AND locked_by = $6
        `, [job.id, queueName, nextState, error.message, delayMs, workerId]);
        if (persistedFailure.rowCount !== 1) {
          logger.warn('Download job lock was lost before recording its failure.', { jobId: job.id });
          return;
        }
      } catch (persistError) {
        logger.error('Unable to persist download job failure.', {
          jobId: job.id,
          error: persistError.message,
        });
        return;
      }

      if (isTerminal) {
        metrics.jobsFailed.inc({ format: job.data.fileType });
      } else {
        metrics.jobsRetried.inc({ format: job.data.fileType });
      }
      logger.error('Download job attempt failed.', {
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        permanentFailure,
        ...(isTerminal ? {} : { nextAttemptInMs: delayMs }),
        error: error.message,
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      metrics.jobsActive.dec();
      activeWorkers -= 1;
      if (!isClosed) scheduleDrain();
    }
  }

  async function drain() {
    if (isPolling || isClosed) return;
    isPolling = true;
    try {
      while (!isClosed && activeWorkers < concurrency) {
        const job = await claimNextJob();
        if (!job) break;
        if (isClosed) {
          await pool.query(`
            UPDATE download_jobs
            SET state = 'waiting', attempts_made = GREATEST(attempts_made - 1, 0),
                locked_by = NULL, lock_until = NULL, updated_at = NOW()
            WHERE id = $1 AND locked_by = $2
          `, [job.id, workerId]);
          break;
        }

        activeWorkers += 1;
        metrics.jobsActive.inc();
        logger.info('Download job started.', { jobId: job.id, chatId: job.data.chatId });
        const task = processJob(job);
        activeTasks.add(task);
        void task.finally(() => {
          activeTasks.delete(task);
        });
      }
    } catch (error) {
      logger.error('Unable to poll PostgreSQL download queue.', { error: error.message });
    } finally {
      isPolling = false;
      if (!isClosed && activeWorkers < concurrency) scheduleDrain(POLL_INTERVAL_MS);
    }
  }

  scheduleDrain();

  return {
    async upsertUser(user) {
      await pool.query(`
        INSERT INTO users (
          telegram_user_id, chat_id, username, first_name, last_name, language_code
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (telegram_user_id) DO UPDATE
        SET chat_id = EXCLUDED.chat_id,
            username = EXCLUDED.username,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            language_code = EXCLUDED.language_code,
            last_seen_at = NOW()
      `, [
        user.telegramUserId,
        user.chatId,
        user.username,
        user.firstName,
        user.lastName,
        user.languageCode,
      ]);
    },
    async addJob(data, options = {}) {
      const id = `${queueName}-${randomUUID()}`;
      const opts = {
        attempts: options.attempts ?? attempts,
        backoffDelayMs: options.backoffDelayMs ?? backoffDelayMs,
      };
      const result = await pool.query(`
        INSERT INTO download_jobs (id, queue_name, user_id, data, opts, state)
        VALUES ($1, $2, $3, $4, $5, 'waiting')
        RETURNING *
      `, [id, queueName, data.userId ?? null, JSON.stringify(data), JSON.stringify(opts)]);
      metrics.jobsEnqueued.inc({ format: data.fileType });
      scheduleDrain();
      return mapJob(result.rows[0]);
    },
    async getJob(jobId) {
      const result = await pool.query(
        'SELECT * FROM download_jobs WHERE id = $1 AND queue_name = $2',
        [jobId, queueName],
      );
      return mapJob(result.rows[0]);
    },
    async getStats() {
      const result = await pool.query(`
        SELECT state, COUNT(*)::INTEGER AS count
        FROM download_jobs
        WHERE queue_name = $1
        GROUP BY state
      `, [queueName]);
      const counts = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
      for (const row of result.rows) counts[row.state] = row.count;
      for (const [state, count] of Object.entries(counts)) {
        metrics.jobsByState.set({ state }, count);
      }
      return { provider: 'postgres', counts };
    },
    async ping() {
      await pool.query('SELECT 1');
      return true;
    },
    async close() {
      if (isClosed) return;
      isClosed = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (drainTask) await drainTask;
      await Promise.all(activeTasks);
      await pool.end();
    },
  };
}

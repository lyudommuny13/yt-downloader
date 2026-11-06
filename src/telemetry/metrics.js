import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const metrics = {
  jobsEnqueued: new Counter({
    name: 'downloader_jobs_enqueued_total',
    help: 'Total number of accepted download jobs.',
    labelNames: ['format'],
    registers: [registry],
  }),
  jobsCompleted: new Counter({
    name: 'downloader_jobs_completed_total',
    help: 'Total number of completed download jobs.',
    labelNames: ['format'],
    registers: [registry],
  }),
  jobsFailed: new Counter({
    name: 'downloader_jobs_failed_total',
    help: 'Total number of permanently failed download jobs.',
    labelNames: ['format'],
    registers: [registry],
  }),
  jobsRetried: new Counter({
    name: 'downloader_job_retries_total',
    help: 'Total number of failed attempts that will be retried.',
    labelNames: ['format'],
    registers: [registry],
  }),
  jobsActive: new Gauge({
    name: 'downloader_jobs_active',
    help: 'Number of download jobs currently processing.',
    registers: [registry],
  }),
  jobsByState: new Gauge({
    name: 'downloader_jobs',
    help: 'Current number of download jobs by queue state.',
    labelNames: ['state'],
    registers: [registry],
  }),
  jobDuration: new Histogram({
    name: 'downloader_job_duration_seconds',
    help: 'Time spent processing download jobs.',
    labelNames: ['format', 'result'],
    buckets: [1, 5, 15, 30, 60, 120, 300, 600],
    registers: [registry],
  }),
};

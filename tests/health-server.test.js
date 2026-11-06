import test from 'node:test';
import assert from 'node:assert/strict';

import { createHealthServer } from '../src/telemetry/health-server.js';

test('health server provides liveness, readiness, and Prometheus exposition', async (t) => {
  const server = createHealthServer({
    port: 0,
    jobQueue: {
      async getStats() {
        return { provider: 'postgres', counts: { waiting: 0 } };
      },
    },
    isBotRunning: () => true,
  });

  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);

  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).status, 'ready');
  assert.match(metrics.headers.get('content-type'), /text\/plain/);
  assert.match(await metrics.text(), /process_cpu_seconds_total/);
});

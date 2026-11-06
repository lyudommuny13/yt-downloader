import express from 'express';
import { registry } from './metrics.js';
import { logger } from '../lib/logger.js';

export function createHealthServer({
  port = Number(process.env.PORT || 3000),
  jobQueue,
  isBotRunning,
}) {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', async (_req, res) => {
    try {
      const queue = await jobQueue.getStats();
      const botReady = isBotRunning();
      const ready = botReady && typeof queue === 'object';
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        bot: botReady ? 'running' : 'starting',
        queue,
      });
    } catch (error) {
      logger.warn('Readiness check failed.', { error: error.message });
      res.status(503).json({ status: 'not_ready' });
    }
  });

  app.get('/metrics', async (_req, res) => {
    try {
      await jobQueue.getStats();
    } catch (error) {
      logger.warn('Unable to refresh queue metrics.', { error: error.message });
    }
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });

  const server = app.listen(port, '0.0.0.0');
  return server;
}

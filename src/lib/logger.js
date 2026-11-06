const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function currentLevel() {
  return LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? LOG_LEVELS.info;
}

function shouldLog(level) {
  return (LOG_LEVELS[level] ?? LOG_LEVELS.info) <= currentLevel();
}

function write(level, message, meta = {}) {
  if (!shouldLog(level)) return;

  const timestamp = new Date().toISOString();
  const payload = { timestamp, level, message, ...meta };

  if (level === 'error') {
    console.error(payload);
    return;
  }

  if (level === 'warn') {
    console.warn(payload);
    return;
  }

  console.log(payload);
}

export const logger = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta),
};

import fs from 'fs';
import path from 'path';

export class SessionStore {
  constructor(filePath, ttlMs = 30 * 60 * 1000) {
    this.filePath = path.resolve(filePath);
    this.ttlMs = ttlMs;
    this.store = this.load();
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    this.ensureDirectory();
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({}, null, 2));
      return {};
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  }

  persist() {
    this.ensureDirectory();
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.store, null, 2));
    fs.renameSync(temporaryPath, this.filePath);
  }

  set(chatId, session) {
    this.store[String(chatId)] = {
      ...session,
      cachedAt: Date.now(),
    };
    this.persist();
  }

  get(chatId) {
    const key = String(chatId);
    const entry = this.store[key];

    if (!entry) {
      return undefined;
    }

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      delete this.store[key];
      this.persist();
      return undefined;
    }

    const { cachedAt, ...session } = entry;
    return session;
  }

  delete(chatId) {
    delete this.store[String(chatId)];
    this.persist();
  }

  clear() {
    this.store = {};
    this.persist();
  }
}

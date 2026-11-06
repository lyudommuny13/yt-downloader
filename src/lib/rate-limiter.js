export class RateLimiter {
  constructor({ windowMs = 60 * 1000, maxRequests = 10 } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.buckets = new Map();
  }

  check(chatId) {
    const now = Date.now();
    const bucket = this.buckets.get(chatId);

    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      this.buckets.set(chatId, { windowStart: now, count: 1 });
      return true;
    }

    if (bucket.count >= this.maxRequests) {
      return false;
    }

    bucket.count += 1;
    return true;
  }

  reset(chatId) {
    this.buckets.delete(chatId);
  }
}

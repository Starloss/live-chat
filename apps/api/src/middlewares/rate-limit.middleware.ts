import type { NextFunction, Request, Response } from "express";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  message: string;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export function createRateLimitMiddleware(options: RateLimitOptions) {
  const store = new Map<string, RateLimitEntry>();

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";

    const current = store.get(key);
    if (!current || current.resetAt <= now) {
      store.set(key, {
        count: 1,
        resetAt: now + options.windowMs
      });
      return next();
    }

    if (current.count >= options.maxRequests) {
      const retryAfterSeconds = Math.ceil((current.resetAt - now) / 1000);
      res.setHeader("Retry-After", retryAfterSeconds.toString());
      return res.status(429).json({ message: options.message });
    }

    current.count += 1;
    store.set(key, current);
    return next();
  };
}

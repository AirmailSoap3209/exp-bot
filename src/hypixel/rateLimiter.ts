export interface RateLimitState {
  limit?: number;
  remaining?: number;
  /** Epoch ms when the current window resets. */
  resetAt?: number;
}

export interface RateLimiterOptions {
  /** Wait for the window to reset once `remaining` is at or below this. */
  lowWater: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Serialises keyed requests and throttles them using Hypixel's
 * RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset headers.
 * Requests are queued, never rejected for being over the limit.
 */
export class RateLimiter {
  readonly state: RateLimitState = {};
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queued = 0;

  constructor(private readonly opts: RateLimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get queueLength(): number {
    return this.queued;
  }

  /** Runs `task` after every earlier task, waiting out the window first if it is nearly spent. */
  schedule<T>(task: () => Promise<T>): Promise<T> {
    this.queued++;
    const run = async () => {
      try {
        await this.waitForWindow();
        return await task();
      } finally {
        this.queued--;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Milliseconds the next request would wait right now (0 if none). */
  delayNeeded(): number {
    const { remaining, resetAt } = this.state;
    if (remaining === undefined || resetAt === undefined) return 0;
    if (remaining > this.opts.lowWater) return 0;
    return Math.max(0, resetAt - this.now());
  }

  /** Sleeps until the window resets if it is nearly spent. */
  async waitForWindow(): Promise<void> {
    const ms = this.delayNeeded();
    if (ms > 0) {
      await this.sleep(ms);
      // New window: we no longer know the count until the next response tells us.
      this.state.remaining = undefined;
    }
  }

  /** Update state from a keyed response's headers. */
  update(headers: Headers, status?: number): void {
    const num = (name: string) => {
      const raw = headers.get(name);
      if (raw === null) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const limit = num('ratelimit-limit');
    const remaining = num('ratelimit-remaining');
    const resetSec = num('ratelimit-reset') ?? num('retry-after');
    if (limit !== undefined) this.state.limit = limit;
    if (remaining !== undefined) this.state.remaining = remaining;
    if (resetSec !== undefined) this.state.resetAt = this.now() + resetSec * 1000;
    if (status === 429) {
      this.state.remaining = 0;
      if (resetSec === undefined) this.state.resetAt = this.now() + 60_000;
    }
  }
}

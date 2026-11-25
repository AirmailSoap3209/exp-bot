import { TtlCache } from './cache.js';
import { RateLimiter } from './rateLimiter.js';
import { RequestLog } from './requestLog.js';

const HYPIXEL = 'https://api.hypixel.net';
const MOJANG = 'https://api.mojang.com/users/profiles/minecraft';
const MAX_ATTEMPTS = 3;

export class HypixelApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly cause?: string,
  ) {
    super(message);
    this.name = 'HypixelApiError';
  }
}

export class PlayerNotFoundError extends Error {
  constructor(readonly username: string) {
    super(`No Minecraft account named "${username}"`);
    this.name = 'PlayerNotFoundError';
  }
}

/** Raw profile as Hypixel returns it. Left loose on purpose: the normalizer (step 2) types it. */
export interface RawProfile {
  profile_id: string;
  cute_name?: string;
  selected?: boolean;
  game_mode?: string;
  members: Record<string, Record<string, unknown>>;
  banking?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProfilesResponse {
  success: boolean;
  profiles: RawProfile[] | null;
}

/** Raw Garden as Hypixel returns it; null when the profile has no Garden yet. Typed by the normalizer. */
export interface GardenResponse {
  success: boolean;
  garden: Record<string, unknown> | null;
}

export interface Fetched<T> {
  data: T;
  /** Epoch ms the data was fetched from the API. */
  fetchedAt: number;
  fromCache: boolean;
}

export interface HypixelClientOptions {
  apiKey?: string;
  lowWater: number;
  profileTtlMs: number;
  resourceTtlMs: number;
  requestLogPath: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const normalizeUuid = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
const isUuid = (s: string) => /^[0-9a-f]{32}$/i.test(s.replace(/-/g, ''));

export class HypixelClient {
  readonly limiter: RateLimiter;
  private readonly log: RequestLog;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly profiles: TtlCache<ProfilesResponse>;
  private readonly gardens: TtlCache<GardenResponse>;
  private readonly resources: TtlCache<unknown>;
  private readonly names: TtlCache<{ uuid: string; name: string }>;

  constructor(private readonly opts: HypixelClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.limiter = new RateLimiter({ lowWater: opts.lowWater, now: this.now, sleep: opts.sleep });
    this.log = new RequestLog(opts.requestLogPath);
    this.profiles = new TtlCache(opts.profileTtlMs, this.now);
    this.gardens = new TtlCache(opts.profileTtlMs, this.now);
    this.resources = new TtlCache(opts.resourceTtlMs, this.now);
    this.names = new TtlCache(opts.resourceTtlMs, this.now);
  }

  /** Username (or UUID) to dashless UUID and canonical name. Not keyed. */
  async resolvePlayer(usernameOrUuid: string): Promise<{ uuid: string; name: string }> {
    const input = usernameOrUuid.trim();
    if (isUuid(input)) return { uuid: normalizeUuid(input), name: input };
    const key = input.toLowerCase();
    const { value } = await this.names.getOrLoad(key, async () => {
      const res = await this.fetchFn(`${MOJANG}/${encodeURIComponent(input)}`);
      if (res.status === 204 || res.status === 404) throw new PlayerNotFoundError(input);
      if (!res.ok) throw new HypixelApiError(`Mojang lookup failed (${res.status})`, res.status);
      const body = (await res.json()) as { id: string; name: string };
      return { uuid: normalizeUuid(body.id), name: body.name };
    });
    return value;
  }

  /** All SkyBlock profiles for a player. Keyed; cached 60s per UUID. */
  async getProfiles(uuid: string, opts: { skipCache?: boolean } = {}): Promise<Fetched<ProfilesResponse>> {
    const id = normalizeUuid(uuid);
    const r = await this.profiles.getOrLoad(
      id,
      () => this.keyed<ProfilesResponse>(`/v2/skyblock/profiles?uuid=${id}`),
      opts,
    );
    return { data: r.value, fetchedAt: r.storedAt, fromCache: r.fromCache };
  }

  /**
   * A profile's Garden (/v2/skyblock/garden). Keyed; cached like profiles. A profile that never
   * opened the Garden answers 404 "No garden data": that comes back as `garden: null`.
   */
  async getGarden(profileId: string, opts: { skipCache?: boolean } = {}): Promise<Fetched<GardenResponse>> {
    const id = normalizeUuid(profileId);
    const r = await this.gardens.getOrLoad(
      id,
      async () => {
        try {
          return await this.keyed<GardenResponse>(`/v2/skyblock/garden?profile=${id}`);
        } catch (err) {
          if (err instanceof HypixelApiError && err.status === 404) return { success: true, garden: null };
          throw err;
        }
      },
      opts,
    );
    return { data: r.value, fetchedAt: r.storedAt, fromCache: r.fromCache };
  }

  getSkillsResource(): Promise<Fetched<unknown>> {
    return this.resource('/v2/resources/skyblock/skills');
  }

  getCollectionsResource(): Promise<Fetched<unknown>> {
    return this.resource('/v2/resources/skyblock/collections');
  }

  private async resource(path: string): Promise<Fetched<unknown>> {
    const r = await this.resources.getOrLoad(path, async () => {
      const res = await this.fetchFn(HYPIXEL + path);
      const body = await this.parse(res, path);
      return body;
    });
    return { data: r.value, fetchedAt: r.storedAt, fromCache: r.fromCache };
  }

  private keyed<T>(path: string): Promise<T> {
    const key = this.opts.apiKey;
    if (!key) return Promise.reject(new Error('HYPIXEL_API_KEY is not set'));
    return this.limiter.schedule(async () => {
      for (let attempt = 1; ; attempt++) {
        const started = this.now();
        const res = await this.fetchFn(HYPIXEL + path, { headers: { 'API-Key': key } });
        this.limiter.update(res.headers, res.status);
        await this.log.write({
          time: new Date(started).toISOString(),
          path,
          status: res.status,
          remaining: this.limiter.state.remaining,
          limit: this.limiter.state.limit,
          durationMs: this.now() - started,
          attempt,
        });
        if (res.status === 429 && attempt < MAX_ATTEMPTS) {
          // Back off until the window resets, then retry instead of failing.
          await this.limiter.waitForWindow();
          continue;
        }
        return (await this.parse(res, path)) as T;
      }
    });
  }

  private async parse(res: Response, path: string): Promise<unknown> {
    let body: { success?: boolean; cause?: string } | undefined;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = undefined;
    }
    if (!res.ok || body?.success === false) {
      const cause = body?.cause;
      const hint =
        res.status === 403 ? ' (invalid or missing API key)' :
        res.status === 429 ? ' (rate limited)' : '';
      throw new HypixelApiError(
        `Hypixel ${path.split('?')[0]} failed: ${res.status}${hint}${cause ? ` - ${cause}` : ''}`,
        res.status,
        cause,
      );
    }
    return body;
  }
}

import 'dotenv/config';

function optional(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function required(name: string): string {
  const v = optional(name);
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

export const config = {
  discordToken: optional('DISCORD_TOKEN'),
  discordClientId: optional('DISCORD_CLIENT_ID'),
  discordGuildId: optional('DISCORD_GUILD_ID'),
  hypixelApiKey: optional('HYPIXEL_API_KEY'),
  rateLowWater: Number(optional('HYPIXEL_RATE_LOW_WATER') ?? 5),
  /** Profile responses are cached per UUID for this long. */
  profileTtlMs: 60_000,
  /** Public resources and Mojang lookups are cached for this long. */
  resourceTtlMs: 24 * 60 * 60_000,
  requestLogPath: 'logs/hypixel-requests.log',
};

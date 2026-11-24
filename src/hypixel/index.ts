import { config } from '../config.js';
import { HypixelClient } from './client.js';

export * from './client.js';

/** Shared client used by the bot and scripts. */
export const hypixel = new HypixelClient({
  apiKey: config.hypixelApiKey,
  lowWater: config.rateLowWater,
  profileTtlMs: config.profileTtlMs,
  resourceTtlMs: config.resourceTtlMs,
  requestLogPath: config.requestLogPath,
});

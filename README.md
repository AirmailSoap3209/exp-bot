# SkyBlock XP Optimizer Bot

A personal Discord bot that ranks the quickest non-monetary SkyBlock XP tasks a player can still do. See the v1 spec for full behaviour.

## Setup

```sh
npm install
cp .env.example .env   # fill in HYPIXEL_API_KEY (and Discord values once commands exist)
```

| Script | Does |
|---|---|
| `npm run check-api -- <username> [...]` | Build step 1 check: fetches profiles, writes `test/fixtures/API_CHECK.md` and raw fixtures |
| `npm test` | Unit tests (vitest) |
| `npm run typecheck` | Type-checks `src`, `scripts` and `test` |
| `npm run build` / `npm start` | Compile to `dist/` and run the bot |
| `npm run dev` | Run the bot with reload |

## Build progress

- [x] **1. API check (code):** skeleton, Hypixel client, 60s profile cache / 24h resource cache, header-driven rate limiter that queues, keyed request log at `logs/hypixel-requests.log`
- [x] **1. API check (data):** fixtures for 3 players / 6 profiles in `test/fixtures/` (findings below)
- [x] **2. Profile normalizer:** `src/profile/`, tested against the fixtures. `npm run show-profile -- <player> [profile]` prints one.
- [x] 3. Task catalogue + `/xp coverage` (see "Task catalogue" below)
- [x] 4. Progress and status + `/xp overview player:<name> [profile]` (`npm run overview -- <fixture player> [profile]` prints it offline)
  - Readers in `src/tasks/readers/` (one per category) report a number and how far it can be trusted: `exact`, `lowerBound` (co-op member hidden) or `approx` (bestiary families).
  - `src/tasks/progress.ts` turns that into one status per task. The rules, in order:
    1. In Hypixel's completed-task list → verified complete.
    2. An exact or lower-bound number at the requirement → verified complete.
    3. An exact number short of it, or a one-time task missing from the list → verified incomplete. This clears a manual tick.
    4. Ticked → ticked.
    5. Approximate → estimated.
    6. No data → unavailable.
- [ ] 5. Estimates and ranking + `/xp optimize`
- [x] 6. Settings: `/xp link`, `/xp exclude`/`include`, `/xp tick`/`untick`, `/xp rate`. Saved as JSON in `storage-data/` (gitignored).
  - Links and category exclusions are keyed by Discord user. Exclusions apply to every lookup.
  - Ticks and rate overrides are keyed by player UUID + profile ID, and only apply when looking at your linked profile.
  - `/xp tick` refuses tasks the API already proves done or not done. Ticks the API later contradicts are cleared on the next `/xp overview`.
  - `/xp rate` overrides are stored and validated against catalogue activities, but nothing reads them until step 5's `/xp optimize`.
- [ ] 7. Sessions
- [ ] 8. `/xp category`, `/xp task`

## API check findings (2026-11-24)

- **`leveling.completed_tasks` exists**, but only holds one-time tasks: slayer first kills (`DEFEAT_ZOMBIE_SLAYER_ONE`), floor completions (`COMPLETE_CATACOMBS0`–`7`, `COMPLETE_MASTER_CATACOMBS1`–`7`), objectives, songs, essence perks, Abiphone, bank. Skills, collections, bestiary, minions and fairy souls never appear, so those need their own readers. A task entry can carry the Hypixel task ID so "verified complete" comes straight from the list.
- **Missing data cannot be told apart from never-played data**, apart from the cases below. Fresh or newly joined profiles omit `bestiary`, `slayer`, `dungeons`, `fairy_soul` and `crafted_generators` entirely. The normalizer marks these unavailable, never zero.
- **Collections API off**: `member.collection` is missing, but `player_data.unlocked_coll_tiers` is still there. Tier completion stays verifiable, and only the amounts are unknown.
- **Skills API off or no XP**: `player_data.experience` comes back as `{}` in both cases. It is treated as unavailable.
- **Inventory API off**: `inventory` only contains `bag_contents`. Not needed in v1.
- **Co-ops**: collection amounts are per member, and tiers use the co-op total. Members who left keep their data but have `profile.deletion_notice`, and they are excluded from the sum.
- Rate limit on the permanent key: 300 per window.

## Task catalogue

`data/tasks/*.json` is **generated**. Don't edit it by hand:

```sh
npm run catalogue:sources   # refresh data/sources/ (Hypixel resources live, NEU pinned to a commit)
npm run catalogue:build     # data/sources/ -> data/tasks/*.json + data/bestiary/families.json (validated)
npm run coverage            # print the /xp coverage report
npm run deploy-commands     # register /xp with Discord (DISCORD_GUILD_ID for instant updates)
```

| Category | Built from |
|---|---|
| Skills, Collections | Hypixel `resources/skyblock/*` (the "+N SkyBlock XP" in each level/tier's unlocks) |
| Bestiary | NEU `bestiary.json` families + `data/sources/bestiary-overrides.json`; XP per the wiki |
| Minions | NEU `misc.json` minion max tiers; per-tier XP and recipe unlocks from the wiki / collections resource |
| Slayer, Catacombs, Fairy Souls | `data/sources/wiki-xp.json` (hand-transcribed from the fandom wiki) + `data/leveling/` |

The official Hypixel Wiki closed in July 2026, so wiki values come from hypixel-skyblock.fandom.com.

The loader (`src/tasks/catalogue.ts`) rejects the whole catalogue if any entry is malformed. That covers shape, duplicate IDs, unknown prerequisites or cycles, an entry in the wrong category file, and non-monetary tasks in a "never" category. The bot won't start with an invalid catalogue.

**Known gaps and disagreements**

- **Bestiary:** NEU's families undercount real tiers by ~5% (Lime: 1,466 computed vs milestone 154 ≈ 1,540). Treat family tiers as estimates until checked in-game. Milestones come straight from the API.
- **Slayer:** the wiki's max is 30 XP above what its per-level table gives, so Riftstalker level XP is unverified. NEU also says spider level 2 needs 15 XP, where `data/leveling/slayer.json` says 25.
- **Minions:** the catalogue has 3,165 XP against the wiki's 2,963. NEU lists more minion tiers than the wiki counts.
- **Guide totals:** `data/meta.json` `guideCategories[].maxXp` is `null` until read from the in-game SkyBlock Leveling menu. Until then coverage shows `~` estimates and never reaches 100%.

## Hypixel client notes

- Keyed calls (`/v2/skyblock/profiles`) run one at a time. When `RateLimit-Remaining` drops to `HYPIXEL_RATE_LOW_WATER` or lower, the next call waits for `RateLimit-Reset`. A 429 waits for the reset and is retried up to 3 times.
- Each keyed request is logged as one JSON line: time, path, status, remaining, limit, duration. The key is never logged.
- Mojang username lookups are cached for 24h. That isn't in the spec, but it saves repeat lookups.

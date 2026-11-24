/**
 * Registers slash commands with Discord.
 *
 *   npm run deploy-commands        (after npm run build; on the server)
 *   npm run deploy-commands:dev    (from source, needs dev dependencies)
 *
 * With DISCORD_GUILD_ID set, commands go to that server and update instantly.
 * Without it they are global, which can take up to an hour to appear.
 */
import { REST, Routes } from 'discord.js';
import { config, required } from './config.js';
import { commands } from './commands/index.js';

const rest = new REST().setToken(required('DISCORD_TOKEN'));
const clientId = required('DISCORD_CLIENT_ID');
const body = [...commands.values()].map((c) => c.data.toJSON());

const route = config.discordGuildId
  ? Routes.applicationGuildCommands(clientId, config.discordGuildId)
  : Routes.applicationCommands(clientId);

await rest.put(route, { body });
console.log(`Registered ${body.length} command(s) ${config.discordGuildId ? `to guild ${config.discordGuildId}` : 'globally'}.`);

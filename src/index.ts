import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { required } from './config.js';
import { commands } from './commands/index.js';
import { userData } from './storage/userData.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    try {
      await commands.get(interaction.commandName)?.autocomplete?.(interaction);
    } catch (err) {
      console.error('autocomplete failed', err);
    }
    return;
  }
  if (interaction.isButton()) {
    try {
      // Button IDs start with "xp" for the /xp command.
      if (interaction.customId.startsWith('xp')) await commands.get('xp')?.button?.(interaction);
    } catch (err) {
      console.error('button failed', err);
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`/${interaction.commandName} failed`, err);
    const content = 'Something went wrong running that command.';
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (replyErr) {
      // The interaction may have expired; nothing more to tell the user.
      console.error('could not report the error to Discord', replyErr);
    }
  }
});

// A stray error is logged, not fatal: the bot keeps serving other commands.
process.on('unhandledRejection', (reason) => console.error('unhandled rejection', reason));
process.on('uncaughtException', (err) => console.error('uncaught exception', err));

// pm2 / systemd stop the bot with SIGINT or SIGTERM: finish storage writes, then disconnect.
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  const timer = setTimeout(() => process.exit(1), 10_000);
  try {
    await userData.flush();
    await client.destroy();
  } catch (err) {
    console.error('error during shutdown', err);
  }
  clearTimeout(timer);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

client.login(required('DISCORD_TOKEN')).catch((err) => {
  console.error('Discord login failed (check DISCORD_TOKEN):', err);
  process.exit(1);
});

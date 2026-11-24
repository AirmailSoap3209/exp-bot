import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { required } from './config.js';
import { commands } from './commands/index.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(err);
    const content = 'Something went wrong running that command.';
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
});

client.login(required('DISCORD_TOKEN'));

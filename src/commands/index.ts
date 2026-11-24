import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { xp } from './xp.js';

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
  /** Buttons whose customId starts with a prefix this command owns. */
  button?(interaction: ButtonInteraction): Promise<void>;
}

/** Registered commands, keyed by name. */
export const commands = new Map<string, Command>([[xp.data.name, xp]]);

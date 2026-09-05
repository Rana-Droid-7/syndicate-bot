import { Client, Collection, GatewayIntentBits, Partials } from "discord.js";
import type { AnyCommand, Command } from "../types/command.js";
import type { SuggestionCandidate } from "../lib/suggest.js";

export class SyndicateClient extends Client {
  // Keyed by command name (slash commands AND right-click context
  // menu commands share this collection — dispatch distinguishes them)
  public slashCommands = new Collection<string, AnyCommand>();
  // Keyed by every prefix alias (e.g. "h", "commands" for help)
  public prefixCommands = new Collection<string, Command>();
  // Names of commands that exist only as slash commands. Populated
  // by the loader so the prefix dispatcher can explain WHY ">boot"
  // does nothing instead of silence.
  public slashOnlyCommands = new Set<string>();

  /**
   * Flattened candidate list for prefix typo-suggestions and
   * starts-with lookups. Rebuilt by the loader — canonical name +
   * every prefix alias per command.
   */
  public suggestionCandidates: SuggestionCandidate[] = [];

  public startTime = Date.now();

  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Message, Partials.Channel],
    });

    // Client is an EventEmitter: an 'error' event with no listener
    // takes the whole process down (Node's throw-on-unhandled-'error'
    // rule) — a transient gateway hiccup must never do that. The
    // sweep/restore safety nets re-deliver anything missed during a
    // brief disconnect anyway.
    this.on("error", (error) => {
      console.error(`[${new Date().toISOString()}] [ERROR] [EVENT] Gateway/client error (process continues):`, error);
    });
  }
}

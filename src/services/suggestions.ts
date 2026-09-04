import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../core/config.js";
import { log } from "../core/logger.js";
import { suggestionRepository } from "../repositories/suggestions.js";
import { sanitizeEcho } from "../lib/validation.js";

/**
 * Suggestion service. SQL is authoritative; the plain-text file
 * under data/ is kept as a human-readable export written on every
 * insert (newline-safe, one line per entry).
 */
export const suggestionService = {
  async add(guildId: string, authorId: string, authorTag: string, guildName: string, content: string): Promise<number> {
    const safe = sanitizeEcho(content);
    const id = suggestionRepository.add(guildId, authorId, safe);

    // Human-readable export — best-effort; a failed export must not
    // fail the suggestion itself (the DB row is the record).
    try {
      await mkdir(path.dirname(config.suggestionsFile), { recursive: true });
      const timestamp = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
      await appendFile(
        config.suggestionsFile,
        `[${timestamp}] Guild: ${guildName} (${guildId}) | User: ${authorTag} (${authorId}) | Suggestion: "${safe.replace(/\r?\n+/g, " ")}"\n`,
        "utf-8",
      );
    } catch (error) {
      log.warn("SUGGEST", `Suggestion #${id} saved to DB but the txt export failed`, error);
    }

    log.info("SUGGEST", `Suggestion #${id} from ${authorId} in guild ${guildId} logged.`);
    return id;
  },
};

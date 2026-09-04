import { sanitizeEcho } from "../../lib/validation.js";

/**
 * Suggestion-specific sanitization: echo-safety (mass mentions,
 * invisible characters) plus newline collapsing so the export file
 * stays one-line-per-entry.
 */
export function sanitizeSuggestion(text: string): string {
  return sanitizeEcho(text).replace(/\r?\n+/g, " ").trim();
}

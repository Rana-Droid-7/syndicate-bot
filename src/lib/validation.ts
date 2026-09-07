import { UserInputError } from "./errors.js";

/**
 * Centralized input validation. Every user-controlled value passes
 * through one of these BEFORE any embed is built — never trust the
 * client to have pre-filtered it.
 */

/**
 * Splits a prefix command's argument string on whitespace, but
 * keeps double-quoted sections ("like this") as single tokens.
 * Backslash escapes inside quotes: \" -> ", \\ -> \.
 *
 * Malformed quoting falls back to whitespace splitting with the
 * quotes left literal — a typo'd quote must never crash dispatch.
 */
export function parseQuotedArgs(input: string): { args: string[] } {
  const raw = input;
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let wasQuoted = false;

  const push = () => {
    if (current.length > 0 || wasQuoted) {
      tokens.push(current);
      current = "";
      wasQuoted = false;
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (ch === "\\" && inQuotes && (raw[i + 1] === '"' || raw[i + 1] === "\\")) {
      current += raw[i + 1];
      i++;
      continue;
    }

    if (ch === '"') {
      if (inQuotes) {
        // closing quote
        inQuotes = false;
        wasQuoted = true;
      } else {
        inQuotes = true;
        wasQuoted = true;
        // An opening quote mid-token acts as a token boundary.
        if (current.length > 0) push();
      }
      continue;
    }

    if (!inQuotes && /\s/.test(ch)) {
      push();
      continue;
    }

    current += ch;
  }

  // Unterminated quote: treat accumulated content as one token.
  push();

  return { args: tokens };
}

/** True if the string is a plausible Discord snowflake (ID). */
export function isSnowflake(value: string): boolean {
  return /^\d{15,20}$/.test(value);
}

/** Strips a user mention to the raw ID: <@123> or <@!123> -> 123. */
export function mentionToId(value: string): string {
  // Strict mention form first: <@id> or <@!id> exactly — a loose
  // character-strip would CONCATENATE fragments ("123<@2>" -> "1232")
  // into a different user's ID.
  const mention = /^<@!?(\d{15,20})>$/.exec(value.trim());
  if (mention) return mention[1];
  // Not a mention: treat as a bare ID candidate, verbatim.
  return value.trim();
}

/**
 * Parses an integer within [min, max]; throws UserInputError otherwise.
 *
 * The strict `/^\d+$/` gate matters: Number() accepts "0x10" (16),
 * "1e3" (1000), and "1_0" (10) as integers — so a bare Number check
 * let `>joke remove 0x10` delete joke #16. Only plain decimal digits
 * are valid input.
 */
export function parseIntInRange(raw: string, min: number, max: number, label: string, usage?: string): number {
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new UserInputError(`\`${escapeInlineCode(raw)}\` isn't a valid ${label} — it must be a whole number between ${min} and ${max}.`, usage);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UserInputError(`\`${escapeInlineCode(raw)}\` isn't a valid ${label} — it must be a whole number between ${min} and ${max}.`, usage);
  }
  return value;
}

/**
 * Makes user-provided text safe to embed inside bold markdown
 * (a literal ** would otherwise terminate the bold early).
 */
export function escapeMarkdownBold(text: string): string {
  return text.replace(/\*\*/g, "*\u200b*").replace(/__/g, "_\u200b_");
}

/**
 * Makes user-provided text safe to echo in normal (non-code) embed
 * text: neutralizes mass-mention keywords and strips invisible /
 * control characters that enable formatting and spam tricks.
 *
 * Order matters: invisible characters are stripped FIRST, then the
 * mention is broken with a zero-width space — doing it the other
 * way around would strip the very character that breaks the ping.
 *
 * Inputs that are ENTIRELY invisible/control characters sanitize to
 * "" — callers that must not store/emit empty (DB CHECKs between 1
 * and N, embed titles, button labels) use sanitizeEchoOrReject and
 * treat that as invalid input instead of crashing later.
 */
export function sanitizeEcho(text: string): string {
  return text
    // Control chars, zero-width chars, word-joiners, BOM, line/paragraph
    // separators, AND the bidi marks (U+200E/U+200F LTR/RTL overrides,
    // U+061C Arabic letter mark) — bidi marks enable reversed-text
    // spoofs ("nn.com\u200Fevi\u200Bl.ht" style) in echoed notices.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u061C\u2060\uFEFF\u2028\u2029]/g, "")
    .replace(/@(everyone|here)/gi, "@\u200b$1");
}

/**
 * sanitizeEcho + emptiness gate. Returns null when the sanitized
 * result is empty (the input was nothing but invisible characters,
 * zero-width junk, or whitespace) — the caller decides the user-
 * facing error. Prevents two crash families at once: DB CHECK
 * violations (length BETWEEN 1 AND N) on insert, and discord.js
 * validation throws (empty embed title / button label).
 */
export function sanitizeEchoOrReject(text: string): string | null {
  const safe = sanitizeEcho(text.trim());
  return safe.length > 0 ? safe : null;
}

/** Safe code-block content: backticks can't close the block early. */
export function escapeCodeBlock(text: string): string {
  return text.replace(/`/g, "'");
}

/**
 * Safe inline-code content: a raw backtick in user input would close
 * the span early (`` `x` <@victim> `` escapes the span and the
 * mention renders as a real ping in CONTENT replies). Same neutralize
 * strategy as escapeCodeBlock — one shared helper for every error
 * message that interpolates a raw user string into single backticks.
 */
export function escapeInlineCode(text: string): string {
  return text.replace(/`/g, "\u2019"); // right single quote — visually close, inert
}

/** Truncates on a logical boundary (last space) rather than mid-word. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Full pipeline for user text echoed inside bold markers. */
export function safeBoldText(text: string): string {
  return escapeMarkdownBold(sanitizeEcho(text));
}

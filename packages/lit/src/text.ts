/**
 * What is done to text that a site sent, before anything keeps or shows it. `clean` is for what is stored (a hit's text and
 * title): control characters, bidirectional marks and zero-width characters go, white space is one space, the length is
 * bounded. `shown` is for where a person reads it (the briefing, the report, RESULT.md): the same, and the characters that
 * markup or a table would read are escaped, so that fetched text cannot form a link, a tag or a cell.
 * `normalizeQuote` is the normalization of a quote and of the text it is looked up in (the one the citation guard applies to
 * references, documentation/guards.md: white space collapsed, case folded), with the quote marks and dashes of typography made plain.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Runs of three or more `<` or `>` become two: the judge's prompt delimits each hit with `<<<` and `>>>` markers, which fetched text must not forge. */
export function clean(text: string, maxChars: number): string {
  return text.replace(INVISIBLE, "").replace(/<{3,}/g, "<<").replace(/>{3,}/g, ">>").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export function shown(text: string, maxChars = 300): string {
  const cleaned = clean(text, maxChars);
  const ellipsis = text.length > cleaned.length && cleaned.length >= maxChars ? "..." : "";
  return (
    cleaned
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`/g, "'")
      .replace(/\|/g, "\\|")
      .replace(/[[\]]/g, (c) => `\\${c}`) + ellipsis
  );
}

export function normalizeQuote(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The shortest quote worth keeping: below it a "quote" is a word that is in any text. */
export const MIN_QUOTE_CHARS = 25;

/** Whether the quote is a verbatim substring of the fetched text, after `normalizeQuote` on both. */
export function quoteIsIn(quote: string, fetched: string): boolean {
  const q = normalizeQuote(quote);
  return q.length >= MIN_QUOTE_CHARS && normalizeQuote(fetched).includes(q);
}

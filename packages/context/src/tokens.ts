/**
 * The one upper bound on a text's size in tokens, used for the packet's budget and for the report alike: an ASCII character
 * costs 1/3 of a token and any other character (Lean's symbols: ∀ ∃ ∣ ≤ ℕ ⟨⟩ →) 1.5. Lean text runs near 2 to 2.5 characters a token
 * in the usual tokenizers, so the bound errs on the side of a smaller packet, never a larger one. No tokenizer of any model is used.
 */
export const ASCII_TOKENS = 1 / 3;
export const OTHER_TOKENS = 1.5;

export function estimateTokens(text: string): number {
  let n = 0;
  for (const ch of text) n += ch.charCodeAt(0) < 128 ? ASCII_TOKENS : OTHER_TOKENS;
  return Math.max(0, Math.ceil(n - 1e-9));
}

/** The longest prefix of `text` that `estimateTokens` puts at `tokens` or fewer. */
export function cutToTokens(text: string, tokens: number): string {
  let n = 0;
  let out = "";
  for (const ch of text) {
    n += ch.charCodeAt(0) < 128 ? ASCII_TOKENS : OTHER_TOKENS;
    if (n - 1e-9 > tokens) break;
    out += ch;
  }
  return out;
}

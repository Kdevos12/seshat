/**
 * The one approximation of a text's size in tokens, used for the packet's budget and for the report alike: a token is
 * 3.5 characters. Lean text with its symbols is denser than English, so the estimate errs on the side of a smaller packet.
 * No tokenizer of any model is used.
 */
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / CHARS_PER_TOKEN);
}

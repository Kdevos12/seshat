import { conclusionOf } from "./access.ts";

/**
 * Loogle-style statement patterns (plan §13): the prover states a pattern and the engine runs it, in code. Three forms:
 *
 * - constants: `Nat.succ, Finset.sum` (a comma separated list): every name must occur in the statement;
 * - a shape with metavariables: `?a + ?b = ?b + ?a`, where `?x` stands for any subexpression (the same `?x` twice must be the
 *   same text) and `_` for any subexpression; the shape may occur anywhere in the statement;
 * - the shape of the conclusion: `⊢ ?a ∣ ?b`, matched against what follows the statement's last colon only.
 *
 * Matching is on the text of the statement with its whitespace collapsed; it is not unification up to definitional equality.
 */
export type PatternKind = "constants" | "shape" | "conclusion";

export interface Pattern {
  kind: PatternKind;
  matches: (statement: string) => boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME = "[\\p{L}\\p{N}_.'!?]";

export function parsePattern(raw: string): Pattern {
  let text = raw.replace(/\s+/g, " ").trim();
  if (text.length > MAX_PATTERN_CHARS) throw new Error(`the pattern is longer than ${MAX_PATTERN_CHARS} characters`);
  if (text === "") throw new Error("the pattern is empty");
  const conclusion = text.startsWith("⊢");
  if (conclusion) text = text.slice(1).trim();
  if (text === "") throw new Error("the pattern has nothing after ⊢");
  const wild = /\?[\p{L}][\p{L}\p{N}_]*|(?<![\p{L}\p{N}_])_(?![\p{L}\p{N}_])/u;
  if (!conclusion && !wild.test(text) && /^[\p{L}][\p{L}\p{N}_.']*(\s*,\s*[\p{L}][\p{L}\p{N}_.']*)*$/u.test(text)) {
    const names = text.split(",").map((n) => n.trim());
    const regexes = names.map((n) => new RegExp(`(?<!${NAME})${escape(n)}(?!${NAME})`, "u"));
    return { kind: "constants", matches: (statement) => regexes.every((r) => r.test(statement)) };
  }
  const parts = [...text.matchAll(/\?[\p{L}][\p{L}\p{N}_]*|_(?![\p{L}\p{N}_])|[\p{L}\p{N}_.'!?]+|\s+|[^]/gu)].map((m) => m[0]).filter((t) => !/^\s+$/.test(t));
  const items: Item[] = parts.map((t) => (t.startsWith("?") && t.length > 1 ? { meta: t } : t === "_" ? { meta: "" } : { lit: t }));
  if (items.filter((x) => "meta" in x).length > MAX_METAS) throw new Error(`the pattern has more than ${MAX_METAS} metavariables or wildcards`);
  return {
    kind: conclusion ? "conclusion" : "shape",
    matches: (statement) => matchTokens(items, tokensOf(conclusion ? conclusionOf(statement) : statement)),
  };
}

/** A pattern is short and has few holes: the matcher below is bounded by a step count, and these bounds keep the work small. */
export const MAX_PATTERN_CHARS = 64;
export const MAX_METAS = 4;
const MAX_STEPS = 4000;

type Item = { lit: string } | { meta: string };

const tokensOf = (text: string): string[] => [...text.matchAll(/[\p{L}\p{N}_.'!?]+|\s+|[^]/gu)].map((m) => m[0]).filter((t) => !/^\s+$/.test(t));

/** Token-wise matching with backtracking and a step counter; a statement that exhausts it does not match. No regular expression sees a model string. */
function matchTokens(items: Item[], tokens: string[]): boolean {
  let steps = 0;
  const go = (p: number, s: number, bound: Map<string, string>): boolean => {
    if (++steps > MAX_STEPS) return false;
    if (p === items.length) return true;
    const item = items[p] as Item;
    if ("lit" in item) return s < tokens.length && tokens[s] === item.lit && go(p + 1, s + 1, bound);
    const known = item.meta === "" ? undefined : bound.get(item.meta);
    if (known !== undefined) {
      const want = known.split("\u0000");
      if (s + want.length > tokens.length) return false;
      for (let k = 0; k < want.length; k++) if (tokens[s + k] !== want[k]) return false;
      return go(p + 1, s + want.length, bound);
    }
    for (let len = 1; s + len <= tokens.length; len++) {
      if (steps > MAX_STEPS) return false;
      const next = item.meta === "" ? bound : new Map(bound).set(item.meta, tokens.slice(s, s + len).join("\u0000"));
      if (go(p + 1, s + len, next)) return true;
    }
    return false;
  };
  for (let start = 0; start < tokens.length && steps <= MAX_STEPS; start++) if (go(0, start, new Map())) return true;
  return false;
}

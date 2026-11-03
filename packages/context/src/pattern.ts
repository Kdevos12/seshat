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
  const groups = new Map<string, string>();
  let source = "";
  for (const m of text.matchAll(/\?[\p{L}][\p{L}\p{N}_]*|_(?![\p{L}\p{N}_])|[\p{L}\p{N}_.'!?]+|\s+|[^]/gu)) {
    const token = m[0];
    if (token.startsWith("?") && token.length > 1) {
      const known = groups.get(token);
      if (known !== undefined) source += `\\k<${known}>`;
      else {
        const group = `v${groups.size}`;
        groups.set(token, group);
        source += `(?<${group}>\\S.*?)`;
      }
    } else if (token === "_") source += ".+?";
    else if (/^\s+$/.test(token)) source += "\\s*";
    else if (new RegExp(`^${NAME}+$`, "u").test(token)) source += `(?<!${NAME})${escape(token)}(?!${NAME})`;
    else source += escape(token);
  }
  const regex = new RegExp(source, "su");
  return { kind: conclusion ? "conclusion" : "shape", matches: (statement) => regex.test((conclusion ? conclusionOf(statement) : statement).replace(/\s+/g, " ")) };
}

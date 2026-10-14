import { collapseWhitespace, maskCommentsAndStrings, stripLeanComments } from "@seshat/core";

/**
 * A statement in signature form (`(n : ℕ) {m : ℕ} : n ≤ m`) cut at its top-level colon. The graph
 * writes link lemmas and negations about statements without Lean: it needs the statement as one
 * proposition (`∀ (n : ℕ) {m : ℕ}, n ≤ m`) and the arguments that turn a proof of that proposition
 * into a proof of the goal that is left once the binders are introduced.
 */
export interface Signature {
  /** The binder groups as written, such as `(n : ℕ) {m : ℕ}`; empty when there are none. */
  binders: string;
  /** What follows the top-level colon. */
  type: string;
  /**
   * The explicit binders, in order: what a proof of the closed proposition is applied to. An
   * anonymous binder (`(_ : n > 0)`) is `‹_›`, which Lean fills with a hypothesis of the context.
   */
  args: string[];
}

const OPEN = "([{⟨⦃⟦⁅";
const CLOSE = ")]}⟩⦄⟧⁆";

/** Cuts a statement in signature form at its first colon outside brackets. */
export function parseSignature(statement: string): Signature {
  const text = collapseWhitespace(stripLeanComments(statement));
  const masked = maskCommentsAndStrings(text);
  let depth = 0;
  let colon = -1;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i] as string;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (depth === 0 && c === ":" && masked[i + 1] !== "=") {
      colon = i;
      break;
    }
  }
  if (colon < 0) throw new Error(`not a statement in signature form (no ':' outside brackets): ${text.slice(0, 80)}`);
  const binders = text.slice(0, colon).trim();
  const type = text.slice(colon + 1).trim();
  if (type === "") throw new Error(`not a statement in signature form (nothing after the ':'): ${text.slice(0, 80)}`);
  return { binders, type, args: explicitBinders(binders) };
}

/** The names of the explicit binders: those in parentheses, and bare names outside any bracket. */
function explicitBinders(binders: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let group = "";
  let bare = "";
  const flushBare = () => {
    for (const name of bare.split(/\s+/)) if (name !== "") names.push(name);
    bare = "";
  };
  for (const c of binders) {
    if (OPEN.includes(c)) {
      if (depth === 0) {
        flushBare();
        group = c;
      } else {
        group += c;
      }
      depth++;
    } else if (CLOSE.includes(c)) {
      depth--;
      group += c;
      if (depth === 0) {
        if (group.startsWith("(")) names.push(...parenthesizedNames(group.slice(1, -1)));
        group = "";
      }
    } else if (depth > 0) {
      group += c;
    } else {
      bare += c;
    }
  }
  flushBare();
  return names;
}

/** `a b : ℕ` gives a and b; a binder without a type (`h`) is its own name. */
function parenthesizedNames(inside: string): string[] {
  const masked = maskCommentsAndStrings(inside);
  let depth = 0;
  let end = inside.length;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i] as string;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (depth === 0 && c === ":" && masked[i + 1] !== "=") {
      end = i;
      break;
    }
  }
  return inside
    .slice(0, end)
    .split(/\s+/)
    .filter((name) => name !== "")
    .map((name) => (name === "_" ? "‹_›" : name));
}

/** The statement as one proposition: `∀ binders, type`, or the type alone when there are no binders. */
export function closedProp(signature: Signature): string {
  return signature.binders === "" ? signature.type : `∀ ${signature.binders}, ${signature.type}`;
}

/** The proposition in parentheses, as the link lemmas write it. */
export function paren(signature: Signature): string {
  return `(${closedProp(signature)})`;
}

/** The statement of the negation of a statement, in signature form: `: ¬ (∀ binders, type)`. */
export function negationStatement(statement: string): string {
  return `: ¬ ${paren(parseSignature(statement))}`;
}

/** A term applied to the explicit binders: what closes the goal that is left once they are introduced. */
export function applied(term: string, signature: Signature): string {
  return [term, ...signature.args].join(" ");
}

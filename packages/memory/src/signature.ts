import { maskCommentsAndStrings } from "@seshat/core";

/** Words that begin a command, never a binder: a statement that starts with one is a whole declaration. */
const COMMAND_WORDS = new Set([
  "theorem", "lemma", "example", "def", "abbrev", "instance", "axiom", "opaque", "structure", "class", "inductive",
  "namespace", "section", "open", "import", "variable", "universe", "end",
]);
const LET_WORDS = new Set(["let", "letI", "have", "haveI"]);
const OPENERS = "([{⟨⦃⟦⁅";
const CLOSERS = ")]}⟩⦄⟧⁆";
/** The brackets that open a binder group: explicit, implicit, instance and strict implicit. */
const BINDER_OPENERS = "({[⦃";
const IDENTIFIER = /(?:«[^»]*»|[\p{L}_][\p{L}\p{N}_'!?]*)(?:\.(?:«[^»]*»|[\p{L}\p{N}_][\p{L}\p{N}_'!?]*))*/uy;
const WORD = /[\p{L}_][\p{L}\p{N}_'!?]*/uy;

/**
 * Why a text is not a formal statement in signature form, or undefined when it is. Signature form is
 * what stands between a theorem's name and its `:=`: binders (bracketed groups or bare names), then
 * `:` and the type: `(n : ℕ) : n + 0 = n`, or `: 1 + 1 = 2` without binders. A bare proposition
 * (`1 + 1 = 2`, `∀ n : ℕ, n = n`) is not: put a `:` before it. The check is syntactic and
 * conservative: it refuses what cannot be a signature, and leaves Lean to say whether the binders
 * and the type make sense.
 */
export function signatureProblem(statement: string): string | undefined {
  const text = maskCommentsAndStrings(statement);
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
  };
  skipSpace();
  if (i === text.length) return "the statement is empty";
  // The universe parameters of the declaration's name: `theorem name.{u} (α : Type u) : ...`.
  if (text.startsWith(".{", i)) {
    const close = closing(text, i + 1);
    if (close < 0) return "the '{' of the universe parameters is not closed";
    i = close + 1;
  }
  for (;;) {
    skipSpace();
    if (i === text.length) return "there is no ':' before the type: write ':' before a statement that has no binders";
    const c = text.charAt(i);
    if (text.startsWith(":=", i)) return "it contains ':=' and a proof: give only the binders and the type";
    if (c === ":") break;
    if (BINDER_OPENERS.includes(c)) {
      const close = closing(text, i);
      if (close < 0) return `the '${c}' is not closed`;
      i = close + 1;
      continue;
    }
    IDENTIFIER.lastIndex = i;
    const name = IDENTIFIER.exec(text)?.[0];
    if (name === undefined) return `'${String.fromCodePoint(text.codePointAt(i) ?? 0)}' is not a binder: write ':' before a statement that has none`;
    if (COMMAND_WORDS.has(name)) return `it starts with '${name}': give what follows the theorem's name, without ':=' and a proof`;
    i += name.length;
  }
  i++;
  skipSpace();
  if (i === text.length) return "there is nothing after the ':'";
  if (hasProof(text, i)) return "it contains ':=' and a proof: give only the binders and the type";
  return undefined;
}

/**
 * The message for a statement that is not in signature form: what is wrong, the form, and the
 * statement as given. Undefined when it is in signature form.
 */
export function signatureMessage(statement: string): string | undefined {
  const problem = signatureProblem(statement);
  if (problem === undefined) return undefined;
  const shown = statement.trim().replace(/\s+/g, " ");
  return (
    `the statement is not in signature form (${problem}). A formal statement is what stands between a theorem's name ` +
    `and its ':=': the binders, then ':' and the type, such as "(n : ℕ) : n + 0 = n" or ": 1 + 1 = 2". ` +
    `Got: ${shown.length > 100 ? `${shown.slice(0, 100)}...` : shown}`
  );
}

/** The index of the bracket that closes the one at `at`, or -1. */
function closing(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text.charAt(i);
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** A `:=` outside brackets that does not belong to a `let` or `have` of the type. */
function hasProof(text: string, from: number): boolean {
  let depth = 0;
  let pending = 0;
  for (let i = from; i < text.length; i++) {
    const c = text.charAt(i);
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) depth--;
    else if (depth !== 0) continue;
    else if (/[\p{L}_]/u.test(c) && !/[\p{L}\p{N}_'.!?]/u.test(text.charAt(i - 1))) {
      WORD.lastIndex = i;
      const word = WORD.exec(text)?.[0] ?? c;
      if (LET_WORDS.has(word)) pending++;
      i += word.length - 1;
    } else if (c === ":" && text.charAt(i + 1) === "=") {
      if (pending === 0) return true;
      pending--;
      i++;
    }
  }
  return false;
}

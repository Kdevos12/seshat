import { forbiddenTokensIn, maskCommentsAndStrings } from "@seshat/core";
import { compileLaw, type Law, LawSyntaxError, parseLaw } from "./laws.ts";
import type { Magma } from "./objects.ts";

/**
 * A statement of a claim that the package can try on small objects: equational laws of magmas, and
 * statements about one natural number. The statement is in signature form (the binders, then `:`
 * and the type); a statement of another shape is not recognized, and the line leaves it alone.
 */
export type RecognizedStatement = MagmaStatement | NatStatement;

/**
 * `(M : Type) [Mul M] (h : law) ... : law`, or the hypotheses as premises of the conclusion
 * (`: (law) → law`), or no hypothesis at all (`(M : Type) [Mul M] : law`). Every magma satisfies
 * the statement when each magma that satisfies all the hypotheses satisfies the conclusion.
 */
export interface MagmaStatement {
  kind: "magma";
  /** The name of the type of the magma, such as `M`. */
  type: string;
  /**
   * The sort of that type as the binder writes it: `Type`, `Type 0`, `Type*`, `Type _`, `Type u`,
   * `Type 1`. In the claim a sort that is not `Type` is a universe parameter, which the proof of a
   * negation cannot fill with `Fin n` ({@link needsLift}).
   */
  sort: string;
  /** The class of its operation: `Mul` (written `*`) or `Magma` (written `◇` in the equational theories project). */
  operation: "Mul" | "Magma";
  hypotheses: Array<{ text: string; law: Law }>;
  conclusion: { text: string; law: Law };
}

/** `(n : ℕ) (h : P n) ... : Q n`, or `: ∀ n : ℕ, Q n`: a statement about one natural number. */
export interface NatStatement {
  kind: "nat";
  variable: string;
  /** The proposition about the variable, the hypotheses as premises of the conclusion: `(P n) → (Q n)`. */
  body: string;
}

export type Recognition = { statement: RecognizedStatement } | { reason: string };

interface Binder {
  /** `(`, `{`, `[` or `⦃`. */
  bracket: string;
  names: string[];
  type: string;
}

const OPEN = "([{⟨⦃⟦⁅";
const CLOSE = ")]}⟩⦄⟧⁆";
const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_'!?]*$/u;
const NAT_TYPES = new Set(["ℕ", "Nat"]);
const TYPE_SORT = /^Type(?:\*| _| [\p{L}\p{N}_]+)?$/u;
const SMALL_SORT = /^Type(?: 0)?$/u;

/**
 * Whether the objects that refute a statement must be lifted to its sort. A claim over `Type*`,
 * `Type _` or `Type u` is a statement with a universe parameter, and inside the proof of its
 * negation that universe is a rigid `u_1`: `Fin n : Type` does not fit the claim's first argument,
 * but `ULift (Fin n)` does, for any universe. Only `Type` and `Type 0` take `Fin n` as it is.
 */
export function needsLift(statement: MagmaStatement): boolean {
  return !SMALL_SORT.test(statement.sort);
}

/** The index of the bracket that closes the one at `at`, or -1. */
function closing(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text.charAt(i);
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** The index of the first `:` outside brackets that is not a `:=`, or -1. */
function topColon(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === ":" && depth === 0 && text.charAt(i + 1) !== "=") return i;
  }
  return -1;
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The binders of a signature, then its type; or why it has another shape. The text is read with its
 * comments and strings blanked, which is also the text that goes into a Lean file (the body of a
 * statement about a number is written as it is), so it is refused when it holds a token that the
 * validator refuses in a proof: `#eval`, `macro_rules`, `IO`... A declaration can be ended by the
 * text and commands added after it, and the statements come from claims and from the provers' tool.
 */
function splitSignature(statement: string): { binders: Binder[]; conclusion: string } | { reason: string } {
  const text = maskCommentsAndStrings(statement);
  const forbidden = forbiddenTokensIn(text);
  if (forbidden.length > 0) {
    return { reason: `the statement holds the token${forbidden.length > 1 ? "s" : ""} ${forbidden.map((t) => `'${t}'`).join(", ")}, and a statement with a token that the validator refuses in a proof is not written into a Lean file` };
  }
  // `#` starts a command (`#eval`, `#print`, `#check`...), and nothing the line reads has one: a statement is a signature.
  if (text.includes("#")) {
    return { reason: "the statement holds '#', which starts a Lean command such as #check, and no statement the line reads needs it" };
  }
  const binders: Binder[] = [];
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
    if (i >= text.length) return { reason: "there is no ':' before the type" };
    const c = text.charAt(i);
    if (c === ":") break;
    if (!"({[⦃".includes(c)) return { reason: "a binder is not bracketed" };
    const end = closing(text, i);
    if (end < 0) return { reason: "a bracket is not closed" };
    const inner = text.slice(i + 1, end);
    const colon = topColon(inner);
    if (c === "[") {
      binders.push(colon < 0 ? { bracket: c, names: [], type: tidy(inner) } : { bracket: c, names: [tidy(inner.slice(0, colon))], type: tidy(inner.slice(colon + 1)) });
    } else {
      if (colon < 0) return { reason: `the binder ${tidy(text.slice(i, end + 1))} has no type` };
      const names = tidy(inner.slice(0, colon)).split(" ").filter((n) => n !== "");
      if (names.length === 0 || !names.every((n) => n === "_" || IDENTIFIER.test(n))) return { reason: `the binder ${tidy(text.slice(i, end + 1))} does not name variables` };
      binders.push({ bracket: c, names, type: tidy(inner.slice(colon + 1)) });
    }
    i = end + 1;
  }
  return { binders, conclusion: tidy(text.slice(i + 1)) };
}

const BINDER_SYMBOLS = "∀∃λΠΣ";
const NAME_CHARACTER = /[\p{L}\p{N}_'!?.]/u;

/** Whether `fun` starts at `at`, as a word. */
function funAt(text: string, at: number): boolean {
  return text.startsWith("fun", at) && !NAME_CHARACTER.test(text.charAt(at - 1)) && !NAME_CHARACTER.test(text.charAt(at + 3));
}

/**
 * The pieces of a text split at the arrows `→` and `->` that are outside brackets; or why it cannot
 * be split. The body of `∀`, `∃` and `fun` reaches as far right as the text goes, so an arrow that
 * follows one of them outside brackets is inside its scope: Lean reads
 * `∀ x : M, p → ∀ y : M, q` as `∀ x : M, (p → ∀ y : M, q)`, not as an implication between two laws.
 */
function splitArrows(text: string): string[] | { reason: string } {
  const pieces: string[] = [];
  let depth = 0;
  let from = 0;
  let binder: number | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (depth === 0 && (BINDER_SYMBOLS.includes(c) || funAt(text, i))) binder ??= i;
    else if (depth === 0 && (c === "→" || (c === "-" && text.charAt(i + 1) === ">"))) {
      if (binder !== undefined) {
        return { reason: `the arrow after '${tidy(text.slice(binder, i))}' is inside the scope of the quantifier, which Lean reads to the end of the statement: put the quantified premise in parentheses` };
      }
      pieces.push(text.slice(from, i));
      i += c === "→" ? 0 : 1;
      from = i + 1;
    }
  }
  pieces.push(text.slice(from));
  return pieces.map(tidy);
}

/** A text without the pair of parentheses that wraps it all. */
function unwrap(text: string): string {
  let current = tidy(text);
  while (current.startsWith("(") && closing(current, 0) === current.length - 1) current = tidy(current.slice(1, -1));
  return current;
}

function occurs(name: string, text: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_'.])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_'])`, "u").test(text);
}

/** Tells which statement a signature is: a magma statement, a natural-number statement, or neither (with the reason). */
export function recognizeStatement(statement: string): Recognition {
  const split = splitSignature(statement);
  if ("reason" in split) return { reason: split.reason };
  const { binders, conclusion } = split;
  const first = binders[0];
  if (first === undefined) return recognizeQuantified(conclusion);
  if (first.names.length === 1 && TYPE_SORT.test(first.type)) return recognizeMagma(binders, conclusion);
  if (first.names.length === 1 && NAT_TYPES.has(first.type) && first.bracket !== "[") return recognizeNat(first.names[0] as string, binders.slice(1), conclusion);
  return { reason: `the first binder, ${first.bracket}${first.names.join(" ")} : ${first.type}, is neither a type for a magma nor a natural number` };
}

function recognizeMagma(binders: Binder[], conclusion: string): Recognition {
  const type = (binders[0] as Binder).names[0] as string;
  const instance = binders[1];
  const operation = instance === undefined || instance.bracket !== "[" ? undefined : /^(Mul|Magma) (\S+)$/u.exec(instance.type);
  if (operation === undefined || operation === null || operation[2] !== type) return { reason: `the type ${type} needs the instance [Mul ${type}] or [Magma ${type}] and nothing else` };
  const hypotheses: Array<{ text: string; law: Law }> = [];
  const read = (text: string, what: string): { text: string; law: Law } | { reason: string } => {
    try {
      const law = parseLaw(text, { implicit: false });
      if (law.type !== undefined && law.type !== type) return { reason: `${what} quantifies over ${law.type}, not over ${type}` };
      return { text: tidy(text), law };
    } catch (error) {
      if (error instanceof LawSyntaxError) return { reason: `${what} is not a law of magmas: ${error.message}` };
      throw error;
    }
  };
  for (const binder of binders.slice(2)) {
    if (binder.bracket !== "(" || binder.names.length !== 1) return { reason: `the binder ${binder.bracket}${binder.names.join(" ")} : ${binder.type} is not a hypothesis` };
    const hypothesis = read(binder.type, `the hypothesis ${binder.names[0]}`);
    if ("reason" in hypothesis) return hypothesis;
    hypotheses.push(hypothesis);
  }
  const split = splitArrows(conclusion);
  if (!Array.isArray(split)) return split;
  const pieces = split.map(unwrap);
  for (const piece of pieces.slice(0, -1)) {
    const premise = read(piece, "a premise");
    if ("reason" in premise) return premise;
    hypotheses.push(premise);
  }
  const last = read(pieces[pieces.length - 1] as string, "the conclusion");
  if ("reason" in last) return last;
  return { statement: { kind: "magma", type, sort: (binders[0] as Binder).type, operation: operation[1] as "Mul" | "Magma", hypotheses, conclusion: last } };
}

function recognizeNat(variable: string, rest: Binder[], conclusion: string): Recognition {
  const premises: Array<{ name: string; text: string }> = [];
  for (const binder of rest) {
    if (binder.bracket !== "(" || binder.names.length !== 1) return { reason: `the binder ${binder.bracket}${binder.names.join(" ")} : ${binder.type} is not a hypothesis about ${variable}` };
    if (NAT_TYPES.has(binder.type) || TYPE_SORT.test(binder.type)) return { reason: `${binder.names[0]} is a second variable: only statements about one natural number are tried` };
    premises.push({ name: binder.names[0] as string, text: binder.type });
  }
  for (const { name } of premises) {
    if (name !== "_" && [conclusion, ...premises.map((p) => p.text)].some((text) => occurs(name, text))) return { reason: `the proof ${name} of a hypothesis is used in the statement` };
  }
  const body = premises.length === 0 ? conclusion : [...premises.map((p) => `(${p.text})`), `(${conclusion})`].join(" → ");
  return { statement: { kind: "nat", variable, body } };
}

/** `∀ n : ℕ, P n` with no binder before the colon. */
function recognizeQuantified(conclusion: string): Recognition {
  const quantified = /^∀\s*\(?\s*([\p{L}_][\p{L}\p{N}_'!?]*)\s*:\s*(?:ℕ|Nat)\s*\)?\s*,\s*([\s\S]+)$/u.exec(conclusion);
  if (quantified === null) return { reason: "there is no variable to try the statement on: it has no binder and does not start with '∀ n : ℕ,'" };
  return { statement: { kind: "nat", variable: quantified[1] as string, body: tidy(quantified[2] as string) } };
}

/** The proposition a statement makes about one object: the hypotheses as premises of the conclusion. */
export function statementBody(statement: RecognizedStatement): string {
  if (statement.kind === "nat") return statement.body;
  return [...statement.hypotheses.map((h) => `(${h.text})`), statement.conclusion.text].join(" → ");
}

/**
 * The binders that the statement's objects fill, in signature form: `(M : Type) [Mul M]` or `(n : ℕ)`.
 * A statement over a universe-polymorphic type has `Type*`, so that a lemma stated with the structure
 * (the link of an edge) is as general as the claims, and statements of different sorts have
 * different structures.
 */
export function statementStructure(statement: RecognizedStatement): string {
  if (statement.kind === "nat") return `(${statement.variable} : ℕ)`;
  return `(${statement.type} : ${needsLift(statement) ? "Type*" : "Type"}) [${statement.operation} ${statement.type}]`;
}

/** The statement in signature form, as `ensureClaim` takes it. */
export function statementSignature(statement: RecognizedStatement): string {
  if (statement.kind === "nat") return `${statementStructure(statement)} : ${statement.body}`;
  return `${statementStructure(statement)} ${statement.hypotheses.map((h, i) => `(h${i + 1} : ${h.text})`).join(" ")}${statement.hypotheses.length > 0 ? " " : ""}: ${statement.conclusion.text}`;
}

/**
 * The Lean definition `m11_stmt` that the evaluator instantiates: the statement as a proposition
 * about its structure. It writes `Nat`, which needs no import, where the claim says `ℕ`, and `Type`
 * whatever the claim's sort, since the evaluator instantiates it at `Fin n : Type`.
 */
export function leanDefinition(statement: RecognizedStatement, name = "m11_stmt"): string {
  const structure = statement.kind === "nat" ? `(${statement.variable} : Nat)` : `(${statement.type} : Type) [${statement.operation} ${statement.type}]`;
  return `abbrev ${name} ${structure} : Prop := ${statementBody(statement)}`;
}

/** A magma as a Lean `Mul` (or `Magma`) instance on `Fin n`, from its table. */
export function leanMagmaInstance(magma: Magma): string {
  const n = magma.size;
  return `⟨fun a b => ([${magma.table.join(", ")}] : List (Fin ${n})).getD (a.val * ${n} + b.val) 0⟩`;
}

/** A magma as an instance on `ULift (Fin n)`, the table transported through `down` and `up`: the carrier of a universe-polymorphic claim. */
export function leanLiftedMagmaInstance(magma: Magma): string {
  const n = magma.size;
  return `⟨fun a b => ULift.up (([${magma.table.join(", ")}] : List (Fin ${n})).getD (a.down.val * ${n} + b.down.val) 0)⟩`;
}

/**
 * The arguments of the statement's structure for a magma (`(Fin 3) ⟨...⟩`) or a number (`7`), to
 * follow `@m11_stmt`. With `lift`, the magma is on `ULift (Fin 3)` (`needsLift`).
 */
export function leanArguments(statement: RecognizedStatement, object: Magma | number, options: { lift?: boolean } = {}): string {
  if (statement.kind === "nat") {
    if (typeof object !== "number") throw new TypeError("a statement about a natural number is tried on numbers");
    return String(object);
  }
  if (typeof object === "number") throw new TypeError("a statement about magmas is tried on magmas");
  return options.lift === true ? `(ULift (Fin ${object.size})) ${leanLiftedMagmaInstance(object)}` : `(Fin ${object.size}) ${leanMagmaInstance(object)}`;
}

/** What a magma does to a statement: all its hypotheses hold and its conclusion does (`holds`), a hypothesis fails (`vacuous`), or the conclusion fails with the hypotheses true (`fails`). */
export interface MagmaVerdict {
  verdict: "holds" | "vacuous" | "fails";
  /** For `fails`: the values of the conclusion's variables, in the order of its `law.variables`, that break it. */
  witness?: number[];
}

/** The statement compiled to try it on many magmas. */
export function compileMagmaStatement(statement: MagmaStatement): (magma: Magma) => MagmaVerdict {
  const hypotheses = statement.hypotheses.map((h) => compileLaw(h.law));
  const conclusion = compileLaw(statement.conclusion.law);
  return (magma) => {
    for (const hypothesis of hypotheses) if (hypothesis(magma) !== undefined) return { verdict: "vacuous" };
    const witness = conclusion(magma);
    return witness === undefined ? { verdict: "holds" } : { verdict: "fails", witness };
  };
}

import { nameParts, prepareSketch } from "@seshat/core";

/**
 * What a validation of a claim compares against: a complete Lean file, and the theorem in it that
 * states the claim (or its negation). The validator elaborates it once to record the reference type.
 */
export interface ClaimReference {
  source: string;
  /** The theorem's full name. */
  theorem: string;
}

/** The name of a claim's theorem in its generated file: its id, made a Lean identifier. */
export function claimTheoremName(claimId: string): string {
  const name = claimId.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z]/.test(name) ? name : `c_${name}`;
}

/**
 * The file of a claim in signature form (`(n : ℕ) : n + 0 = n`) under its header:
 * `theorem <name> <statement> := by sorry`, after the header's imports, `open`s and definitions.
 */
export function claimSource(header: string, name: string, statement: string): string {
  const head = header.trim() === "" ? "" : `${header.replace(/\s+$/, "")}\n\n`;
  return `${head}theorem ${name} ${statement.trim()} := by\n  sorry\n`;
}

/** The reference of a claim given by its header and statement. */
export function claimReference(header: string, name: string, statement: string): ClaimReference {
  const source = claimSource(header, name, statement);
  return { source, theorem: prepareSketch(source, name).fullName };
}

/**
 * The reference of a claim's negation: the claim's file with, at its end, a theorem whose type is
 * the negation of the claim's theorem's type. `type_of%` takes the type Lean elaborated, with its
 * binders, section variables and universes, so the negation is that of the whole statement and no
 * binder has to be parsed here. A proof of the negation that used the claim's own theorem (proved by
 * `sorry`) would depend on `sorryAx`, which the validator refuses.
 */
export function negationReference(reference: ClaimReference): ClaimReference {
  const { fullName } = prepareSketch(reference.source, reference.theorem);
  const name = negationName(fullName);
  const source = `${reference.source.replace(/\s+$/, "")}\n\ntheorem ${name} : ¬ (type_of% @${fullName}) := by\n  sorry\n`;
  return { source, theorem: prepareSketch(source, name).fullName };
}

/** The last component of a name, with `_negation` appended (inside the guillemets of a `«»` name). */
function negationName(fullName: string): string {
  const last = nameParts(fullName).at(-1) ?? fullName;
  return last.endsWith("»") ? `${last.slice(0, -1)}_negation»` : `${last}_negation`;
}

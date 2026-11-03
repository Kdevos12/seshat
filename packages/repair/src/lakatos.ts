import type { DataTable } from "@seshat/induction";

/**
 * Lakatos-style repair of a refuted conjecture (line M14), after "Proofs and Refutations". A conjecture has failed on
 * some objects of a data table and holds on others. Two ways of mending it are tried, and both end in a premise
 * (the objects outside a concept) that makes the conjecture a special case of the old one:
 *
 * - exception-barring: a concept that holds of every counterexample and of no object where the conjecture holds
 *   (the exceptions, stated exactly): `n is odd and sigma >= 3`. Nothing that held is lost.
 * - monster-barring: when no concept of the table separates them exactly, a single natural concept that holds of
 *   every counterexample and the fewest others: the counterexamples are not instances of the redefined notion (monsters),
 *   at the price of the objects the concept also bars.
 *
 * The concepts are conjunctions of at most two tests on the table's columns. A repair is a conjecture: it holds on the
 * table, which is all this says, and it goes to the provers as an `open` claim.
 */
export interface Atom {
  column: string;
  op: "is" | "isnt" | "=" | ">=" | "<=";
  value?: number;
}

export interface Concept {
  atoms: Atom[];
  /** In words. */
  text: string;
}

export interface RepairOption {
  kind: "exception_barring" | "monster_barring";
  concept: Concept;
  /** True when the concept holds of no object where the conjecture held. */
  exact: boolean;
  /** Objects where the conjecture held and still does, and those the concept bars though it held. */
  retained: number;
  lost: number;
  /** The counterexamples barred. */
  excluded: number;
  /** The premise `¬ concept` in Lean, when every column it uses has a Lean form. */
  premise?: string;
  /** The repaired statement in signature form, when the premise and the original statement allow it. */
  statement?: string;
  /** The repaired conjecture in words. */
  informal: string;
}

export interface LakatosInput {
  table: DataTable;
  /** One character per object of the table: `1` the conjecture held, `0` it failed, `.` it says nothing there. */
  verdicts: string;
  /** The conjecture in words. */
  informal?: string;
  /** The conjecture in Lean's signature form, to build the repaired statement from. */
  statement?: string;
  /** The name the statement gives the object, which the columns' Lean terms write as `n`. */
  variable?: string;
  /** The most atoms in a concept. Default 2. */
  maxAtoms?: number;
  /** The fewest share of the objects where the conjecture held that a monster-barring may keep. Default 0.5. */
  minRetained?: number;
}

export interface LakatosResult {
  counterexamples: number;
  held: number;
  options: RepairOption[];
  /** Why there is none, when there is none. */
  reason?: string;
}

type Cell = number | boolean | null;

function cellsOf(table: DataTable): Cell[][] {
  return table.columns.map((_, c) => table.rows.map((row) => {
    const v = row[c];
    return typeof v === "number" || typeof v === "boolean" ? v : null;
  }));
}

function atomsOf(table: DataTable, columns: Cell[][]): Array<{ atom: Atom; holds: boolean[] }> {
  const out: Array<{ atom: Atom; holds: boolean[] }> = [];
  table.columns.forEach((col, c) => {
    const values = columns[c] as Cell[];
    const present = values.filter((v): v is number | boolean => v !== null);
    if (present.length === 0) return;
    if (present.every((v) => typeof v === "boolean")) {
      out.push({ atom: { column: col.name, op: "is" }, holds: values.map((v) => v === true) });
      out.push({ atom: { column: col.name, op: "isnt" }, holds: values.map((v) => v === false) });
      return;
    }
    if (!present.every((v) => typeof v === "number")) return;
    const distinct = [...new Set(present as number[])].sort((a, b) => a - b);
    if (distinct.length < 2) return;
    // Equalities for a column with few values, thresholds between neighbouring values for a numeric one.
    if (distinct.length <= 8) for (const v of distinct) out.push({ atom: { column: col.name, op: "=", value: v }, holds: values.map((x) => x === v) });
    const picks = distinct.length <= 14 ? distinct : distinct.filter((_, i) => i % Math.ceil(distinct.length / 14) === 0);
    for (const t of picks) {
      out.push({ atom: { column: col.name, op: ">=", value: t }, holds: values.map((x) => typeof x === "number" && x >= t) });
      out.push({ atom: { column: col.name, op: "<=", value: t }, holds: values.map((x) => typeof x === "number" && x <= t) });
    }
  });
  return out;
}

const atomText = (a: Atom, description: string | undefined): string => {
  const name = description ?? a.column;
  switch (a.op) {
    case "is": return description !== undefined ? `${description}` : `${a.column}`;
    case "isnt": return description !== undefined ? `not (${description})` : `not ${a.column}`;
    case "=": return `${a.column} = ${a.value}`;
    case ">=": return `${name === a.column ? a.column : a.column} >= ${a.value}`;
    default: return `${a.column} <= ${a.value}`;
  }
};

/** The Lean form of an atom, when its column has one. `variable` replaces the `n` of the column's term. */
function atomLean(a: Atom, table: DataTable, variable: string): string | undefined {
  const lean = table.columns.find((c) => c.name === a.column)?.lean;
  if (lean === undefined) return undefined;
  const term = variable === "n" ? lean : lean.replace(/\bn\b/g, variable);
  switch (a.op) {
    case "is": return `(${term})`;
    case "isnt": return `¬ (${term})`;
    case "=": return `(${term}) = ${a.value}`;
    case ">=": return `(${term}) ≥ ${a.value}`;
    default: return `(${term}) ≤ ${a.value}`;
  }
}

/** Splits a signature at its first colon outside brackets: the binders, and the type after the colon. */
export function splitStatement(statement: string): { binders: string; type: string } | undefined {
  let depth = 0;
  for (let i = 0; i < statement.length; i++) {
    const c = statement[i] as string;
    if ("([{⦃".includes(c)) depth++;
    else if (")]}⦄".includes(c)) depth--;
    else if (c === ":" && depth === 0 && statement[i + 1] !== "=") return { binders: statement.slice(0, i).trim(), type: statement.slice(i + 1).trim() };
  }
  return undefined;
}

/** The statement with one more hypothesis, after the binders: `(n : ℕ) (h : P) : Q`. */
export function withPremise(statement: string, premise: string, name = "h_repair"): string | undefined {
  const parts = splitStatement(statement);
  if (parts === undefined || parts.type === "") return undefined;
  return `${parts.binders}${parts.binders === "" ? "" : " "}(${name} : ${premise}) : ${parts.type}`;
}

const combos = <T>(items: readonly T[], size: number): T[][] => (size === 1 ? items.map((x) => [x]) : items.flatMap((x, i) => items.slice(i + 1).map((y) => [x, y])));

/** Finds the repairs of a refuted conjecture on its table. */
export function lakatosRepair(input: LakatosInput): LakatosResult {
  const { table, verdicts } = input;
  if (verdicts.length !== table.rows.length) throw new RangeError(`the verdicts (${verdicts.length}) are not one for each object of the table (${table.rows.length})`);
  const cex = [...verdicts].flatMap((v, i) => (v === "0" ? [i] : []));
  const held = [...verdicts].flatMap((v, i) => (v === "1" ? [i] : []));
  if (cex.length === 0) return { counterexamples: 0, held: held.length, options: [], reason: "the conjecture has no counterexample in the table" };
  if (held.length === 0) return { counterexamples: cex.length, held: 0, options: [], reason: "the conjecture holds on no object of the table: there is nothing to keep" };
  const columns = cellsOf(table);
  const atoms = atomsOf(table, columns);
  const maxAtoms = Math.min(2, input.maxAtoms ?? 2);
  const variable = input.variable ?? "n";
  const describe = (c: Atom[]): Concept => ({
    atoms: c,
    text: c.map((a) => atomText(a, table.columns.find((x) => x.name === a.column)?.description)).join(" and "),
  });
  interface Scored { atoms: Atom[]; collateral: number; covers: boolean }
  const score = (chosen: Array<{ atom: Atom; holds: boolean[] }>): Scored => {
    const inside = (i: number): boolean => chosen.every((a) => a.holds[i] === true);
    return { atoms: chosen.map((a) => a.atom), covers: cex.every(inside), collateral: held.filter(inside).length };
  };
  let exact: Scored | undefined;
  let coarse: Scored | undefined;
  for (let size = 1; size <= maxAtoms; size++) {
    for (const chosen of combos(atoms, size)) {
      // A concept on one column twice, or the same atom's negation, says nothing: the pair must use two columns.
      if (size === 2 && chosen[0]?.atom.column === chosen[1]?.atom.column) continue;
      const s = score(chosen);
      if (!s.covers) continue;
      if (s.collateral === 0 && (exact === undefined || s.atoms.length < exact.atoms.length)) exact = s;
      if (size === 1 && (coarse === undefined || s.collateral < coarse.collateral)) coarse = s;
    }
    if (exact !== undefined) break;
  }
  const options: RepairOption[] = [];
  const build = (kind: RepairOption["kind"], s: Scored): RepairOption => {
    const concept = describe(s.atoms);
    const leans = s.atoms.map((a) => atomLean(a, table, variable));
    const premise = leans.every((l) => l !== undefined) ? `¬ (${(leans as string[]).join(" ∧ ")})` : undefined;
    const statement = premise !== undefined && input.statement !== undefined ? withPremise(input.statement, premise) : undefined;
    return {
      kind,
      concept,
      exact: s.collateral === 0,
      retained: held.length - s.collateral,
      lost: s.collateral,
      excluded: cex.length,
      ...(premise !== undefined ? { premise } : {}),
      ...(statement !== undefined ? { statement } : {}),
      informal: `${input.informal ?? "The conjecture"}, for the objects that do not satisfy: ${concept.text}`,
    };
  };
  if (exact !== undefined) options.push(build("exception_barring", exact));
  if (coarse !== undefined && (exact === undefined || exact.atoms.length > 1)) {
    const o = build("monster_barring", coarse);
    if (o.retained / held.length >= (input.minRetained ?? 0.5)) options.push(o);
  }
  if (options.length === 0) return { counterexamples: cex.length, held: held.length, options, reason: "no concept of at most two tests on the table's columns bars the counterexamples and keeps half of what held" };
  return { counterexamples: cex.length, held: held.length, options };
}

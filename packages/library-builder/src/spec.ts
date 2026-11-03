/**
 * The input of a library build (plan change LC4): what to formalize or port, written by a person or by
 * Seshat, never by the agent. The test lemmas are Seshat's: the gate compares what the agent proved with
 * these statements, as terms, so an agent cannot weaken the specification it is judged by.
 */

export type LibraryJob = "port" | "fill";

/** A test lemma of the spec: a theorem about the new definitions, stated here and proved by the agent ("lemmas as unit tests"). */
export interface TestLemma {
  /** The theorem's name inside the new file, as the agent must write it (the namespace is the file's). */
  name: string;
  /** The binders and statement in signature form, `(n : ℕ) : mulDiv n 1 = n`. */
  statement: string;
}

/** A thing to formalize. */
export interface SpecItem {
  /** The informal statement or definition, one or two sentences. */
  informal: string;
  /** The name the library should give it (a last component; the namespace comes from the domain). */
  expectedName: string;
  kind: "def" | "theorem";
}

export interface LibrarySpec {
  job: LibraryJob;
  /** The domain directory, `Combinatorics`: the agent may add files only under `lean/SeshatLib/<domain>/`. A Lean identifier. */
  domain: string;
  /** Why it is wanted, for the prompt: the gap that triggered it. */
  reason: string;
  /** Imports that the new files may use (`Mathlib`, the environment's packages). */
  imports: string[];
  /** `fill`: the items to formalize. */
  items: SpecItem[];
  /** The test lemmas: at least one for every `def` item. */
  testLemmas: TestLemma[];
  /** `port`: the package to bring to the pinned toolchain, and where it goes. */
  port?: { name: string; git: string; rev: string; libs: string[] };
}

/** What the agent may spend and for how long. */
export interface BuildBudget {
  /** The agent's own cap in US dollars, passed through the command template when it has one. */
  usd?: number;
  /** The wall-clock cap of the agent's run, in seconds. */
  seconds?: number;
}

const IDENTIFIER = /^[A-Z][A-Za-z0-9]*$/;
const LEAN_NAME = /^[A-Za-z_][A-Za-z0-9_']*$/;

/** Everything wrong with a spec: nothing, when the list is empty. */
export function specProblems(spec: LibrarySpec): string[] {
  const problems: string[] = [];
  if (spec.job !== "port" && spec.job !== "fill") problems.push(`the job is ${String(spec.job)}, not port or fill`);
  if (!IDENTIFIER.test(spec.domain)) problems.push(`the domain ${JSON.stringify(spec.domain)} is not a capitalized Lean identifier (it names a directory and a module)`);
  if (spec.reason.trim() === "") problems.push("the spec has no reason");
  for (const i of spec.imports) if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(i)) problems.push(`the import ${JSON.stringify(i)} is not a module name`);
  const names = new Set<string>();
  for (const item of spec.items) {
    if (!LEAN_NAME.test(item.expectedName)) problems.push(`the expected name ${JSON.stringify(item.expectedName)} is not a Lean name`);
    if (names.has(item.expectedName)) problems.push(`the expected name ${item.expectedName} is listed twice`);
    names.add(item.expectedName);
    if (item.informal.trim() === "") problems.push(`${item.expectedName} has no informal statement`);
  }
  const tests = new Set<string>();
  for (const t of spec.testLemmas) {
    if (!LEAN_NAME.test(t.name)) problems.push(`the test lemma name ${JSON.stringify(t.name)} is not a Lean name`);
    if (tests.has(t.name)) problems.push(`the test lemma ${t.name} is listed twice`);
    tests.add(t.name);
    if (t.statement.trim() === "") problems.push(`the test lemma ${t.name} has no statement`);
  }
  if (spec.job === "fill") {
    if (spec.items.length === 0) problems.push("a fill has no item");
    for (const item of spec.items) {
      if (item.kind !== "def") continue;
      const covered = spec.testLemmas.some((t) => new RegExp(`(?<![A-Za-z0-9_'])${item.expectedName}(?![A-Za-z0-9_'])`).test(t.statement));
      if (!covered) problems.push(`the definition ${item.expectedName} has no test lemma that states something about it`);
    }
    if (spec.port !== undefined) problems.push("a fill has no port");
  } else {
    if (spec.port === undefined) problems.push("a port names the package to port");
    else {
      if (!IDENTIFIER.test(spec.port.name)) problems.push(`the package name ${JSON.stringify(spec.port.name)} is not a capitalized Lean identifier`);
      if (spec.port.libs.length === 0) problems.push("a port names the libraries to build");
      if (spec.port.git.trim() === "" || spec.port.rev.trim() === "") problems.push("a port gives the package's git address and rev");
    }
  }
  return problems;
}

/** The directory the agent's files must be under, relative to the repository root. */
export function allowedPrefix(spec: LibrarySpec): string {
  return spec.job === "port" && spec.port !== undefined ? `lean/ports/${spec.port.name}/` : `lean/SeshatLib/${spec.domain}/`;
}

/** The Lean module that a path under `lean/` is: `lean/SeshatLib/Foo/Bar.lean` is `SeshatLib.Foo.Bar`. */
export function moduleOfPath(path: string): string | undefined {
  const m = /^lean\/(.+)\.lean$/.exec(path);
  return m === null ? undefined : (m[1] as string).split("/").join(".");
}

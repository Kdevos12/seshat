import type { Json } from "@seshat/core";
import { CapabilityError, type Registry } from "@seshat/registry";

/**
 * The first cases of a parameterised statement, computed by the harness before the provers start (plan change PA10, documentation/induction.md,
 * "The first cases the harness pushes"). No model is called: the statement's own expression is turned into SageMath code by a small
 * translator, and the compute capability evaluates it for n = 0 or 1 up to a small bound.
 *
 * The shapes handled, and no other (a statement of another shape gets no section, and nothing is said of it):
 * - a statement in signature form with exactly one binder `(n : ℕ)` or `(n : ℤ)` (other binders are hypotheses, so are not read as parameters),
 * - whose conclusion is one equation `LHS = RHS` (no `∀`, `∃`, `∧`, `∨`, `→`, no other relation),
 * - where a side is built from numerals, the parameter, `+ - * ^`, parentheses and type ascriptions, `Nat.choose a b`, `Nat.factorial a`, and
 *   sums or products `∑ i ∈ Finset.range E, body` / `Finset.Icc A B` / `Finset.Ico A B` (`in` for `∈` too) over such expressions,
 * - with a subtraction only when the statement itself says the numbers are integers, rationals or reals (in ℕ it truncates), and no `/` or `%`.
 * A side that cannot be translated is left out of the table; the section needs at least one side that is a sum, a product, a binomial or a
 * factorial (a polynomial identity is the prover's own business).
 */

export interface FirstCasesPlan {
  /** The parameter. */
  variable: string;
  /** The first value of the parameter: 1 when a hypothesis says it is positive, else 0. */
  from: number;
  /** The Sage expression of each side that could be translated. */
  sides: Array<{ label: "lhs" | "rhs"; sage: string }>;
}

/** The bound of the table: how many values of the parameter. */
export const FIRST_CASES_COUNT = 8;
/** The seconds the one compute call may take. */
export const FIRST_CASES_TIMEOUT_SEC = 30;

const COMPUTE_ACTOR = "harness:first_cases";
const OEIS_ACTOR = "harness:first_cases_oeis";
const MIN_TERMS_FOR_OEIS = 5;

// --- Reading the statement -----------------------------------------------------------------------

/** Splits a statement in signature form into its binders (each `(names : type)`) and its conclusion; undefined when it is not of that form. */
function splitSignature(statement: string): { binders: Array<{ names: string[]; type: string }>; conclusion: string } | undefined {
  const text = statement.trim();
  const binders: Array<{ names: string[]; type: string }> = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
    if (text[i] === ":" && text[i + 1] !== "=") return { binders, conclusion: text.slice(i + 1).trim() };
    if (text[i] !== "(" && text[i] !== "{" && text[i] !== "[") return undefined;
    const open = text[i] as string;
    const close = open === "(" ? ")" : open === "{" ? "}" : "]";
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if ("({[".includes(text[j] as string)) depth++;
      else if (")}]".includes(text[j] as string)) {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return undefined;
    const inside = text.slice(i + 1, j);
    if (open === "(") {
      const colon = inside.indexOf(":");
      if (colon < 0) return undefined;
      binders.push({ names: inside.slice(0, colon).trim().split(/\s+/).filter((s) => s !== ""), type: inside.slice(colon + 1).trim() });
    } else binders.push({ names: [], type: inside.trim() });
    i = j + 1;
  }
  return undefined;
}

/** The text split at the depth-0 `=` signs (not part of `≤`, `≥`, `≠`, `:=`, `==`); a single equation gives two parts. */
function splitEquation(text: string): [string, string] | undefined {
  let depth = 0;
  const cuts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if ("({[⟨".includes(c)) depth++;
    else if (")}]⟩".includes(c)) depth--;
    else if (c === "=" && depth === 0 && !/[<>:!=]/.test(text[i - 1] ?? "") && text[i + 1] !== "=" && text[i + 1] !== ">") cuts.push(i);
  }
  if (cuts.length !== 1) return undefined;
  return [text.slice(0, cuts[0]).trim(), text.slice(cuts[0] as number + 1).trim()];
}

// --- Lean to Sage ----------------------------------------------------------------------------------

type Token = string;

function tokenize(text: string): Token[] | undefined {
  const tokens: Token[] = [];
  const re = /\s*(Finset\.[A-Za-z]+|Nat\.[A-Za-z]+|[A-Za-z_][A-Za-z0-9_']*|[0-9]+|[()+\-*^,:↑∑∏∈ℕℤℚℝ]|\bin\b)/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(text);
    if (m === null) return undefined;
    tokens.push(m[1] as string);
    at = re.lastIndex;
  }
  return tokens;
}

class GiveUp extends Error {}

/**
 * The names that reach the Sage code are plain Python identifiers that shadow nothing the generated
 * code uses: the statement's own text never reaches it otherwise (Lean's `x'` is not valid Python).
 */
const RESERVED = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass",
  "raise", "return", "try", "while", "with", "yield", "None", "True", "False",
  "sum", "prod", "range", "binomial", "factorial", "json", "print", "_cell",
]);

export function isSafeName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name);
}

/** A recursive-descent translator of one side of the equation; throws `GiveUp` at anything outside the shapes above. */
class Translator {
  private at = 0;
  usesSumLike = false;
  private readonly tokens: Token[];
  private readonly variable: string;
  private readonly allowSub: boolean;
  constructor(tokens: Token[], variable: string, allowSub: boolean) {
    this.tokens = tokens;
    this.variable = variable;
    this.allowSub = allowSub;
  }

  run(): string {
    const out = this.expr(new Set([this.variable]));
    if (this.at !== this.tokens.length) throw new GiveUp();
    return out;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const t = this.tokens[this.at++];
    if (t === undefined) throw new GiveUp();
    return t;
  }

  private expect(t: Token): void {
    if (this.next() !== t) throw new GiveUp();
  }

  private expr(scope: Set<string>, stopAtComma = false): string {
    let out = this.term(scope, stopAtComma);
    for (let t = this.peek(); t === "+" || t === "-"; t = this.peek()) {
      this.next();
      if (t === "-" && !this.allowSub) throw new GiveUp();
      out = `(${out} ${t} ${this.term(scope, stopAtComma)})`;
    }
    return out;
  }

  private term(scope: Set<string>, stopAtComma: boolean): string {
    let out = this.power(scope, stopAtComma);
    while (this.peek() === "*") {
      this.next();
      out = `(${out} * ${this.power(scope, stopAtComma)})`;
    }
    return out;
  }

  private power(scope: Set<string>, stopAtComma: boolean): string {
    const base = this.unary(scope, stopAtComma);
    if (this.peek() === "^") {
      this.next();
      return `(${base} ** ${this.power(scope, stopAtComma)})`;
    }
    return base;
  }

  private unary(scope: Set<string>, stopAtComma: boolean): string {
    const t = this.peek();
    if (t === "-") {
      this.next();
      return `(-${this.unary(scope, stopAtComma)})`;
    }
    if (t === "↑") {
      this.next();
      return this.unary(scope, stopAtComma);
    }
    if (t === "∑" || t === "∏") return this.bigOperator(scope);
    return this.application(scope);
  }

  private bigOperator(scope: Set<string>): string {
    const symbol = this.next();
    const name = this.next();
    if (!isSafeName(name) || scope.has(name)) throw new GiveUp();
    const sep = this.next();
    if (sep !== "∈" && sep !== "in") throw new GiveUp();
    const range = this.next();
    // The bounds are atoms or parenthesized expressions, so that the comma after them ends the binder.
    const bounds: string[] = [];
    const count = range === "Finset.range" ? 1 : range === "Finset.Icc" || range === "Finset.Ico" ? 2 : 0;
    if (count === 0) throw new GiveUp();
    for (let k = 0; k < count; k++) bounds.push(this.atom(scope));
    this.expect(",");
    const inner = new Set(scope).add(name);
    const body = this.expr(inner);
    this.usesSumLike = true;
    const span = range === "Finset.range" ? `range(${bounds[0]})` : range === "Finset.Icc" ? `range(${bounds[0]}, ${bounds[1]} + 1)` : `range(${bounds[0]}, ${bounds[1]})`;
    return `${symbol === "∑" ? "sum" : "prod"}((${body}) for ${name} in ${span})`;
  }

  private application(scope: Set<string>): string {
    const t = this.peek();
    if (t === "Nat.choose") {
      this.next();
      this.usesSumLike = true;
      return `binomial(${this.atom(scope)}, ${this.atom(scope)})`;
    }
    if (t === "Nat.factorial") {
      this.next();
      this.usesSumLike = true;
      return `factorial(${this.atom(scope)})`;
    }
    return this.atom(scope);
  }

  private atom(scope: Set<string>): string {
    const t = this.next();
    if (/^[0-9]+$/.test(t)) return t;
    if (t === "(") {
      const inside = this.expr(scope);
      if (this.peek() === ":") {
        // A type ascription `(x : ℤ)`: dropped. Any type but a number type is out of the shapes.
        this.next();
        const type = this.next();
        if (!"ℕℤℚℝ".includes(type) || type.length !== 1) throw new GiveUp();
      }
      this.expect(")");
      return inside;
    }
    if (scope.has(t)) return t;
    throw new GiveUp();
  }
}

/** The plan of the first cases of a statement, or undefined when the statement is not of one of the shapes the translator reads. */
export function firstCasesPlan(statement: string): FirstCasesPlan | undefined {
  const sig = splitSignature(statement);
  if (sig === undefined) return undefined;
  const parameters = sig.binders.filter((b) => b.names.length > 0 && /^[ℕℤ]$/.test(b.type));
  if (parameters.length !== 1 || parameters[0]?.names.length !== 1) return undefined;
  const variable = parameters[0].names[0] as string;
  if (!isSafeName(variable)) return undefined;
  if (/[∀∃∧∨→↔¬≤≥<>≠]|<->|->/.test(sig.conclusion) || /\bfun\b|\blet\b/.test(sig.conclusion)) return undefined;
  const sides = splitEquation(sig.conclusion);
  if (sides === undefined) return undefined;
  const allowSub = parameters[0].type === "ℤ" || /[ℤℚℝ]/.test(statement);
  const found: FirstCasesPlan["sides"] = [];
  let interesting = false;
  for (const [label, text] of [["lhs", sides[0]], ["rhs", sides[1]]] as const) {
    const tokens = tokenize(text);
    if (tokens === undefined) continue;
    const translator = new Translator(tokens, variable, allowSub);
    try {
      const sage = translator.run();
      found.push({ label, sage });
      if (translator.usesSumLike) interesting = true;
    } catch (error) {
      if (!(error instanceof GiveUp)) throw error;
    }
  }
  if (!interesting || found.length === 0) return undefined;
  // A hypothesis that says the parameter is positive moves the table's start to 1.
  const positive = new RegExp(`(?:\\b0\\s*<\\s*${variable}\\b|\\b${variable}\\s*>\\s*0\\b|\\b1\\s*≤\\s*${variable}\\b|\\b${variable}\\s*≠\\s*0\\b|\\b${variable}\\s*≥\\s*1\\b)`);
  const hypotheses = sig.binders.filter((b) => !(b.names.length > 0 && /^[ℕℤ]$/.test(b.type))).map((b) => b.type);
  return { variable, from: hypotheses.some((h) => positive.test(h)) ? 1 : 0, sides: found };
}

/** The Sage code of the plan: it prints one JSON list `[[n, lhs, rhs], ...]` with the values as text, `null` for a case that failed. */
export function firstCasesCode(plan: FirstCasesPlan, count = FIRST_CASES_COUNT): string {
  const cell = (sage: string): string => `_cell(lambda ${plan.variable}: ${sage}, ${plan.variable})`;
  return [
    "import json",
    "def _cell(f, n):",
    "    try:",
    "        return str(f(n))",
    "    except Exception:",
    "        return None",
    `print(json.dumps([[${plan.variable}] + [${plan.sides.map((s) => cell(s.sage)).join(", ")}] for ${plan.variable} in range(${plan.from}, ${plan.from + count})]))`,
  ].join("\n");
}

// --- Running it --------------------------------------------------------------------------------------

export interface FirstCasesTable {
  variable: string;
  labels: string[];
  rows: Array<{ n: number; values: Array<string | null> }>;
}

function parseTable(plan: FirstCasesPlan, output: Json): FirstCasesTable | undefined {
  const o = output as { stdout?: unknown; result?: unknown };
  for (const raw of [o.stdout, o.result]) {
    if (typeof raw !== "string") continue;
    const text = raw.trim().replace(/^'([\s\S]*)'$/, "$1");
    const line = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("[")).at(-1);
    if (line === undefined) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!Array.isArray(parsed)) continue;
      const rows = parsed.flatMap((r): FirstCasesTable["rows"] => {
        if (!Array.isArray(r) || typeof r[0] !== "number" || r.length !== plan.sides.length + 1) return [];
        return [{ n: r[0], values: r.slice(1).map((v) => (typeof v === "string" && /^-?[0-9]+(\/[0-9]+)?$/.test(v) ? v : null)) }];
      });
      if (rows.length > 0) return { variable: plan.variable, labels: plan.sides.map((s) => s.label), rows };
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface OeisHit {
  id: string;
  name: string;
}

export interface FirstCasesOptions {
  registry: Registry;
  /** The compute capability (`RunConfig.autoTool`), and the implementation the run pinned for it. */
  capability: string;
  implementation?: string;
  /** The OEIS is asked only when the host offers it, the run is not private, and the person did not refuse third parties. */
  oeis: boolean;
  signal?: AbortSignal;
}

export interface FirstCases {
  table: FirstCasesTable;
  hits: OeisHit[];
  section: { title: string; text: string };
}

export const FIRST_CASES_TITLE = "First cases (computed by the harness)";

/**
 * Computes the first cases of a statement through the compute capability and, if allowed, looks the left side's integer sequence up in the
 * OEIS. Both are capability calls, so they are tool runs of the journal; nothing here touches a claim. Undefined when the statement has no
 * shape the translator reads, or the computation gave nothing: the briefing then has no section.
 */
export async function computeFirstCases(statement: string, o: FirstCasesOptions): Promise<FirstCases | undefined> {
  const plan = firstCasesPlan(statement);
  if (plan === undefined) return undefined;
  const scope = `first-cases:${plan.variable}:${plan.from}`;
  let table: FirstCasesTable | undefined;
  try {
    const result = await o.registry.invoke(o.capability, { code: firstCasesCode(plan), timeout: FIRST_CASES_TIMEOUT_SEC }, {
      actor: COMPUTE_ACTOR,
      scope,
      ...(o.implementation !== undefined ? { implementation: o.implementation } : {}),
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
    });
    table = parseTable(plan, result.output);
  } catch (error) {
    if (!(error instanceof CapabilityError)) throw error;
    return undefined;
  } finally {
    await o.registry.release(scope).catch(() => undefined);
  }
  if (table === undefined) return undefined;
  const hits: OeisHit[] = [];
  const terms = table.rows.map((r) => r.values[0] ?? null);
  if (o.oeis && terms.length >= MIN_TERMS_FOR_OEIS && terms.every((v): v is string => v !== null && /^-?[0-9]+$/.test(v))) {
    try {
      const found = await o.registry.invoke("oeis.search", { terms: terms as string[] }, { actor: OEIS_ACTOR, ...(o.signal !== undefined ? { signal: o.signal } : {}) });
      const results = ((found.output as { results?: Array<{ id: string; name: string }> }).results ?? []).slice(0, 3);
      for (const r of results) hits.push({ id: r.id, name: r.name });
    } catch (error) {
      if (!(error instanceof CapabilityError)) throw error;
    }
  }
  return { table, hits, section: { title: FIRST_CASES_TITLE, text: renderFirstCases(table, hits) } };
}

/** The section the prover reads: the table and the OEIS hits, marked as computed data and not a proof. */
export function renderFirstCases(table: FirstCasesTable, hits: readonly OeisHit[]): string {
  const lines = [
    "Computed by the harness from the statement's own expressions, with no model. It is data, not a proof: it proves nothing and changes no claim; only lean_check decides. Use it to see the pattern, then prove it.",
    "",
    [table.variable, ...table.labels].join(" | "),
    ...table.rows.map((r) => [String(r.n), ...r.values.map((v) => v ?? "(not computed)")].join(" | ")),
  ];
  if (hits.length > 0) {
    lines.push("", `The left side's values match, in the OEIS: ${hits.map((h) => `${h.id} "${h.name}"`).join("; ")}. A match is a hint about a closed form, not a theorem.`);
  }
  return lines.join("\n");
}

import type { LeanChecker, LeanSorry, ValidationReport } from "@seshat/core";
import type { QueryKind } from "./backends.ts";
import { isDeclarationName } from "./names.ts";

/**
 * Search pushed by the harness (plan change CA22). After a Lean check that did not accept the file, the harness itself searches: for each
 * `unknown identifier` or `unknown constant` of the report with the missing name, and for each hole with its goal. Each hit is checked
 * against the run's Lean environment (`#check NAME`, one Lean call for all the candidates of an answer), and what is shown to the model is the
 * name and the signature that Lean printed, never the text the backend returned. The section is bounded and appended to the check's answer.
 */

/** Queries per check, and hits per query. */
export const MAX_QUERIES = 3;
export const MAX_HITS = 5;
/** The characters of the appended section, cut at a hit boundary. */
export const MAX_SECTION_CHARS = 1_200;
/** The characters of one signature, as Lean printed it. */
export const MAX_SIGNATURE_CHARS = 300;
/** The characters of a hole's goal sent as a query: its end, which holds the target. */
export const MAX_GOAL_QUERY_CHARS = 500;
/** The seconds the one Lean call that checks the candidate names may take. */
export const VERIFY_TIMEOUT_SEC = 30;
/** The label of the section in the check's answer. */
export const SECTION_TITLE = "Declarations that exist in this environment";

export interface SearchQuery {
  query: string;
  kind: QueryKind;
  /** What the hits answer, in the section's words. */
  label: string;
}

const UNKNOWN = /unknown (?:identifier|constant) '([^']+)'/;

/** The queries of a check's report, at most `MAX_QUERIES`: the unknown names first, then the holes' goals, each once. */
export function queriesOf(report: Pick<ValidationReport, "messages" | "sorries">): SearchQuery[] {
  const queries: SearchQuery[] = [];
  const seen = new Set<string>();
  const add = (query: SearchQuery) => {
    if (queries.length >= MAX_QUERIES || seen.has(query.query)) return;
    seen.add(query.query);
    queries.push(query);
  };
  for (const message of report.messages) {
    if (message.severity !== "error") continue;
    const name = UNKNOWN.exec(message.text)?.[1];
    if (name !== undefined && isDeclarationName(name)) add({ query: name, kind: "name", label: `unknown name \`${name}\`` });
  }
  report.sorries.forEach((sorry: LeanSorry, k) => {
    const goal = sorry.goal.trim();
    if (goal !== "") add({ query: goal.length > MAX_GOAL_QUERY_CHARS ? goal.slice(-MAX_GOAL_QUERY_CHARS) : goal, kind: "goal", label: `hole ${k + 1}` });
  });
  return queries;
}

/** The imports of a checked file: its leading `import` lines, past blank lines and comments. The names are checked in an environment of these. */
export function headerOf(checked: string): string {
  const imports: string[] = [];
  let comment = false;
  for (const line of checked.split("\n")) {
    const trimmed = line.trim();
    if (comment) {
      comment = !trimmed.includes("-/");
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("--")) continue;
    if (trimmed.startsWith("/-")) {
      comment = !trimmed.includes("-/");
      continue;
    }
    if (!/^import\s+[^\s]+$/.test(trimmed)) break;
    imports.push(trimmed);
  }
  return imports.join("\n");
}

/** What Lean printed for a name, on one line and bounded. */
function signatureOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_SIGNATURE_CHARS ? flat : `${flat.slice(0, MAX_SIGNATURE_CHARS - 1)}…`;
}

/** What a search answered: unverified names, best first, and whether every backend that was to be asked answered (else the answer is not kept). */
export type SearchAnswer = { names: readonly string[]; complete: boolean } | undefined;

export interface PushOptions {
  /** The search; undefined when no backend answered at all. */
  search: (request: { query: string; kind: QueryKind; limit: number }, signal?: AbortSignal) => Promise<SearchAnswer>;
  /** The Lean the run's workbench uses. */
  checker: LeanChecker;
  /**
   * Whether the answer to check number `shownAt` of a session (from 1) has been masked in the history once the session has made `now` checks
   * (`maskedCount` of `mask.ts`). A name shown in a masked answer may be shown again. Absent: nothing is ever masked, and a name is shown once
   * a session.
   */
  masked?: (shownAt: number, now: number) => boolean;
}

/** What one session has been shown: the number of its checks, and for each name the check whose answer showed it. */
interface SessionState {
  checks: number;
  shown: Map<string, number>;
}

const UNKNOWN_NAME = /unknown (?:identifier|constant)/;

/**
 * The push of one run. It keeps, in process, what Lean said of each name, by the imports it was checked under, so that a name is checked
 * once per run (and per environment of imports).
 */
export class LeanSearchPush {
  readonly #search: PushOptions["search"];
  readonly #checker: LeanChecker;
  /** imports -> name -> the signature Lean printed, or null when the environment does not have the name. */
  readonly #known = new Map<string, Map<string, string | null>>();
  /** (kind, query) -> the names a complete search answered, for the run: a query is sent once, and a failure is not kept. */
  readonly #searched = new Map<string, readonly string[]>();
  readonly #masked: PushOptions["masked"];

  constructor(options: PushOptions) {
    this.#search = options.search;
    this.#checker = options.checker;
    this.#masked = options.masked;
  }

  /** The hook of one session: it keeps what the session was shown, so that a name in view is not shown again until its answer is masked. */
  forSession(): (report: ValidationReport, signal?: AbortSignal) => Promise<string | undefined> {
    const state: SessionState = { checks: 0, shown: new Map() };
    return (report, signal) => this.section(report, signal, state);
  }

  /** The text to append to a check's answer, or undefined: no hit, nothing new, a file that was accepted, or a Lean that could not say. */
  async section(report: ValidationReport, signal?: AbortSignal, session: SessionState = { checks: 0, shown: new Map() }): Promise<string | undefined> {
    session.checks += 1;
    if (report.verdict === "valid") return undefined;
    const queries = queriesOf(report);
    if (queries.length === 0) return undefined;
    const inView = (name: string): boolean => {
      const at = session.shown.get(name);
      return at !== undefined && !(this.#masked?.(at, session.checks) ?? false);
    };
    const found = await Promise.all(
      queries.map(async (q) => {
        try {
          return (await this.#names(q, signal)).filter((name) => isDeclarationName(name) && !inView(name)).slice(0, MAX_HITS);
        } catch {
          return [];
        }
      }),
    );
    const candidates = [...new Set(found.flat())];
    if (candidates.length === 0) return undefined;
    const header = headerOf(report.checked);
    const known = this.#known.get(header) ?? new Map<string, string | null>();
    this.#known.set(header, known);
    const unknown = candidates.filter((name) => !known.has(name));
    if (unknown.length > 0 && !(await this.#verify(unknown, header, known, signal))) return undefined;
    const rendered = render(queries, found, known);
    for (const name of rendered.names) session.shown.set(name, session.checks);
    return rendered.text;
  }

  async #names(query: SearchQuery, signal?: AbortSignal): Promise<readonly string[]> {
    const key = `${query.kind}\u0000${query.query}`;
    const kept = this.#searched.get(key);
    if (kept !== undefined) return kept;
    const answer = await this.#search({ query: query.query, kind: query.kind, limit: MAX_HITS }, signal);
    if (answer === undefined) return [];
    if (answer.complete) this.#searched.set(key, answer.names);
    return answer.names;
  }

  /** One Lean call for all the names; false when Lean could not answer, in which case nothing is kept. */
  async #verify(names: readonly string[], header: string, known: Map<string, string | null>, signal?: AbortSignal): Promise<boolean> {
    const lines = header === "" ? 0 : header.split("\n").length;
    const code = `${header === "" ? "" : `${header}\n`}${names.map((name) => `#check ${name}`).join("\n")}\n`;
    let result;
    try {
      [result] = await this.#checker.check([{ id: "lean-search", code }], { timeoutSec: VERIFY_TIMEOUT_SEC, ...(signal !== undefined ? { signal } : {}) });
    } catch {
      return false;
    }
    if (result === undefined || result.error !== undefined || result.status === "timeout" || result.status === "server_error" || result.status === "repl_error") return false;
    names.forEach((name, k) => {
      const line = lines + 1 + k;
      const at = result.messages.filter((m) => m.pos.line === line);
      const printed = at.find((m) => m.severity === "info" && m.text.trim() !== "");
      if (printed !== undefined && !at.some((m) => m.severity === "error")) known.set(name, signatureOf(printed.text));
      // Missing only when Lean says so at that line: a file that failed for another reason says nothing of the name.
      else if (at.some((m) => m.severity === "error" && UNKNOWN_NAME.test(m.text))) known.set(name, null);
    });
    return true;
  }
}

function render(queries: readonly SearchQuery[], found: ReadonlyArray<readonly string[]>, known: ReadonlyMap<string, string | null>): { text: string | undefined; names: string[] } {
  const head = `${SECTION_TITLE} (searched by the harness, each name checked with Lean; the text is Lean's):`;
  const out: string[] = [head];
  let size = head.length;
  const shown = new Set<string>();
  const done = () => ({ text: out.length > 1 ? out.join("\n") : undefined, names: [...shown] });
  for (const [k, query] of queries.entries()) {
    const hits = (found[k] ?? []).filter((name) => !shown.has(name) && typeof known.get(name) === "string");
    const title = `For ${query.label}:`;
    let titled = false;
    for (const name of hits) {
      const signature = known.get(name) as string;
      const cost = (titled ? 0 : title.length + 1) + signature.length + 3;
      if (size + cost > MAX_SECTION_CHARS) return done();
      if (!titled) {
        out.push(title);
        titled = true;
      }
      out.push(`- ${signature}`);
      size += cost;
      shown.add(name);
    }
  }
  return done();
}

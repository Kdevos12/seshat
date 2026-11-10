import type { EventDataMap, HarnessEvent, Journal, LeanChecker } from "@seshat/core";
import { testLemmas, type TestLemmas } from "@seshat/induction";
import {
  DEFAULT_INTAKE_USD,
  HYGIENE_KIND,
  type HygieneData,
  LITERATURE_KIND,
  type IntakeOptions,
  plausibleTest,
  recordHygiene,
  recordIntake,
  runIntake,
  type IntakeResult,
  shown,
  vacuityTest,
} from "@seshat/lit";

/**
 * The intake step of a run (Task 36, documentation/literature.md): before any paid session of a problem, the literature (`lit.search`, a
 * judge call under a cap), and the hygiene of the statement (vacuity, `plausible`, the first cases). Everything is an option, off by
 * default: `harness run` and `harness solve` do what they did unless a run's `intake` or `harness solve --lit` asks.
 */
export interface IntakeConfig {
  /** Search the literature and judge the hits. Needs the third parties' consent (below) and a host that offers `lit.search`. */
  literature?: boolean;
  /** Test the statement itself: the vacuity test, `plausible`, and the test lemmas, each an evidence node. */
  hygiene?: boolean;
  /** The most the judge call may cost per problem, in dollars. Default $0.05. */
  capUsd?: number;
  /**
   * Whether the statement may go to third parties, and how that was decided: `bench` (a bench problem is public: on), `asked` (a person
   * answered the question `harness solve` asks once), `flag` (`--lit`, in a call that cannot ask). Absent: no. Journaled as `intake.consented`.
   * `asked` and `flag` need the run's `user`, who is the person who answered.
   */
  consent?: { allowed: boolean; via: "asked" | "flag" | "bench" };
}

/** The faults of an intake configuration. */
export function checkIntake(intake: IntakeConfig | undefined, o: { user?: string | undefined } = {}): string[] {
  if (intake === undefined) return [];
  const faults: string[] = [];
  if (intake.capUsd !== undefined && !(Number.isFinite(intake.capUsd) && intake.capUsd > 0 && intake.capUsd <= 1)) faults.push(`intake.capUsd must be above 0 and at most 1 dollar, got ${String(intake.capUsd)}`);
  if (intake.consent !== undefined && (intake.consent.via === "asked" || intake.consent.via === "flag") && o.user === undefined) faults.push(`intake.consent ${intake.consent.via} is a person's answer: the run needs its user`);
  if (intake.literature === true && intake.consent === undefined) faults.push("intake.literature sends the statement to third parties: say how the person agreed (intake.consent), or the step is skipped with `not agreed`");
  return faults;
}

export interface IntakeStep {
  /** What ended the turn, in a run with a person; absent when nothing stops. */
  breakpoint?: { reason: "literature" | "vacuous"; detail: string };
  /** The step's literature result, for the log. */
  literature?: IntakeResult;
  hygiene: HygieneData[];
}

export interface IntakeStepOptions {
  config: IntakeConfig | undefined;
  /** True: nothing goes outside, whatever else is asked (`RunConfig.private`). */
  private: boolean;
  journal: Journal;
  memory: IntakeOptions["memory"];
  registry: IntakeOptions["registry"];
  llm: IntakeOptions["llm"];
  price?: IntakeOptions["price"];
  ask?: IntakeOptions["ask"];
  checker?: LeanChecker;
  problemId: string;
  claimId: string;
  statement: string;
  prose?: string;
  /** The declaration's name and the docstring above it. */
  name?: string;
  doc?: string;
  header: string;
  user?: string;
  /** The events of the run before this process: a step or a consent already written is not written again. */
  events?: readonly HarnessEvent[];
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/**
 * The step for one problem. Records `intake.consented` when the literature is asked or `--private` is on, the `hygiene` and `literature`
 * nodes, and `intake.finished`; returns the breakpoint a run with a person should stop at. A failure of a check is a note, never a
 * failure of the problem: only an interruption goes up.
 */
export async function intakeStep(o: IntakeStepOptions): Promise<IntakeStep> {
  const log = o.log ?? (() => {});
  const config = o.config ?? {};
  const out: IntakeStep = { hygiene: [] };
  const wantsLiterature = config.literature === true;
  const consented = (o.events ?? []).some((e) => e.type === "intake.consented" && e.data.problemId === o.problemId);
  if ((wantsLiterature || o.private) && !consented) {
    const consent = config.consent;
    const decision: EventDataMap["intake.consented"] = o.private
      ? { problemId: o.problemId, allowed: false, via: "private" }
      : consent !== undefined
        ? { problemId: o.problemId, allowed: consent.allowed, via: consent.via }
        : { problemId: o.problemId, allowed: false, via: "default" };
    const actor = decision.via === "asked" || decision.via === "flag" ? `human:${o.user as string}` : "orchestrator";
    o.journal.emit("intake.consented", decision, actor);
  }
  const allowed = o.private ? false : wantsLiterature && config.consent?.allowed === true;

  if (config.hygiene === true && o.checker !== undefined) {
    const options = { ...(o.signal !== undefined ? { signal: o.signal } : {}) };
    const record = (data: HygieneData): void => {
      out.hygiene.push(data);
      recordHygiene(o.memory, o.claimId, data);
    };
    for (const run of [
      () => vacuityTest(o.checker as LeanChecker, o.header, o.statement, options),
      () => plausibleTest(o.checker as LeanChecker, o.header, o.statement, options),
      async (): Promise<HygieneData> => {
        const t: TestLemmas = await testLemmas(o.checker as LeanChecker, o.header, o.statement, 10, options);
        return { check: "test_lemmas", result: t.result, detail: t.result === "failed" ? `Lean's decide refutes the statement on case ${t.failedAt}` : (t.note ?? `${t.tried} case(s) tried`) };
      },
    ]) {
      try {
        record(await run());
      } catch (error) {
        if (o.signal?.aborted) throw error;
        log(`intake: a check of the statement could not be run: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const capUsd = config.capUsd ?? DEFAULT_INTAKE_USD;
  if (wantsLiterature) {
    const literature: IntakeResult = allowed
      ? await runIntake({
          problemId: o.problemId,
          claimId: o.claimId,
          statement: o.statement,
          ...(o.prose !== undefined ? { prose: o.prose } : {}),
          ...(o.name !== undefined ? { name: o.name } : {}),
          ...(o.doc !== undefined ? { doc: o.doc } : {}),
          registry: o.registry,
          memory: o.memory,
          llm: o.llm,
          capUsd,
          ...(o.price !== undefined ? { price: o.price } : {}),
          ...(o.ask !== undefined ? { ask: o.ask } : {}),
          ...(o.signal !== undefined ? { signal: o.signal } : {}),
          log,
        })
      : { state: "skipped", reason: o.private ? "private: nothing is sent outside" : "not agreed: the statement was not allowed to go to third parties", queries: [], hits: 0, kept: [], dropped: [], settled: 0, usd: 0 };
    recordIntake(o.journal, { problemId: o.problemId, claimId: o.claimId, capUsd }, literature);
    out.literature = literature;
    if (literature.reason !== undefined) log(`intake: the literature step was skipped (${literature.reason})`);
    if (literature.settled > 0) {
      const best = literature.kept.find((k) => k.settled);
      out.breakpoint = { reason: "literature", detail: `the literature may have settled this: ${literature.settled} source(s) judged to ${best?.verdict ?? "settle"} it, such as "${shown(best?.title ?? "", 100)}" (${shown(best?.url ?? "", 160)})` };
    }
  } else if (config.hygiene === true) {
    // Hygiene alone is a step too: its record says it ran, and what it cost (nothing).
    recordIntake(o.journal, { problemId: o.problemId, claimId: o.claimId, capUsd }, { state: "done", queries: [], hits: 0, kept: [], dropped: [], settled: 0, usd: 0 });
  }
  const vacuous = out.hygiene.find((h) => h.check === "vacuity" && h.result === "vacuous");
  if (vacuous !== undefined && out.breakpoint === undefined) out.breakpoint = { reason: "vacuous", detail: "Lean proved that no values satisfy the statement's hypotheses: the statement is vacuous as written" };
  return out;
}

// --- The report ----------------------------------------------------------------------------------

/** What the report and RESULT.md say of a problem's intake, read from the journal alone. */
export interface IntakeLine {
  problemId: string;
  state: "done" | "skipped";
  reason?: string;
  consent?: string;
  queries: number;
  hits: number;
  kept: number;
  dropped: Array<{ title: string; url: string; why: string }>;
  usd: number;
  /** The kept hits that are not `unrelated`. */
  sources: Array<{ backend: string; title: string; url: string; verdict: string; quote: string; settled: boolean }>;
  hygiene: Array<{ check: string; result: string; detail?: string }>;
}

const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export function intakeLines(events: readonly HarnessEvent[]): IntakeLine[] {
  const nodes = events.flatMap((e) => (e.type === "node.recorded" && (e.data.kind === LITERATURE_KIND || e.data.kind === HYGIENE_KIND) ? [e.data] : []));
  const consents = new Map<string, string>();
  for (const e of events) if (e.type === "intake.consented") consents.set(e.data.problemId, `${e.data.allowed ? "allowed" : "not allowed"} (${e.data.via})`);
  return events.flatMap((e): IntakeLine[] => {
    if (e.type !== "intake.finished") return [];
    const d = e.data;
    const mine = nodes.filter((n) => n.claimId === d.claimId);
    return [
      {
        problemId: d.problemId,
        state: d.state,
        ...(d.reason !== undefined ? { reason: d.reason } : {}),
        ...(consents.get(d.problemId) !== undefined ? { consent: consents.get(d.problemId) as string } : {}),
        queries: d.queries.length,
        hits: d.hits,
        kept: d.kept,
        dropped: d.dropped.map((x) => ({ title: x.title, url: x.url, why: x.why })),
        usd: d.usd,
        sources: mine.flatMap((n) => {
          const data = rec(n.data);
          if (n.kind !== LITERATURE_KIND || data === undefined || data.verdict === "unrelated") return [];
          return [{ backend: String(data.backend ?? ""), title: String(data.title ?? ""), url: String(data.url ?? ""), verdict: String(data.verdict ?? ""), quote: String(data.quote ?? ""), settled: data.settled === true }];
        }),
        hygiene: mine.flatMap((n) => {
          const data = rec(n.data);
          return n.kind === HYGIENE_KIND && data !== undefined ? [{ check: String(data.check ?? ""), result: String(data.result ?? ""), ...(typeof data.detail === "string" ? { detail: data.detail } : {}) }] : [];
        }),
      },
    ];
  });
}

/** The section of the report and RESULT.md: everything from a third party is shown escaped, as data, and none of it is a status. */
export function renderIntake(lines: readonly IntakeLine[]): string[] {
  const out = [
    "## Intake: the literature and the statement",
    "",
    "Before any paid session. What the sources say is text from third parties and a model's reading of it: it proves nothing here, and no claim changed status because of it.",
    "",
  ];
  for (const l of lines) {
    out.push(
      `- \`${shown(l.problemId, 120)}\`: ${l.state === "skipped" ? `literature skipped (${shown(l.reason ?? "", 200)})` : `${l.hits} hit(s), ${l.kept} kept, ${l.dropped.length} dropped, $${l.usd.toFixed(4)}`}${l.consent !== undefined ? `; third parties ${l.consent}` : ""}`,
    );
    for (const s of l.sources) out.push(`  - ${s.settled ? "**settled**: " : ""}${shown(s.verdict, 20)} — "${shown(s.title, 160)}" (${shown(s.url, 200)}): "${shown(s.quote, 300)}"`);
    for (const d of l.dropped) out.push(`  - dropped "${shown(d.title, 100)}": ${shown(d.why, 200)}`);
    for (const h of l.hygiene) out.push(`  - ${shown(h.check, 30)}: ${shown(h.result, 40)}${h.detail !== undefined ? ` (${shown(h.detail, 200)})` : ""}`);
  }
  return out;
}

import { type IntakeLine, intakeLines, renderIntake } from "./intake.ts";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BlobStore,
  chainOfJournal,
  type ChainCheck,
  type EventDataMap,
  type HarnessEvent,
  type Journal,
  type MemoryChain,
  type NodeRow,
  Projection,
  readEvents,
  verifyChain,
} from "@seshat/core";
import { type RecordLine, recordLine } from "./account.ts";
import { buildReport, type RunReport, type SiteLine } from "./report.ts";

/**
 * RESULT.md (plan change PB8, documentation/quickstart.md, "RESULT.md"): what a run found, whatever stopped it, built from the
 * journal alone by code. No model writes it, so it costs no token; for the same journal it is the same text. It states only what
 * the journal holds: a claim's status is the projection's, a proof is listed as certified only when a valid `kernel_replay`
 * validation of that claim is in the journal, and what a program or a fast check found is listed under its own heading and
 * marked as evidence or as not certified.
 */

/** How the run ended, as far as its journal says. */
export type RunState = "finished" | "paused" | "cut";

/** What a person reads of one problem: the journal's outcome, or the claim's status when the problem has no outcome yet. */
export interface ProblemStanding {
  problemId: string;
  target: string;
  claimId: string;
  claimStatus: string;
  /** The `problem.finished` outcome, absent while the problem has none. */
  outcome?: string;
  reason?: string;
  /** True when a valid `kernel_replay` validation of this claim is in this run's journal. */
  certified: boolean;
}

/** A Lean file the journal holds, with the validation behind it. */
export interface ProofFile {
  claimId: string;
  statement: string;
  validationId: string;
  method: "repl" | "kernel_replay";
  negation: boolean;
  axioms: string[];
  /** The attempt the proof came from, and its prover. */
  attemptId?: string;
  prover?: string;
  problemId?: string;
  /** The whole Lean file as it was checked; absent when its blob is not in the run directory. */
  file?: string;
}

/** A prover's last file that still has holes, with what Lean said of it. */
export interface PartialSketch {
  claimId: string;
  statement: string;
  attemptId: string;
  prover: string;
  holes: number;
  aux: string;
  proof: string;
  lastCheck?: string;
}

/** What failed, by strategy: attempts and how they ended, and how the last one failed. */
export interface FailureLine {
  claimId: string;
  strategy: string;
  attempts: number;
  outcomes: Record<string, number>;
  lastFailure?: string;
}

export interface Result {
  version: 1;
  runId: string;
  /** The journal the result is built from: its events and its last hash. */
  journal: { events: number; head: string; chain: "verified" | string };
  state: RunState;
  /** Why the run stopped, in the journal's words; absent while the journal has no end. */
  stop?: { reason: string; detail: string };
  /** Seconds between the first and the last event of the journal. */
  seconds: number;
  problems: ProblemStanding[];
  claims: { total: number; byStatus: Record<string, number>; listed: Array<{ id: string; status: string; statement: string }>; omitted: number };
  certified: ProofFile[];
  /** Claims `proved` or `refuted` in the memory this run started on, not by this run. */
  carried: Array<{ claimId: string; status: string; statement: string }>;
  /** Proofs that passed the fast check and are not certified. */
  candidates: ProofFile[];
  partial: PartialSketch[];
  counterexamples: RecordLine[];
  evidence: RecordLine[];
  failed: FailureLine[];
  /** Model calls and tool runs that failed, in words. */
  errors: string[];
  /** What the certifier was: `null` for none, with the reason when the run recorded one. */
  certifier: { name: string | null; unavailable?: string };
  /** The intake step of each problem that had one: the literature and the statement's hygiene, as data (Task 36). */
  intake?: IntakeLine[];
  /** The signature of a prose statement (`harness solve`), when the run has one. */
  signature?: EventDataMap["statement.signed"] & { by: string; seq: number };
  spend: { usd: number; inputTokens: number; outputTokens: number; budgetUsd?: number; sites: SiteLine[]; rungs?: Record<string, number>; formalizationUsd?: number };
  /** The configuration in words that matter to a reader. */
  model?: string;
  /** The command that continues the run, or why none is needed. */
  resume: string;
}

export interface ResultOptions {
  /** Text of a blob, by hash. */
  blob?: (hash: string) => string | undefined;
  /** The earlier journals the run started on. */
  chain?: MemoryChain | { unreadable: string };
  /** The command that resumes the run (`resumeCommand`). */
  resume?: string;
  /** The hash chain's check, when the caller made it. */
  chainCheck?: ChainCheck;
}

const MAX_LISTED_CLAIMS = 40;
const MAX_PARTIAL = 6;
const MAX_FAILED = 12;
const MAX_RECORDS = 12;
const MAX_FILE_CHARS = 20_000;

/** Node kinds a program writes as a finding with a model or an instance: a refutation attempt, not a Lean-checked refutation. */
const COUNTEREXAMPLE_KINDS = ["counter_model", "counterexample", "refuted_hypothesis", "graph_hit"];
/** Node kinds that are evidence or a lead: a tool's output, a fingerprint, a guess. None of them is a proof. */
const EVIDENCE_KINDS = ["fingerprint", "identification", "battery", "integer_relation", "recurrence", "search_result", "graph_search", "conjecture", "obstruction", "datatable"];

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function money(usd: number): string {
  return usd < 0.1 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** The stop reasons a run records, in a person's words. */
export function stopWords(reason: string): string {
  const words: Record<string, string> = {
    budget_exhausted: "the dollar budget ran out",
    aborted: "the run was stopped (Ctrl-C, a kill, or a problem cut before its end)",
    errors: "three problems in a row ended with a harness error, or the run crashed",
    lean_unavailable: "the Lean server could not be reached",
    lean_environment: "the Lean server cannot import the libraries of the run's environment",
    tokens: "the turn's token limit was reached",
    usd: "the turn's dollar limit was reached",
    minutes: "the turn's time limit was reached",
    impasse: "the run reached an impasse (many attempts, little chance left)",
    settled: "a problem was settled by a certified result",
    disagreement: "two informal validators disagree",
    finished: "every problem has an outcome",
    interrupted: "the process of the turn ended before the turn did",
  };
  return words[reason] ?? reason;
}

function projectionOf(events: readonly HarnessEvent[], chain: ResultOptions["chain"]): Projection {
  const p = Projection.inMemory();
  if (chain !== undefined && !("unreadable" in chain)) p.attachChain(chain);
  for (const event of events) p.apply(event);
  return p;
}

function regionsOf(text: string | undefined): { aux: string; proof: string } | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as { aux?: unknown; proof?: unknown };
    return typeof parsed.aux === "string" && typeof parsed.proof === "string" ? { aux: parsed.aux, proof: parsed.proof } : undefined;
  } catch {
    return undefined;
  }
}

/** The holes of a region text: a `sorry` that is not part of a longer word. */
function holesIn(text: string): number {
  return (text.match(/(?<![\p{L}\p{N}_'.!?])sorry(?![\p{L}\p{N}_'!?])/gu) ?? []).length;
}

/**
 * Builds the result of a run from the events of its journal. Pure: the same events, blobs and options give the same result. It reads
 * a prefix of a journal as well as a whole one, which is how a killed run is read.
 */
export function buildResult(events: readonly HarnessEvent[], options: ResultOptions = {}): Result {
  const started = events.find((e) => e.type === "run.started");
  if (started === undefined || started.type !== "run.started") throw new Error("the journal has no run.started event");
  const report: RunReport = buildReport(events);
  const p = projectionOf(events, options.chain);
  try {
    const blob = options.blob ?? (() => undefined);
    const last = events.at(-1) as HarnessEvent;
    const check = options.chainCheck ?? verifyChain(events);

    // How the run ended.
    const lastResumed = events.findLastIndex((e) => e.type === "run.resumed");
    const lastFinished = events.findLastIndex((e) => e.type === "run.finished");
    const lastTurnEnd = events.findLastIndex((e) => e.type === "turn.ended");
    const turnEnd = lastTurnEnd > lastResumed ? (events[lastTurnEnd] as Extract<HarnessEvent, { type: "turn.ended" }>) : undefined;
    let state: RunState = "cut";
    let stop: Result["stop"];
    if (lastFinished > lastResumed) {
      state = "finished";
      const finished = events[lastFinished] as Extract<HarnessEvent, { type: "run.finished" }>;
      const reason = finished.data.stopped ?? "finished";
      stop = { reason, detail: stopWords(reason) };
    } else if (turnEnd !== undefined && turnEnd.data.reason !== "interrupted") {
      state = turnEnd.data.waiting.length > 0 ? "paused" : "finished";
      stop = { reason: turnEnd.data.reason, detail: `${stopWords(turnEnd.data.reason)} (${turnEnd.data.detail})` };
    }

    // Problems and the claims they are about.
    const finishedOf = new Map<string, Extract<HarnessEvent, { type: "problem.finished" }>["data"]>();
    for (const e of events) if (e.type === "problem.finished") finishedOf.set(e.data.problemId, e.data);
    // A proved claim is certified by a proof of the claim, a refuted one by a proof of its negation: a valid replay of the other kind does not count.
    const certifiedFor = (claimId: string): boolean => {
      const status = p.claim(claimId)?.status;
      return p.validations(claimId).some((v) => v.method === "kernel_replay" && v.verdict === "valid" && v.negation === (status === "refuted"));
    };
    const problems: ProblemStanding[] = p.problems().map((row) => {
      const done = finishedOf.get(row.problem_id);
      return {
        problemId: row.problem_id,
        target: row.target,
        claimId: row.claim_id,
        claimStatus: p.claim(row.claim_id)?.status ?? "unknown",
        ...(done !== undefined ? { outcome: done.outcome } : {}),
        ...(done?.reason !== undefined ? { reason: clip(done.reason, 300) } : {}),
        certified: certifiedFor(row.claim_id),
      };
    });

    // Claims by status.
    const all = p.claimsWhere();
    const byStatus: Record<string, number> = {};
    for (const c of all) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    const problemClaims = new Set(problems.map((x) => x.claimId));
    const interesting = all.filter((c) => c.status !== "open" || problemClaims.has(c.claim_id));
    const listed = interesting.slice(0, MAX_LISTED_CLAIMS).map((c) => ({ id: c.claim_id, status: c.status, statement: clip(c.statement, 200) }));

    // The attempts that made a check, by the validation that recorded it.
    const attemptOf = (id: string | null) => (id === null ? undefined : p.attempt(id));
    const fileOf = (hash: string): string | undefined => {
      const text = blob(hash);
      return text === undefined ? undefined : text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n-- [cut: the file is ${text.length} characters, the blob holds all of it]` : text;
    };
    const proofFile = (claimId: string, v: ReturnType<Projection["validations"]>[number]): ProofFile => {
      const attempt = attemptOf(v.attempt_id);
      const file = fileOf(v.submission_hash);
      return {
        claimId,
        statement: clip(p.claim(claimId)?.statement ?? "", 300),
        validationId: v.validation_id,
        method: v.method,
        negation: v.negation,
        axioms: v.axioms,
        ...(attempt !== undefined ? { attemptId: attempt.attempt_id, prover: attempt.prover } : {}),
        ...(v.problem_id !== null ? { problemId: v.problem_id } : {}),
        ...(file !== undefined ? { file } : {}),
      };
    };
    const certified: ProofFile[] = [];
    const candidates: ProofFile[] = [];
    const carried: Result["carried"] = [];
    for (const c of all) {
      const own = p.validations(c.claim_id);
      if (c.status === "proved" || c.status === "refuted") {
        // The validation that earned the status: the last valid kernel replay, of the claim for `proved` and of its negation for `refuted`.
        const earned = own.findLast((v) => v.method === "kernel_replay" && v.verdict === "valid" && v.negation === (c.status === "refuted"));
        if (earned !== undefined) certified.push(proofFile(c.claim_id, earned));
        else carried.push({ claimId: c.claim_id, status: c.status, statement: clip(c.statement, 200) });
      } else if (c.status === "computed") {
        const fast = own.findLast((v) => v.method === "repl" && v.verdict === "valid" && !v.negation);
        if (fast !== undefined) candidates.push(proofFile(c.claim_id, fast));
      }
    }

    // Partial sketches: the prover's last file that still has a hole, the fewest holes first.
    const partialBy = new Map<string, PartialSketch>();
    for (const e of events) {
      if (e.type !== "attempt.finished" || e.data.outcome === "valid" || e.data.carry === undefined) continue;
      const attempt = p.attempt(e.data.attemptId);
      if (attempt === undefined) continue;
      const claim = p.claim(attempt.claim_id);
      if (claim === undefined || claim.status === "proved" || claim.status === "refuted") continue;
      const regions = regionsOf(blob(e.data.carry.regions));
      if (regions === undefined) continue;
      const holes = holesIn(regions.aux) + holesIn(regions.proof);
      if (holes === 0) continue;
      const lastCheck = e.data.carry.lastCheck === undefined ? undefined : blob(e.data.carry.lastCheck);
      const known = partialBy.get(attempt.claim_id);
      if (known !== undefined && known.holes < holes) continue;
      partialBy.set(attempt.claim_id, {
        claimId: attempt.claim_id,
        statement: clip(claim.statement, 300),
        attemptId: attempt.attempt_id,
        prover: attempt.prover,
        holes,
        aux: regions.aux,
        proof: regions.proof,
        ...(lastCheck !== undefined ? { lastCheck: lastCheck.length > 1500 ? `${lastCheck.slice(0, 1500)}\n[cut]` : lastCheck } : {}),
      });
    }
    const partial = [...partialBy.values()].sort((a, b) => a.holes - b.holes).slice(0, MAX_PARTIAL);

    // Records of the memory.
    const kinds = [...new Set(events.flatMap((e) => (e.type === "node.recorded" ? [e.data.kind] : [])))].sort();
    const nodesOf = (wanted: readonly string[]): NodeRow[] => kinds.filter((k) => wanted.includes(k)).flatMap((k) => p.nodes(k));
    const counterexamples = nodesOf(COUNTEREXAMPLE_KINDS).slice(0, MAX_RECORDS).map(recordLine);
    const evidence = nodesOf(EVIDENCE_KINDS).slice(0, MAX_RECORDS).map(recordLine);

    // What was tried and failed, by claim and strategy.
    const tried = new Map<string, FailureLine>();
    for (const e of events) {
      if (e.type !== "attempt.finished") continue;
      const attempt = p.attempt(e.data.attemptId);
      if (attempt === undefined) continue;
      const strategy = e.data.strategy ?? e.data.declaredStrategy ?? attempt.strategy ?? "(no strategy named)";
      const key = `${attempt.claim_id}\u0000${strategy}`;
      const line = tried.get(key) ?? { claimId: attempt.claim_id, strategy, attempts: 0, outcomes: {} };
      line.attempts += 1;
      line.outcomes[e.data.outcome] = (line.outcomes[e.data.outcome] ?? 0) + 1;
      if (e.data.outcome !== "valid") {
        const why = [e.data.failureClass, e.data.failureDetail ?? e.data.error].filter((x): x is string => x !== undefined && x !== "").join("; ");
        if (why !== "") line.lastFailure = clip(why, 220);
      }
      tried.set(key, line);
    }
    const failed = [...tried.values()].filter((l) => (l.outcomes.valid ?? 0) < l.attempts).sort((a, b) => b.attempts - a.attempts).slice(0, MAX_FAILED);

    // Failures that are not a prover's: a model call or a tool that errored.
    const errors: string[] = [];
    const callErrors = events.flatMap((e) => (e.type === "model_call.finished" && e.data.outcome !== "ok" ? [e.data] : []));
    if (callErrors.length > 0) errors.push(`${callErrors.length} one-shot model call(s) failed; the last: ${clip(callErrors.at(-1)?.error ?? callErrors.at(-1)?.outcome ?? "", 200)}`);
    const sessionErrors = events.flatMap((e) => (e.type === "attempt.finished" && e.data.outcome === "error" ? [e.data] : []));
    if (sessionErrors.length > 0) errors.push(`${sessionErrors.length} session(s) ended with an error; the last: ${clip(sessionErrors.at(-1)?.error ?? "", 200)}`);
    const toolErrors = report.tools === undefined ? 0 : Object.values(report.tools).reduce((n, t) => n + (t.outcomes.error ?? 0) + (t.outcomes.timeout ?? 0), 0);
    if (toolErrors > 0) errors.push(`${toolErrors} tool call(s) of the provers errored or timed out`);
    for (const x of problems) if (x.outcome === "error" || x.outcome === "skipped") errors.push(`${x.target}: ${x.outcome}${x.reason !== undefined ? ` (${x.reason})` : ""}`);

    // The certifier and the signature.
    const config = started.data.config as { certifier?: string | null; certifierUnavailable?: string; budget?: { runUsd?: number | null }; model?: string } | null;
    const certifier: Result["certifier"] = { name: config?.certifier ?? null, ...(config?.certifierUnavailable !== undefined ? { unavailable: config.certifierUnavailable } : {}) };
    const signedEvent = events.find((e) => e.type === "statement.signed");
    const signature = signedEvent?.type === "statement.signed" ? { ...signedEvent.data, by: signedEvent.actor.replace(/^human:/, ""), seq: signedEvent.seq } : undefined;
    const rungs = Object.values(report.problems).some((x) => x.ladder !== undefined)
      ? report.problems.reduce<Record<string, number>>((all, x) => {
          for (const [rung, usd] of Object.entries(x.ladder?.usdByRung ?? {})) all[rung] = (all[rung] ?? 0) + usd;
          return all;
        }, {})
      : undefined;

    const seconds = Math.max(0, (Date.parse(last.ts) - Date.parse((events[0] as HarnessEvent).ts)) / 1000);
    return {
      version: 1,
      runId: started.data.runId,
      journal: { events: events.length, head: last.hash, chain: check.ok ? "verified" : `does not verify at event ${check.seq}: ${check.reason}` },
      state,
      ...(stop !== undefined ? { stop } : {}),
      seconds,
      problems,
      claims: { total: all.length, byStatus, listed, omitted: Math.max(0, interesting.length - MAX_LISTED_CLAIMS) },
      certified,
      carried,
      candidates,
      partial,
      counterexamples,
      evidence,
      failed,
      errors,
      certifier,
      ...(signature !== undefined ? { signature } : {}),
      ...(intakeLines(events).length > 0 ? { intake: intakeLines(events) } : {}),
      spend: {
        usd: report.usd,
        inputTokens: report.inputTokens,
        outputTokens: report.outputTokens,
        ...(typeof config?.budget?.runUsd === "number" ? { budgetUsd: config.budget.runUsd } : {}),
        sites: report.sites,
        ...(rungs !== undefined ? { rungs } : {}),
        ...(signature?.formalization !== undefined ? { formalizationUsd: signature.formalization.usd } : {}),
      },
      ...(config?.model !== undefined ? { model: config.model } : {}),
      resume: options.resume ?? resumeCommand(undefined, state),
    };
  } finally {
    p.close();
  }
}

/**
 * The command that continues a run. A run begun by `harness solve` or `harness run` leaves `resume.json` in its directory
 * (the checkout, the bench file and the host it began with); without it the command names a placeholder.
 */
export function resumeCommand(dir: string | undefined, state: RunState): string {
  if (state === "finished") return "Nothing to resume: the run is finished. Start a new one, or use --memory-from to carry what this one learned.";
  const where = dir ?? "RUN_DIR";
  const file = dir === undefined ? undefined : join(dir, "resume.json");
  if (file !== undefined && existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { checkout?: unknown; bench?: unknown; host?: unknown };
      if (typeof saved.checkout === "string") {
        const bench = typeof saved.bench === "string" ? ` --bench ${shellQuote(saved.bench)}` : "";
        const host = typeof saved.host === "string" ? ` --host ${shellQuote(saved.host)}` : "";
        return `pnpm harness resume ${shellQuote(where)} --checkout ${shellQuote(saved.checkout)}${bench}${host}`;
      }
    } catch {
      // A damaged file is the same as none.
    }
  }
  return `pnpm harness resume ${where} --checkout CHECKOUT [--bench FILE] [--host HOST] (the checkout, bench and host the run began with; resume.json is missing)`;
}

// ---------------------------------------------------------------------------------------------
// The text.

/** Plain text from the journal, made inert in Markdown: no code span, link, image, HTML or table cell can start from it, and it stays on one line. */
export function md(text: string): string {
  return text.replace(/\r?\n|\r/g, " ").replace(/[\\`<>[\]!|]/g, (c) => `\\${c}`);
}

/** Journal text as an inline code span that the text cannot close. */
export function code(text: string): string {
  const flat = text.replace(/\r?\n|\r/g, " ");
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((m) => m.length));
  const tick = "`".repeat(longest + 1);
  const pad = /^[`\s]|[`\s]$/.test(flat) ? " " : "";
  return `${tick}${pad}${flat}${pad}${tick}`;
}

/** A value of a shell command, quoted when it has anything but safe characters. */
export function shellQuote(value: string): string {
  if (/[\0\n\r`]/.test(value)) throw new Error("a value with a newline or a backtick cannot be put in a command");
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function fenced(text: string, language = "lean"): string[] {
  // A fence longer than any run of backticks in the text cannot be closed by the text.
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  return [`${fence}${language}`, text.replace(/\n+$/, ""), fence];
}

function table(head: string[], rows: string[][]): string[] {
  const cell = (x: string) => md(x);
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

function counts(map: Record<string, number>): string {
  const entries = Object.entries(map);
  return entries.length === 0 ? "none" : entries.map(([k, n]) => `${n} ${k}`).join(", ");
}

function headline(r: Result): string[] {
  if (r.problems.length === 0) return ["**No problem was registered.** The run ended before it began on one."];
  return r.problems.map((x) => {
    const target = code(x.target);
    if (x.claimStatus === "proved" && x.certified) return `**Proved.** The Lean kernel certified a proof of ${target} (claim ${x.claimId}).`;
    if (x.claimStatus === "refuted" && x.certified) return `**Refuted.** The Lean kernel certified a proof of the negation of ${target} (claim ${x.claimId}).`;
    if (x.claimStatus === "proved" || x.claimStatus === "refuted") return `**${x.claimStatus === "proved" ? "Proved" : "Refuted"} by the memory this run started on**, not by this run: ${target} (claim ${x.claimId}).`;
    if (x.claimStatus === "computed") {
      return `**Not proved: a candidate.** A proof of ${target} passed the fast Lean check and was not certified${r.certifier.name === null || r.certifier.unavailable !== undefined ? " (there was no certifier; see below)" : ""}. The claim's status is \`computed\`.`;
    }
    const why = x.reason !== undefined ? ` ${md(x.reason)}` : "";
    return `**Not solved yet.** ${target} is \`${x.claimStatus}\`${x.outcome !== undefined ? `; the problem ended as ${x.outcome}.${why}` : "; the problem has no outcome in the journal."}`;
  });
}

/** Renders a result as Markdown. */
export function renderResult(r: Result): string {
  const lines: string[] = ["# Result", ""];
  if (r.journal.chain !== "verified") {
    lines.push(`> **Warning: the journal's hash chain ${r.journal.chain}.** Nothing below can be trusted until the journal is restored.`, "");
  }
  lines.push(...headline(r).flatMap((l) => [l, ""]));
  // Where it stands.
  const when = r.state === "finished" ? "The run finished" : r.state === "paused" ? "The run is paused and waits for you" : "The journal has no end";
  lines.push(
    "## Where the run stands",
    "",
    `- ${when}${r.stop !== undefined ? `: ${md(r.stop.detail)}` : r.state === "cut" ? ": the process was killed or crashed, or it is still running. What follows is what the journal holds up to its last event." : ""}.`,
    `- Spent ${money(r.spend.usd)}${r.spend.budgetUsd !== undefined ? ` of ${money(r.spend.budgetUsd)}` : ""}, ${r.spend.inputTokens} input and ${r.spend.outputTokens} output tokens, in ${Math.round(r.seconds)} s${r.model !== undefined ? `, with ${md(r.model)}` : ""}.`,
  );
  if (r.spend.formalizationUsd !== undefined) lines.push(`- Formalizing your words cost ${money(r.spend.formalizationUsd)} more, before the run began (it is in the signature event, not in the figures above).`);
  lines.push(`- The journal: ${r.journal.events} events, last hash ${r.journal.head.slice(0, 16)}, chain ${r.journal.chain}.`);
  if (r.signature !== undefined) {
    lines.push(
      "",
      `You signed this statement (${r.signature.by}, event ${r.signature.seq}):`,
      "",
      ...fenced(r.signature.statement),
      "",
      ...(r.signature.prose !== undefined ? [`from your words: ${md(clip(r.signature.prose, 300))}`, ""] : []),
      ...(r.signature.testLemmas !== undefined ? [`Test lemmas on the first cases: ${r.signature.testLemmas.result}${r.signature.testLemmas.tried > 0 ? ` (${r.signature.testLemmas.tried} case(s))` : ""}${r.signature.testLemmas.note !== undefined ? `, ${md(clip(r.signature.testLemmas.note, 160))}` : ""}.`, ""] : []),
    );
  }
  // The certifier.
  if (r.certifier.name === null || r.certifier.unavailable !== undefined) {
    lines.push(
      "",
      `> **No certifier ran.** ${r.certifier.unavailable !== undefined ? `\`lean.certify\` was unavailable: ${md(clip(r.certifier.unavailable, 300))}.` : "The host has no \`lean.certify\`."} A proof that passes the fast Lean check stays \`computed\`; only a certified proof makes a claim \`proved\`. Run \`pnpm harness doctor\` to see what is missing.`,
    );
  }
  // Claims.
  lines.push("", "## Claims by status", "", r.claims.total === 0 ? "The journal holds no claim." : `${r.claims.total} claim(s): ${counts(r.claims.byStatus)}.`);
  if (r.claims.listed.length > 0) {
    lines.push("", ...table(["Claim", "Status", "Statement"], r.claims.listed.map((c) => [c.id, c.status, c.statement])));
    if (r.claims.omitted > 0) lines.push("", `(${r.claims.omitted} more in the journal.)`);
  }
  // Certified.
  lines.push("", "## Lean proofs certified so far", "");
  if (r.certified.length === 0) lines.push("None yet. A claim is `proved` or `refuted` only when the kernel replay certified a proof; nothing below counts as one.");
  for (const c of r.certified) {
    lines.push(
      `### ${c.negation ? "Refutation" : "Proof"} of ${c.claimId}`,
      "",
      `Statement: ${code(c.statement)}`,
      "",
      `Certified by kernel replay ${c.validationId}${c.attemptId !== undefined ? `, proof from ${c.prover ?? "a prover"}, attempt ${c.attemptId}` : ""}; axioms: ${c.axioms.length === 0 ? "none" : c.axioms.join(", ")}.${c.negation ? " The file proves the negation of the statement." : ""}`,
      "",
      ...(c.file !== undefined ? fenced(c.file) : ["(the Lean file's blob is not in the run directory; its hash is in the journal)"]),
      "",
    );
  }
  if (r.carried.length > 0) {
    lines.push("", "Proved or refuted in the memory this run started on (not certified again by this run):", "", ...r.carried.map((c) => `- ${c.claimId} (${c.status}): ${md(c.statement)}`));
  }
  // Candidates.
  if (r.candidates.length > 0) {
    lines.push("", "## Passed the fast check, not certified", "", "These proofs were accepted by the fast Lean check. They are candidates (`computed`), not results: until the kernel replay certifies them, they may still be wrong.", "");
    for (const c of r.candidates) {
      lines.push(`### Candidate for ${c.claimId}`, "", `Statement: ${code(c.statement)}`, "", `Fast check ${c.validationId}${c.attemptId !== undefined ? `, from ${c.prover ?? "a prover"}, attempt ${c.attemptId}` : ""}.`, "", ...(c.file !== undefined ? fenced(c.file) : ["(file not in the run directory)"]), "");
    }
  }
  // Partial.
  if (r.partial.length > 0) {
    lines.push("", "## Partial sketches with open holes", "", "Not proofs: each file still has `sorry`. They are where the provers got to.", "");
    for (const s of r.partial) {
      lines.push(`### ${s.claimId}: ${s.holes} open hole(s)`, "", `Statement: ${code(s.statement)}`, "", `The last file of ${s.prover} (attempt ${s.attemptId}), regions only:`, "", ...fenced(`${s.aux.trim() === "" ? "" : `${s.aux}\n\n-- proof:\n`}${s.proof}`));
      if (s.lastCheck !== undefined) lines.push("", "What Lean said of it:", "", ...fenced(s.lastCheck, "text"));
      lines.push("");
    }
  }
  // Counter-examples and evidence.
  if (r.counterexamples.length > 0) {
    lines.push("", "## Counter-examples", "", "Found by a program or a small model. They are leads: a claim is `refuted` only by a certified proof of its negation (see above).", "", ...r.counterexamples.map((c) => `- ${c.id}${c.claimId !== undefined ? ` (about ${c.claimId})` : ""}, ${c.kind}: ${md(c.text)}`));
  }
  if (r.evidence.length > 0) {
    lines.push("", "## Indicative evidence (not proofs)", "", "What tools, fingerprints and conjectures found. Marked as evidence: none of it changes a claim's status.", "", ...r.evidence.map((c) => `- [evidence] ${c.id}${c.claimId !== undefined ? ` (about ${c.claimId})` : ""}, ${c.kind}: ${md(c.text)}`));
  }
  if (r.intake !== undefined) lines.push("", ...renderIntake(r.intake));
  // Failed.
  lines.push("", "## What was tried and failed", "");
  if (r.failed.length === 0 && r.errors.length === 0) lines.push("Nothing failed yet, or no session has ended.");
  if (r.failed.length > 0) lines.push(...table(["Claim", "Strategy", "Attempts", "Outcomes", "Last failure"], r.failed.map((f) => [f.claimId, f.strategy, String(f.attempts), counts(f.outcomes), f.lastFailure ?? ""])));
  if (r.errors.length > 0) lines.push("", ...r.errors.map((e) => `- ${md(e)}`));
  // Spend.
  lines.push("", "## Spend", "", ...(r.spend.sites.length === 0 ? ["Nothing was spent."] : table(["Site", "Calls", "Dollars", "Input tokens", "Output tokens", "Share"], r.spend.sites.map((s) => [s.site, String(s.calls), money(s.usd), String(s.inputTokens), String(s.outputTokens), `${(s.share * 100).toFixed(0)}%`]))));
  if (r.spend.rungs !== undefined) lines.push("", `By rung of the ladder: ${Object.entries(r.spend.rungs).sort(([a], [b]) => Number(a) - Number(b)).map(([rung, usd]) => `rung ${rung} ${money(usd)}`).join(", ")}.`);
  // Resume.
  lines.push("", "## To continue", "", r.state === "finished" ? r.resume : ["```sh", r.resume, "```"].join("\n"));
  lines.push("", "---", "", `Built from the journal alone, by code, with no model call: ${r.journal.events} events, last hash ${r.journal.head.slice(0, 16)}. The journal is the source of truth; this file is rewritten after every certified result and at every stop.`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Reading a run directory, and writing.

/** The earlier journals a run started on, read again; or why they cannot be. */
function chainOf(journalPath: string): ResultOptions["chain"] | undefined {
  try {
    return chainOfJournal(journalPath);
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
}

/** A blob reader that answers undefined for a hash the store does not hold or does not accept: a page about a damaged run must still be written. */
export function blobReader(store: BlobStore): (hash: string) => string | undefined {
  return (hash) => {
    try {
      return store.get(hash);
    } catch {
      return undefined;
    }
  };
}

/** The result of a run directory, from its journal and blobs. */
export function readResult(dir: string): Result {
  const path = join(dir, "journal.jsonl");
  const events = readEvents(path);
  const blobs = new BlobStore(join(dir, "blobs"));
  const state = stateOf(events);
  const chain = chainOf(path);
  return buildResult(events, { blob: blobReader(blobs), ...(chain !== undefined ? { chain } : {}), resume: resumeCommand(dir, state) });
}

function stateOf(events: readonly HarnessEvent[]): RunState {
  const lastResumed = events.findLastIndex((e) => e.type === "run.resumed");
  if (events.findLastIndex((e) => e.type === "run.finished") > lastResumed) return "finished";
  const end = events.findLastIndex((e) => e.type === "turn.ended");
  const turn = end > lastResumed ? events[end] : undefined;
  if (turn?.type === "turn.ended" && turn.data.reason !== "interrupted") return turn.data.waiting.length > 0 ? "paused" : "finished";
  return "cut";
}

/** Writes `RESULT.md` next to the journal, whole or not at all (a rename), and returns the result. A directory whose run did not start has none. */
export function writeResult(dir: string): Result {
  const result = readResult(dir);
  const file = join(dir, "RESULT.md");
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, renderResult(result));
  renameSync(temporary, file);
  return result;
}

/**
 * Keeps RESULT.md current while a run is written: after every certified result (a claim that becomes `proved` or `refuted`) and at every
 * stop (a turn that ends, the run that finishes). The caller writes it once more when the run is over, which covers a crash. A failure to
 * write is told to `log` and never stops the run: the journal is the record, this is its reading.
 */
export function keepResultCurrent(journal: Journal, dir: string, log: (line: string) => void = () => {}): () => void {
  return journal.log.onAppend((event) => {
    const certifiedResult = event.type === "claim.status_changed" && (event.data.to === "proved" || event.data.to === "refuted");
    if (!certifiedResult && event.type !== "turn.ended" && event.type !== "run.finished") return;
    try {
      writeResult(dir);
    } catch (error) {
      log(`RESULT.md could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

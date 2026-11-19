import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BlobStore, extractSubmission, type HarnessEvent, HOLE_VERDICT_KIND, readEvents } from "@seshat/core";
import { shown } from "@seshat/lit";
import { informalProofOfNodes } from "@seshat/memory";
import { type RefineStopRecord, SESSION_KIND, SKETCH_KIND, type SessionRecord, type SketchRecord } from "@seshat/scheduler";
import { gateReport } from "./gate-report.ts";
import { triageOfNodes, triageProblem, TRIAGE_KIND, type TriageResult } from "./triage.ts";
import { RunSetupError } from "./setup-error.ts";
import { auxLemmas, leanLines, leanTheorems, lengthBuckets, type LengthRecord, median, referenceLength } from "./length.ts";

/**
 * `harness audit RUN_DIR` (plan change PA15, documentation/audit.md): what a person reads to see why a problem was not certified, built from the
 * journal and the run's blobs and transcripts alone. No model call, no Lean, and nothing written into the journal. A reference solution a person
 * supplies is shown beside a dossier and never read by a solving run.
 */
const SESSION_SITE = "prover.session";
const LEAN_ERROR_CHARS = 300;
const SKETCH_CHARS = 1500;

export interface AuditSession {
  attemptId: string;
  site: string;
  turns?: number;
  /** `lean_check` calls: the session's own count, or those found in its transcript; absent when the run did not record them. */
  leanChecks?: number;
  /** Tool calls by name, from the transcript; or the tool runs of the attempt (`toolRunsOnly`) when there is no transcript. */
  tools: Record<string, number>;
  toolsFrom: "transcript" | "tool_runs";
  stoppedBy?: string;
  outcome?: string;
  usd: number;
}

export interface AuditGateAnswer {
  site: string;
  action: string;
  by: string;
  reason: string;
}

export interface AuditDossier {
  problemId: string;
  outcome: string;
  spendUsd: number;
  spendBySite: Record<string, number>;
  sessions: AuditSession[];
  gate: AuditGateAnswer[];
  leanErrors: string[];
  sketch?: {
    text: string;
    textMissing: boolean;
    healthy: boolean;
    problem?: string;
    failureClass?: string;
    dropped: string[];
    plannerRounds: number;
    repairs: number;
    holeVerdicts: Record<string, number>;
    refineStop?: string;
  };
  informal?: { accepted: boolean; verdicts: string[]; models: { planner: string; verifier: string }; stop: string };
  /** The formal-cost triage (PA14): the journaled one when the run made it, else computed from the journal now (no model call). `computed` says which. */
  triage: TriageResult & { computed: boolean };
  hygiene: Array<{ check: string; result: string; detail?: string }>;
  literature: Array<{ title: string; url: string; verdict: string }>;
  /** A person's reference solution, when `--reference` supplied one. */
  reference?: string;
}

export interface Audit {
  runId?: string;
  problems: number;
  certified: number;
  spendUsd: number;
  sessions: number;
  sessionsWithoutCheck: number;
  /** Problems the gate stopped at their probe: no Lean progress. */
  gateStopsAfterProbe: number;
  dossiers: AuditDossier[];
  /** One record for every problem, certified or not (plan change LP1, "Length"). */
  lengths: LengthRecord[];
}

export interface AuditSources {
  events: readonly HarnessEvent[];
  /** The text of a blob, or undefined. */
  blob?: (hash: string) => string | undefined;
  /** The messages of an attempt's transcript, or undefined. */
  transcript?: (attemptId: string) => unknown;
  reference?: (problemId: string) => string | undefined;
  /** The measured Lean length of a person's reference for a problem (`referenceLength`). */
  referenceLength?: (problemId: string) => LengthRecord["reference"];
}

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** The tool calls of a transcript by name, and the `lean_check` calls among them. */
function transcriptCalls(messages: unknown): Record<string, number> | undefined {
  if (!Array.isArray(messages)) return undefined;
  const calls: Record<string, number> = {};
  for (const message of messages) {
    const content = obj(message)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = obj(part);
      if (p?.type === "toolCall" && typeof p.name === "string") calls[p.name] = (calls[p.name] ?? 0) + 1;
    }
  }
  return calls;
}

export function audit(src: AuditSources): Audit {
  const events = src.events;
  const blob = (hash: string): string | undefined => {
    try {
      return src.blob?.(hash);
    } catch {
      return undefined;
    }
  };
  const problemClaim = new Map<string, string>();
  const claimProblem = new Map<string, string>();
  const parentOf = new Map<string, string>();
  const taskProblem = new Map<string, string>();
  for (const e of events) {
    if (e.type === "problem.registered") {
      problemClaim.set(e.data.problemId, e.data.claimId);
      claimProblem.set(e.data.claimId, e.data.problemId);
    } else if (e.type === "claim.created" && e.data.parentId !== undefined) {
      parentOf.set(e.data.claimId, e.data.parentId);
    } else if (e.type === "edge.added" && e.data.kind === "decomposes_into") {
      for (const to of e.data.to) if (!parentOf.has(to)) parentOf.set(to, e.data.from);
    } else if (e.type === "task.created" && e.data.problemId !== undefined) {
      taskProblem.set(e.data.taskId, e.data.problemId);
    }
  }
  const problemOfClaim = (claimId: string | undefined): string | undefined => {
    for (let id = claimId, hops = 0; id !== undefined && hops < 50; id = parentOf.get(id), hops++) {
      const found = claimProblem.get(id);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const outcomes = new Map<string, string>();
  const claimStatus = new Map<string, string>();
  for (const e of events) {
    if (e.type === "problem.finished") outcomes.set(e.data.problemId, e.data.outcome);
    else if (e.type === "claim.status_changed") claimStatus.set(e.data.claimId, e.data.to);
  }
  const certifiedOf = (problemId: string): boolean => {
    const status = claimStatus.get(problemClaim.get(problemId) as string);
    return status === "proved" || status === "refuted" || (status === undefined && ["proved", "refuted"].includes(outcomes.get(problemId) ?? ""));
  };

  // Attempts, with the problem each works for and what they charged.
  const attemptProblem = new Map<string, string>();
  const sessions = new Map<string, AuditSession>();
  const toolRuns = new Map<string, Record<string, number>>();
  const toolRunAttempt = new Map<string, string>();
  for (const e of events) {
    if (e.type === "attempt.started") {
      const problemId = (e.data.taskId !== undefined ? taskProblem.get(e.data.taskId) : undefined) ?? problemOfClaim(e.data.claimId);
      if (problemId !== undefined) attemptProblem.set(e.data.attemptId, problemId);
      sessions.set(e.data.attemptId, { attemptId: e.data.attemptId, site: e.data.site ?? SESSION_SITE, tools: {}, toolsFrom: "transcript", usd: 0 });
    } else if (e.type === "tool_run.started" && e.data.attemptId !== undefined) {
      const by = toolRuns.get(e.data.attemptId) ?? {};
      by[e.data.capability] = (by[e.data.capability] ?? 0) + 1;
      toolRuns.set(e.data.attemptId, by);
      toolRunAttempt.set(e.data.toolRunId, e.data.attemptId);
    }
  }
  const spend = new Map<string, Record<string, number>>();
  const addSpend = (problemId: string, site: string, usd: number) => {
    const by = spend.get(problemId) ?? {};
    by[site] = (by[site] ?? 0) + usd;
    spend.set(problemId, by);
  };
  const charged = new Set<string>();
  for (const e of events) {
    if (e.type === "attempt.finished") {
      const s = sessions.get(e.data.attemptId);
      if (s === undefined) continue;
      s.usd = e.data.usd;
      s.turns = e.data.turns;
      s.outcome = e.data.outcome;
      if (e.data.stoppedBy !== undefined) s.stoppedBy = e.data.stoppedBy;
      if (e.data.checks !== undefined) s.leanChecks = e.data.checks;
      charged.add(e.data.attemptId);
    }
  }
  // A session that never finished kept its charges.
  for (const e of events) if (e.type === "attempt.charged" && !charged.has(e.data.attemptId)) (sessions.get(e.data.attemptId) ?? { usd: 0 }).usd += e.data.usd;
  for (const s of sessions.values()) {
    const problemId = attemptProblem.get(s.attemptId);
    if (problemId !== undefined) addSpend(problemId, s.site, s.usd);
    const calls = transcriptCalls(src.transcript?.(s.attemptId));
    if (calls !== undefined) {
      s.tools = calls;
      if (s.leanChecks === undefined) s.leanChecks = calls.lean_check ?? 0;
    } else {
      s.toolsFrom = "tool_runs";
      s.tools = toolRuns.get(s.attemptId) ?? {};
    }
  }
  for (const e of events) {
    // Calls made inside a session are already in its totals.
    if (e.type === "model_call.finished" && e.data.attemptId === undefined && e.data.problemId !== undefined) addSpend(e.data.problemId, e.data.site ?? e.data.line, e.data.usd);
  }

  const leanErrors = new Map<string, string[]>();
  const gate = new Map<string, AuditGateAnswer[]>();
  const sketches = new Map<string, SketchRecord[]>();
  const sessionRecords = new Map<string, SessionRecord[]>();
  const refineStops = new Map<string, RefineStopRecord>();
  // Verdicts of the holes of each problem, by hole claim: the last one wins (a hole may have several sessions).
  const holeVerdicts = new Map<string, Map<string, string>>();
  const noteVerdict = (pid: string, key: string, verdict: unknown, reason?: unknown) => {
    if (typeof verdict !== "string") return;
    const by = holeVerdicts.get(pid) ?? new Map<string, string>();
    by.set(key, verdict === "too_hard" && typeof reason === "string" ? `${verdict} (${reason})` : verdict);
    holeVerdicts.set(pid, by);
  };
  // The validations of each problem's own claim, in journal order, with their file's blob.
  const ownValidations = new Map<string, Array<{ method: string; verdict: string; hash: string }>>();
  // `lean.check` runs made inside the problem's attempts: the input blob, and the duration once finished.
  const checkRuns = new Map<string, { problemId: string; inputHash: string; ms?: number }>();
  const hygiene = new Map<string, AuditDossier["hygiene"]>();
  const literature = new Map<string, AuditDossier["literature"]>();
  const informalNodes = new Map<string, Array<{ nodeId: string; data: unknown }>>();
  const triageNodes = new Map<string, Array<{ data: unknown }>>();
  const allowance = new Map<string, number>();
  let searched = false;
  for (const e of events) {
    if (e.type === "problem.registered" && e.data.allowanceUsd !== undefined) allowance.set(e.data.problemId, e.data.allowanceUsd);
    else if (e.type === "tool_run.started" && e.data.capability === "lean.search") searched = true;
  }
  for (const e of events) {
    if (e.type === "validation.finished") {
      const own = claimProblem.get(e.data.claimId);
      if (own !== undefined) ownValidations.set(own, [...(ownValidations.get(own) ?? []), { method: e.data.method, verdict: e.data.verdict, hash: e.data.submissionHash }]);
    } else if (e.type === "tool_run.started" && e.data.capability === "lean.check" && e.data.attemptId !== undefined) {
      const pid = attemptProblem.get(e.data.attemptId);
      if (pid !== undefined) checkRuns.set(e.data.toolRunId, { problemId: pid, inputHash: e.data.inputHash });
    } else if (e.type === "tool_run.finished") {
      const run = checkRuns.get(e.data.toolRunId);
      if (run !== undefined) run.ms = e.data.durationMs;
    }
    if (e.type === "validation.finished" && e.data.verdict === "invalid" && e.data.reasons.length > 0) {
      const problemId = problemOfClaim(e.data.claimId);
      if (problemId !== undefined) leanErrors.set(problemId, [...(leanErrors.get(problemId) ?? []), e.data.reasons.join("\n")]);
    } else if (e.type === "budget.gated") {
      gate.set(e.data.problemId, [...(gate.get(e.data.problemId) ?? []), { site: e.data.site, action: e.data.action, by: e.data.by, reason: e.data.reason }]);
    } else if (e.type === "node.recorded") {
      const d = obj(e.data.data);
      const pid = typeof d?.problemId === "string" ? d.problemId : problemOfClaim(e.data.claimId);
      if (pid === undefined) continue;
      if (e.data.kind === SKETCH_KIND) sketches.set(pid, [...(sketches.get(pid) ?? []), e.data.data as unknown as SketchRecord]);
      else if (e.data.kind === SESSION_KIND) {
        sessionRecords.set(pid, [...(sessionRecords.get(pid) ?? []), e.data.data as unknown as SessionRecord]);
        const r = e.data.data as unknown as SessionRecord;
        noteVerdict(pid, r.claimId ?? r.taskId, r.verdict, r.reason);
      }
      else if (e.data.kind === HOLE_VERDICT_KIND) noteVerdict(pid, e.data.claimId ?? e.data.nodeId, d?.verdict, d?.reason);
      else if (e.data.kind === "m12_refine_stop") refineStops.set(pid, e.data.data as unknown as RefineStopRecord);
      else if (e.data.kind === "hygiene" && d !== undefined) hygiene.set(pid, [...(hygiene.get(pid) ?? []), { check: String(d.check ?? ""), result: String(d.result ?? ""), ...(typeof d.detail === "string" ? { detail: d.detail } : {}) }]);
      else if (e.data.kind === "literature" && d !== undefined && d.verdict !== "unrelated") literature.set(pid, [...(literature.get(pid) ?? []), { title: String(d.title ?? ""), url: String(d.url ?? ""), verdict: String(d.verdict ?? "") }]);
      else if (e.data.kind === TRIAGE_KIND) triageNodes.set(pid, [...(triageNodes.get(pid) ?? []), { data: e.data.data }]);
      else if (e.data.kind === "informal_proof") informalNodes.set(pid, [...(informalNodes.get(pid) ?? []), { nodeId: e.data.nodeId, data: e.data.data }]);
    }
  }

  const dossiers: AuditDossier[] = [];
  for (const problemId of problemClaim.keys()) {
    if (certifiedOf(problemId)) continue;
    const by = spend.get(problemId) ?? {};
    const mine = [...sessions.values()].filter((s) => attemptProblem.get(s.attemptId) === problemId);
    const records = sketches.get(problemId) ?? [];
    const last = records[records.length - 1];
    let sketch: AuditDossier["sketch"];
    if (last !== undefined) {
      let text = "";
      const raw = typeof last.submission === "string" ? blob(last.submission) : undefined;
      if (raw !== undefined) {
        try {
          const parsed = obj(JSON.parse(raw));
          text = typeof parsed?.aux === "string" || typeof parsed?.proof === "string" ? `${String(parsed?.aux ?? "")}${parsed?.aux ? "\n" : ""}${String(parsed?.proof ?? "")}` : raw;
        } catch {
          text = raw;
        }
      }
      const verdicts: Record<string, number> = {};
      for (const r of sessionRecords.get(problemId) ?? []) if (r.verdict !== undefined) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
      sketch = {
        text: text.slice(0, SKETCH_CHARS),
        textMissing: raw === undefined,
        healthy: last.healthy,
        ...(last.problem !== undefined ? { problem: last.problem } : {}),
        ...(last.failureClass !== undefined ? { failureClass: last.failureClass } : {}),
        dropped: last.dropped ?? [],
        plannerRounds: records.filter((r) => r.planner === true).length,
        repairs: records.filter((r) => r.repairOf !== undefined).length,
        holeVerdicts: verdicts,
        ...(refineStops.has(problemId) ? { refineStop: (refineStops.get(problemId) as RefineStopRecord).reason } : {}),
      };
    }
    const informal = informalProofOfNodes(informalNodes.get(problemId) ?? [], () => undefined);
    const reference = src.reference?.(problemId);
    const journaled = triageOfNodes(triageNodes.get(problemId) ?? []);
    const plausible = (hygiene.get(problemId) ?? []).filter((h) => h.check === "plausible").at(-1)?.result;
    const triage: AuditDossier["triage"] = journaled !== undefined
      ? { ...journaled, computed: false }
      : {
          ...triageProblem({
            informal: informalProofOfNodes(informalNodes.get(problemId) ?? [], (hash) => blob(hash)),
            searched,
            plausible,
            budgetUsd: allowance.get(problemId),
          }),
          computed: true,
        };
    dossiers.push({
      problemId,
      outcome: outcomes.get(problemId) ?? "not finished",
      spendUsd: Object.values(by).reduce((a, b) => a + b, 0),
      spendBySite: by,
      sessions: mine,
      gate: gate.get(problemId) ?? [],
      leanErrors: (leanErrors.get(problemId) ?? []).slice(-3).map((t) => t.slice(0, LEAN_ERROR_CHARS)),
      ...(sketch !== undefined ? { sketch } : {}),
      ...(informal !== undefined ? { informal: { accepted: informal.accepted, verdicts: informal.verdicts, models: informal.models, stop: informal.stop } } : {}),
      triage,
      hygiene: hygiene.get(problemId) ?? [],
      literature: literature.get(problemId) ?? [],
      ...(reference !== undefined ? { reference } : {}),
    });
  }
  const lengths: LengthRecord[] = [];
  for (const problemId of problemClaim.keys()) {
    const certified = certifiedOf(problemId);
    const mine = [...sessions.values()].filter((s) => attemptProblem.get(s.attemptId) === problemId);
    const validations = ownValidations.get(problemId) ?? [];
    const records = sketches.get(problemId) ?? [];
    // The file measured: the certified proof, else the last failed check of the problem's own claim, else its last check, else the last sketch.
    let picked: { text: string; source: NonNullable<LengthRecord["file"]>["source"]; counted: "regions" | "file" } | undefined;
    const fromBlob = (hash: string | undefined): { text: string; counted: "regions" | "file" } | undefined => {
      const raw = hash === undefined ? undefined : blob(hash);
      if (raw === undefined) return undefined;
      try {
        const sub = extractSubmission(raw);
        return { text: `${sub.aux}\n${sub.proof}`, counted: "regions" };
      } catch {
        return { text: raw, counted: "file" };
      }
    };
    const lastOf = (pred: (v: { method: string; verdict: string }) => boolean) => [...validations].reverse().find((v) => pred(v) && blob(v.hash) !== undefined)?.hash;
    const order: Array<[NonNullable<LengthRecord["file"]>["source"], string | undefined]> = certified
      ? [["certified_validation", lastOf((v) => v.method === "kernel_replay" && v.verdict === "valid") ?? lastOf((v) => v.verdict === "valid")]]
      : [["last_failed_validation", lastOf((v) => v.verdict === "invalid")], ["last_validation", lastOf(() => true)]];
    for (const [source, hash] of order) {
      const got = fromBlob(hash);
      if (got !== undefined) {
        picked = { ...got, source };
        break;
      }
    }
    const lastSketch = records[records.length - 1];
    if (picked === undefined && lastSketch !== undefined && typeof lastSketch.submission === "string") {
      const raw = blob(lastSketch.submission);
      if (raw !== undefined) {
        let text = raw;
        try {
          const parsed = obj(JSON.parse(raw));
          if (typeof parsed?.aux === "string" || typeof parsed?.proof === "string") text = `${String(parsed?.aux ?? "")}\n${String(parsed?.proof ?? "")}`;
        } catch {
          // Not JSON: the text is the file.
        }
        picked = { text, source: "last_sketch", counted: "regions" };
      }
    }
    const verdicts: Record<string, number> = {};
    for (const v of holeVerdicts.get(problemId)?.values() ?? []) verdicts[v] = (verdicts[v] ?? 0) + 1;
    const sessionChecks = mine.filter((s) => s.leanChecks !== undefined);
    const runs = [...checkRuns.values()].filter((r) => r.problemId === problemId);
    const checkTimes: LengthRecord["checkTimes"] = [];
    for (const r of runs) {
      const input = r.ms === undefined ? undefined : blob(r.inputHash);
      if (input === undefined || r.ms === undefined) continue;
      try {
        const snippets = obj(JSON.parse(input))?.snippets;
        if (Array.isArray(snippets)) checkTimes.push({ chars: snippets.reduce((n: number, x) => n + (typeof obj(x)?.code === "string" ? (obj(x)?.code as string).length : 0), 0), ms: r.ms });
      } catch {
        // An input that is not JSON gives no size.
      }
    }
    const stopReasons: Record<string, number> = {};
    for (const s of mine) if (s.stoppedBy !== undefined) stopReasons[s.stoppedBy] = (stopReasons[s.stoppedBy] ?? 0) + 1;
    const reference = src.referenceLength?.(problemId);
    lengths.push({
      problemId,
      status: certified ? "certified" : "not certified",
      outcome: outcomes.get(problemId) ?? "not finished",
      ...(picked !== undefined
        ? {
            file: { source: picked.source, counted: picked.counted, lines: leanLines(picked.text), chars: picked.text.length, theorems: leanTheorems(picked.text).length },
            auxLemmas: auxLemmas(picked.text),
          }
        : {}),
      ...(lastSketch !== undefined ? { holes: { count: lastSketch.names.length, dropped: (lastSketch.dropped ?? []).length, healthy: lastSketch.healthy, verdicts } } : {}),
      ...(sessionChecks.length > 0 ? { leanChecks: sessionChecks.reduce((n, s) => n + (s.leanChecks ?? 0), 0) } : {}),
      leanCheckRuns: runs.length,
      checkTimes,
      stopReasons,
      ...(reference !== undefined ? { reference } : {}),
    });
  }
  const finished = events.find((e) => e.type === "run.finished");
  const all = [...sessions.values()];
  return {
    ...(events[0]?.type === "run.started" ? { runId: events[0].data.runId } : {}),
    problems: problemClaim.size,
    certified: [...problemClaim.keys()].filter(certifiedOf).length,
    spendUsd: finished?.type === "run.finished" ? finished.data.usd : [...spend.values()].reduce((a, by) => a + Object.values(by).reduce((x, y) => x + y, 0), 0),
    sessions: all.length,
    sessionsWithoutCheck: all.filter((s) => (s.leanChecks ?? 0) === 0).length,
    gateStopsAfterProbe: gateReport(events)?.stoppedAtProbe ?? 0,
    dossiers,
    lengths,
  };
}

/** A fence longer than any run of backticks in the text, so that third-party text cannot close it. */
function fenced(text: string): string[] {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, text, fence];
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const counts = (r: Record<string, number>) => Object.entries(r).map(([k, v]) => `${k} x${v}`).join(", ") || "none";

const NOT_RECORDED = "not recorded";
const cell = (v: string | number | undefined): string => (v === undefined ? NOT_RECORDED : String(v));

/** The "Length" section (plan change LP1): every problem, then the success against reference length. */
function renderLength(lengths: readonly LengthRecord[], heading: string): string[] {
  const out = [
    heading,
    "",
    "Lean lines are the lines that are neither blank nor only a comment (`--` and `/- -/`), of the file's `aux` and `proof` regions when the text has the markers, else of the whole text; characters count the same text. The file is the certified proof, else the problem's last failed check, else its last sketch. A number the journal does not hold is \"not recorded\".",
    "",
    "| Problem | Status | File (source) | Lines | Chars | `aux_` | Holes (verdicts) | `lean_check` | Check time vs size | Stopped by | Reference lines (theorems) |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of lengths) {
    const times = r.checkTimes;
    const biggest = times.length === 0 ? undefined : times.reduce((x, y) => (y.chars > x.chars ? y : x));
    const timing = biggest === undefined ? NOT_RECORDED : `${times.length} timed; median ${median(times.map((t) => t.ms))} ms; largest ${biggest.chars} chars in ${biggest.ms} ms`;
    const holes = r.holes === undefined ? "none" : `${r.holes.count} (${r.holes.healthy ? "healthy" : "not healthy"}${r.holes.dropped > 0 ? `, ${r.holes.dropped} dropped` : ""}; ${counts(r.holes.verdicts)})`;
    const checks = r.leanChecks !== undefined ? String(r.leanChecks) : r.leanCheckRuns > 0 ? `${r.leanCheckRuns} tool runs` : NOT_RECORDED;
    out.push(
      `| \`${shown(r.problemId, 80)}\` | ${r.status} | ${r.file === undefined ? NOT_RECORDED : r.file.source.replace(/_/g, " ")} | ${cell(r.file?.lines)} | ${cell(r.file?.chars)} | ${cell(r.auxLemmas)} | ${holes} | ${checks} | ${timing} | ${Object.keys(r.stopReasons).length === 0 ? NOT_RECORDED : counts(r.stopReasons)} | ${r.reference === undefined ? "no reference" : `${r.reference.lines} (${r.reference.theorems})`} |`,
    );
  }
  out.push(
    "",
    "Success against reference length (reference lines counted the same way; the median is of the certified problems' Seshat lines):",
    "",
    "| Reference lines | Certified / total | Median Seshat lines (certified) |",
    "|---|---|---|",
  );
  for (const b of lengthBuckets(lengths)) out.push(`| ${b.bucket} | ${b.certified} / ${b.total} | ${cell(b.medianCertifiedLines)} |`);
  out.push("");
  return out;
}

/** The Markdown of an audit; `level` is the heading depth of its title (an ablation's arm is one level lower). */
export function renderAudit(a: Audit, title: string, level = 1): string[] {
  const h = (n: number) => "#".repeat(level + n);
  const out = [
    `${h(0)} ${title}`,
    "",
    `- Problems: ${a.problems}, certified: ${a.certified}, not certified: ${a.dossiers.length}.`,
    `- Spend: ${usd(a.spendUsd)}.`,
    `- Sessions: ${a.sessions}; with no \`lean_check\`: ${a.sessionsWithoutCheck}.`,
    `- Problems the budget gate stopped after the probe: ${a.gateStopsAfterProbe}.`,
    "",
  ];
  out.push(...renderLength(a.lengths, `${h(1)} Length`));
  for (const d of a.dossiers) {
    out.push(`${h(1)} \`${shown(d.problemId, 120)}\` (${d.outcome})`, "");
    out.push(`**Spend**: ${usd(d.spendUsd)}; by site: ${Object.entries(d.spendBySite).map(([s, v]) => `${s} ${usd(v)}`).join(", ") || "none"}.`, "");
    out.push(`**Sessions** (${d.sessions.length}):`, "");
    for (const s of d.sessions) {
      out.push(
        `- \`${s.attemptId}\` (${s.site}): ${s.turns ?? "?"} turn(s), ${s.leanChecks ?? "not recorded"} lean_check, stopped by ${s.stoppedBy ?? "not recorded"}${s.outcome !== undefined ? `, ${s.outcome}` : ""}; calls${s.toolsFrom === "tool_runs" ? " (tool runs: no transcript)" : ""}: ${counts(s.tools)}.`,
      );
    }
    out.push("", `**Budget gate** (${d.gate.length} answer(s)):`, "");
    for (const g of d.gate) out.push(`- ${g.site} ${g.action} by ${g.by}: ${shown(g.reason, 300)}`);
    out.push("", `**Last Lean errors** (first ${LEAN_ERROR_CHARS} characters):`, "");
    if (d.leanErrors.length === 0) out.push("None recorded.");
    for (const e of d.leanErrors) out.push(...fenced(e), "");
    if (d.sketch !== undefined) {
      const s = d.sketch;
      out.push(
        `**Last sketch or blueprint** (first ${SKETCH_CHARS} characters${s.textMissing ? "; the blob is not in the run directory" : ""}):`,
        "",
        ...fenced(s.text),
        "",
        `M12's records: ${s.healthy ? "healthy" : "not healthy"}${s.problem !== undefined ? `, problem: ${shown(s.problem, 300)}` : ""}${s.failureClass !== undefined ? `, class ${s.failureClass}` : ""}; dropped holes: ${s.dropped.length === 0 ? "none" : s.dropped.join(", ")}; planner rounds: ${s.plannerRounds}; repairs: ${s.repairs}; hole verdicts: ${counts(s.holeVerdicts)}${s.refineStop !== undefined ? `; refinement stopped: ${shown(s.refineStop, 200)}` : ""}.`,
        "",
      );
    } else out.push("**Last sketch or blueprint**: none recorded.", "");
    out.push(
      d.informal === undefined
        ? "**Informal proof**: none."
        : `**Informal proof**: ${d.informal.accepted ? "accepted" : "not accepted"}; verdicts: ${d.informal.verdicts.join(", ") || "none"}; models: planner ${d.informal.models.planner}, verifier ${d.informal.models.verifier}; stopped: ${d.informal.stop}.`,
      "",
    );
    out.push(`**Formal-cost triage**: ${d.triage.class} (${d.triage.computed ? "computed from the journal now" : "journaled by the run"}): ${d.triage.reasons.map((r) => shown(r, 200)).join("; ")}.`, "");
    out.push(`**Hygiene**: ${d.hygiene.length === 0 ? "none recorded" : d.hygiene.map((x) => `${x.check} ${x.result}${x.detail !== undefined ? ` (${shown(x.detail, 160)})` : ""}`).join("; ")}.`, "");
    out.push(`**Literature kept**: ${d.literature.length === 0 ? "none" : ""}`);
    for (const l of d.literature) out.push(`- ${shown(l.verdict, 20)}: "${shown(l.title, 160)}" (${shown(l.url, 200)})`);
    out.push("");
    if (d.reference !== undefined) out.push("**Reference solution** (supplied by a person; never read by a solving run):", "", ...fenced(d.reference), "");
  }
  return out;
}

/** The run directories under a path: the directory itself, or an ablation's arms (`arms/NAME/measure`). */
export function auditTargets(dir: string): Array<{ name: string; dir: string }> {
  const root = resolve(dir);
  if (existsSync(join(root, "journal.jsonl"))) return [{ name: "run", dir: root }];
  const arms = join(root, "arms");
  if (!existsSync(arms)) throw new RunSetupError(`${dir} is not a run or an ablation directory: it has no journal.jsonl and no arms/`);
  const found = readdirSync(arms)
    .sort()
    .flatMap((name) => [join(arms, name, "measure"), join(arms, name)].filter((d) => existsSync(join(d, "journal.jsonl"))).slice(0, 1).map((d) => ({ name, dir: d })));
  if (found.length === 0) throw new RunSetupError(`${dir} has no arm with a journal`);
  return found;
}

export interface AuditIo {
  /** A directory of `<problemId>.md` (or `.lean`) files: a person's reference solutions. */
  reference?: string | undefined;
  out: (line: string) => void;
}

function auditOf(dir: string, reference: string | undefined): Audit {
  const blobs = new BlobStore(join(dir, "blobs"));
  const transcripts = join(dir, "transcripts");
  return audit({
    events: readEvents(join(dir, "journal.jsonl")),
    blob: (hash) => {
      try {
        return blobs.get(hash);
      } catch {
        return undefined;
      }
    },
    transcript: (attemptId) => {
      const file = join(transcripts, `${attemptId}.json`);
      try {
        return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown) : undefined;
      } catch {
        return undefined;
      }
    },
    ...(reference !== undefined
      ? {
          referenceLength: (problemId: string) => referenceLength(reference, problemId),
          reference: (problemId: string) => {
            const file = join(reference, `${problemId.replace(/[\\/]/g, "_")}.md`);
            return existsSync(file) ? readFileSync(file, "utf8") : undefined;
          },
        }
      : {}),
  });
}

/** `harness audit DIR [--reference DIR]`: writes `audit.md` and `length.json` into DIR (a run, or an ablation with one section per arm) and returns the path of `audit.md`. Reads only. */
export function auditCommand(dir: string, io: AuditIo): string {
  const root = resolve(dir);
  const reference = io.reference !== undefined ? resolve(io.reference) : undefined;
  if (reference !== undefined && !existsSync(reference)) throw new RunSetupError(`--reference ${io.reference} does not exist`);
  const targets = auditTargets(root);
  const lines: string[] = [];
  const records: Array<LengthRecord & { arm: string; runId?: string }> = [];
  const section = (name: string, dir: string, title: string, level: number) => {
    const a = auditOf(dir, reference);
    lines.push(...renderAudit(a, title, level));
    records.push(...a.lengths.map((r) => ({ arm: name, ...(a.runId !== undefined ? { runId: a.runId } : {}), ...r })));
  };
  if (targets.length === 1 && targets[0]?.name === "run") section("run", targets[0].dir, "Audit", 1);
  else {
    lines.push("# Audit of an ablation", "", `${targets.length} arm(s), one section each.`, "");
    for (const t of targets) section(t.name, t.dir, `Arm ${t.name}`, 2);
  }
  writeFileSync(join(root, "length.json"), `${JSON.stringify({ records }, null, 2)}\n`);
  const file = join(root, "audit.md");
  writeFileSync(file, `${lines.join("\n")}\n`);
  io.out(`Audit: ${file}`);
  return file;
}

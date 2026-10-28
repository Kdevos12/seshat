import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { BlobStore, type EventDataMap, type HarnessEvent, type Json, type Journal, newId, type NodeRow, Projection, readEvents, type TaskRow } from "@seshat/core";
import { referencesIn } from "@seshat/guards";
import { claimAndParts, hintOf, HINT_KIND, STEER_KIND, steerOf } from "./team.ts";
import { JUDGMENT_KIND } from "./breakpoints.ts";
import { type Ledger, messageCost } from "./budget.ts";
import { nextLimit, type ConsortiumConfig, turnRecords } from "./turns.ts";
import { consortiumOf } from "./consortium.ts";

/**
 * The account of a turn (documentation/human.md, "The account"): what the research team reads when a
 * consortium run waits for it. It is built from the journal alone, with no model call, and for the
 * same journal it is the same text: it reads the events up to the end of its turn and nothing later.
 * A model may add a narrative, which the account marks as model-written and whose ids must resolve.
 */

/** The records the account reads by kind; any other kind of node is only counted. */
const READ_KINDS = new Set([
  "counter_model", "obstruction", "conjecture", "judgment", HINT_KIND, STEER_KIND,
  // Read as part of other things, or only counted by name as known:
  "identification", "fingerprint", "battery", "drift", "watch", "twin", "twin_work", "alias", "derivation", "derivation_intent", "allocation", "lesson", "source",
]);

const MAX_PER_LIST = 12;
const MAX_TREE_NODES = 60;

export interface AccountClaim {
  id: string;
  statement: string;
  status: string;
  /** Who checked it: the validation behind the status, by its method and the actor that recorded it. */
  checkedBy: string;
  validationId?: string;
}

export interface TreeNode {
  id: string;
  statement: string;
  status: string;
  depth: number;
  leaf: boolean;
}

export interface StrategyTried {
  subgoal?: string;
  strategy: string;
  attempts: number;
  outcomes: Record<string, number>;
  /** How the last failed one failed. */
  lastFailure?: string;
}

export interface OpenLeaf {
  id: string;
  statement: string;
  status: string;
  tried: StrategyTried[];
  forbidden: string[];
}

export interface RecordLine {
  id: string;
  kind: string;
  claimId?: string;
  text: string;
}

export interface ProblemAccount {
  problemId: string;
  target: string;
  claimId: string;
  /** Where the problem stands: its outcome, or `waiting` / `in progress`. */
  state: string;
  claimStatus: string;
  reason?: string;
  history: string[];
  attempts: number;
  sessionsStoppedByTurn: number;
  spendUsd: number;
  claims: AccountClaim[];
  signed: Array<{ edgeId: string; kind: string; from: string; to: string[]; by: string }>;
  tree: TreeNode[];
  openLeaves: OpenLeaf[];
  counterexamples: RecordLine[];
  obstructions: RecordLine[];
  conjectures: RecordLine[];
  next: string[];
}

export interface Account {
  version: 1;
  runId: string;
  turn: number;
  /** The last event the account reads. */
  journal: { events: number; head: string };
  ended: { reason: string; detail: string; minutes: number; breakpoint?: { kind: string; problemId?: string; nodeId?: string } } | null;
  limit: { tokens?: number; usd?: number; minutes?: number; source: string };
  summary: {
    problems: number;
    proved: number;
    refuted: number;
    candidates: number;
    waiting: string[];
    asked: string[];
  };
  spend: { turn: { usd: number; tokens: number } | null; run: { usd: number; inputTokens: number; outputTokens: number }; budgetUsd?: number; leftUsd?: number };
  problems: ProblemAccount[];
  team: { hints: number; signatures: number; steers: number; since: Array<{ kind: string; by: string; text: string }> };
  nextTurn: { limit: { tokens?: number; usd?: number; minutes?: number }; source: string };
  /** Kinds of node the account does not read, with how many there are. */
  unknownKinds: Record<string, number>;
  narrative?: { text: string; hash: string; modelWritten: true };
  narrativeRefused?: string;
}

/** A turn that has not been written yet: the account is built for what is about to be said of it. */
export interface Ending {
  reason: string;
  detail: string;
  breakpoint?: { kind: string; problemId?: string; nodeId?: string };
  waiting: string[];
}

export interface AccountOptions {
  /** Text of a narrative blob. */
  blob?: (hash: string) => string | undefined;
  /** The end of a turn that is not in the events yet. */
  ending?: Ending;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function object(data: Json): Record<string, Json> | undefined {
  return typeof data === "object" && data !== null && !Array.isArray(data) ? data : undefined;
}

function text(data: Json | undefined, ...keys: string[]): string | undefined {
  const o = object(data ?? null);
  for (const key of keys) {
    const value = o?.[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** One line on a record of the graph, from the fields its owner usually gives it. */
function describe(node: NodeRow): string {
  const o = object(node.data);
  const said = text(node.data, "description", "statement", "summary", "text", "title", "note");
  const evidence = o?.evidence;
  const evidenceText =
    typeof evidence === "string"
      ? ` Evidence: ${clip(evidence, 160)}`
      : Array.isArray(evidence)
        ? ` Evidence: ${evidence.length} item(s)${typeof evidence[0] === "string" ? `, such as ${clip(evidence[0], 120)}` : ""}.`
        : evidence !== undefined && evidence !== null
          ? ` Evidence: ${clip(JSON.stringify(evidence), 160)}`
          : "";
  const refuted = node.kind === "counter_model" && Array.isArray(o?.refutation) ? ` Refutation submissions: ${o.refutation.length}.` : "";
  return `${clip(said ?? JSON.stringify(node.data ?? null), 240)}${evidenceText}${refuted}`;
}

function recordLine(node: NodeRow): RecordLine {
  return { id: node.node_id, kind: node.kind, ...(node.claim_id !== null ? { claimId: node.claim_id } : {}), text: describe(node) };
}

function projectionOf(events: readonly HarnessEvent[]): Projection {
  const p = Projection.inMemory();
  for (const event of events) p.apply(event);
  return p;
}

/** The turn's events: those up to its `turn.ended`, or all of them while it has none. */
function eventsOfTurn(events: readonly HarnessEvent[], turn: number): HarnessEvent[] {
  const end = events.find((e) => e.type === "turn.ended" && e.data.turn === turn);
  return end === undefined ? [...events] : events.slice(0, end.seq + 1);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Builds the account of turn `turn` from the events of a journal. */
export function buildAccount(allEvents: readonly HarnessEvent[], turn: number, options: AccountOptions = {}): Account {
  const events = eventsOfTurn(allEvents, turn);
  const started = events.find((e) => e.type === "run.started");
  if (started === undefined || started.type !== "run.started") throw new Error("the journal has no run.started event");
  const p = projectionOf(events);
  const records = turnRecords(events);
  const record = records.find((r) => r.turn === turn);
  if (record === undefined) throw new Error(`the journal has no turn ${turn}`);
  const end = options.ending ?? (record.end === undefined ? undefined : { reason: record.end.reason, detail: record.end.detail, waiting: record.end.waiting, ...(record.end.breakpoint !== undefined ? { breakpoint: record.end.breakpoint } : {}) });
  const config = started.data.config;
  const consortium: ConsortiumConfig | undefined = consortiumOf(events);
  const budgetUsd = (() => {
    const budget = object(config)?.budget;
    const runUsd = object(budget ?? null)?.runUsd;
    return typeof runUsd === "number" ? runUsd : undefined;
  })();

  // Who recorded what: the actor of each validation and of each edge's status.
  const validationActor = new Map<string, string>();
  const signedBy = new Map<string, string>();
  const statusChanges = new Map<string, Array<EventDataMap["claim.status_changed"] & { seq: number }>>();
  const stoppedByTurn = new Map<string, number>();
  const attemptClaim = new Map<string, string>();
  for (const event of events) {
    if (event.type === "validation.finished") validationActor.set(event.data.validationId, event.actor);
    else if (event.type === "edge.status_changed" && event.data.to === "human_signed") signedBy.set(event.data.edgeId, event.actor);
    else if (event.type === "claim.status_changed") statusChanges.set(event.data.claimId, [...(statusChanges.get(event.data.claimId) ?? []), { ...event.data, seq: event.seq }]);
    else if (event.type === "attempt.started") attemptClaim.set(event.data.attemptId, event.data.claimId);
    else if (event.type === "attempt.finished" && event.data.stoppedBy === "turn") stoppedByTurn.set(event.data.attemptId, event.seq);
  }

  // The team's answers: what exists, and what came since the turn before.
  const lastBefore = records.filter((r) => r.turn < turn).at(-1);
  const sinceSeq = lastBefore?.endedSeq ?? -1;
  const forbidden = p.nodes(STEER_KIND).flatMap((node) => {
    const steer = steerOf(node.data);
    return steer?.action === "forbid_strategy" ? [{ strategy: steer.strategy, claimId: steer.claimId }] : [];
  });
  const since: Account["team"]["since"] = [];
  for (const node of [...p.nodes(HINT_KIND), ...p.nodes(STEER_KIND)]) {
    if (node.created_seq <= sinceSeq) continue;
    const hint = node.kind === HINT_KIND ? hintOf(node.data) : undefined;
    const steer = node.kind === STEER_KIND ? steerOf(node.data) : undefined;
    since.push({
      kind: node.kind === HINT_KIND ? "hint" : `steer ${steer?.action ?? "?"}`,
      by: hint?.by ?? steer?.by ?? "?",
      text: clip(hint?.text ?? JSON.stringify(steer ?? node.data), 200),
    });
  }
  const signatures = events.filter((e) => e.type === "edge.status_changed" && e.data.to === "human_signed").length;

  const problems: ProblemAccount[] = [];
  const waitingSet = new Set(end?.waiting ?? []);
  for (const problem of p.problems()) {
    const scope = claimAndParts(p, problem.claim_id);
    const claim = p.claim(problem.claim_id);
    const claimStatus = claim?.status ?? "unknown";

    // How it got there: the claim's status changes in order, with what justified each.
    const history: string[] = [];
    for (const id of scope) {
      for (const change of statusChanges.get(id) ?? []) {
        const via = change.validationId !== undefined ? ` (validation ${change.validationId}, ${p.validation(change.validationId)?.method ?? "?"}, by ${validationActor.get(change.validationId) ?? "?"})` : "";
        history.push(`${id}: ${change.from} -> ${change.to}: ${clip(change.reason, 160)}${via}`);
      }
    }
    const attemptsOfProblem = p.tasks({ problemId: problem.problem_id }).flatMap((task) => p.attemptsOfTask(task.task_id));
    const turnStopped = attemptsOfProblem.filter((a) => stoppedByTurn.has(a.attempt_id)).length;

    // Claims proved, computed or refuted, with the check behind each.
    const claims: AccountClaim[] = [];
    for (const id of scope) {
      const c = p.claim(id);
      if (c === undefined || !["proved", "computed", "refuted", "proved_informal"].includes(c.status)) continue;
      const validation = p.validations(id).filter((v) => v.verdict === "valid" && (c.status === "computed" ? v.method === "repl" : v.method === "kernel_replay" || c.status === "proved_informal")).at(-1)
        ?? p.validations(id).filter((v) => v.verdict === "valid").at(-1);
      const attempt = validation?.attempt_id != null ? p.attempt(validation.attempt_id) : undefined;
      claims.push({
        id,
        statement: clip(c.statement, 200),
        status: c.status,
        checkedBy:
          validation === undefined
            ? "no validation is recorded for it"
            : `${validation.method === "kernel_replay" ? "kernel replay" : "fast Lean check"} ${validation.validation_id} (${validationActor.get(validation.validation_id) ?? "?"})${attempt !== undefined ? `, proof from ${attempt.prover}, attempt ${attempt.attempt_id}` : ""}${validation.negation ? ", of the negation" : ""}`,
        ...(validation !== undefined ? { validationId: validation.validation_id } : {}),
      });
    }

    // Signatures: edges of the scope the team signed. A signature changes no claim's status.
    const signed = scope.flatMap((id) => p.edges({ from: id, statuses: ["human_signed"] })).map((edge) => {
      return { edgeId: edge.edge_id, kind: edge.kind, from: edge.from_id, to: edge.to, by: signedBy.get(edge.edge_id) ?? "?" };
    });

    // The decomposition tree, depth first, and its open leaves.
    const tree: TreeNode[] = [];
    const walk = (id: string, depth: number, path: string[]): void => {
      if (tree.length >= MAX_TREE_NODES) return;
      const c = p.claim(id);
      const children = p.edges({ from: id, kinds: ["decomposes_into"] }).flatMap((edge) => edge.to).filter((to) => p.claim(to) !== undefined && !path.includes(to));
      tree.push({ id, statement: clip(c?.statement ?? id, 120), status: c?.status ?? "unknown", depth, leaf: children.length === 0 });
      for (const child of [...new Set(children)]) walk(child, depth + 1, [...path, id]);
    };
    walk(problem.claim_id, 0, []);
    const openLeaves: OpenLeaf[] = tree
      .filter((node) => node.leaf && node.status === "open")
      .map((node) => ({
        id: node.id,
        statement: node.statement,
        status: node.status,
        tried: strategiesTried(p, node.id),
        forbidden: forbidden.filter((f) => f.claimId === undefined || f.claimId === node.id).map((f) => f.strategy),
      }));

    // Counterexamples, obstructions and conjectures about the claim or its parts.
    const about = (kind: string): RecordLine[] => scope.flatMap((id) => p.nodes(kind, id)).map(recordLine);
    const counterexamples = about("counter_model");
    const obstructions = about("obstruction");
    const conjectures = about("conjecture");

    // What runs next: the tasks still open, or the sentence that says nothing does.
    const open = p.tasks({ problemId: problem.problem_id }).filter((task) => !["done", "failed", "cancelled"].includes(task.status));
    const next = problem.finished_seq !== null ? [] : open.slice(0, MAX_PER_LIST).map(taskLine);
    if (problem.finished_seq === null && next.length === 0) next.push("no task is open: the next turn plans the problem again");

    problems.push({
      problemId: problem.problem_id,
      target: problem.target,
      claimId: problem.claim_id,
      state: problem.outcome ?? (waitingSet.has(problem.problem_id) || (end === undefined && attemptsOfProblem.length === 0) ? "waiting" : "in progress"),
      claimStatus,
      ...(problem.reason !== null ? { reason: clip(problem.reason, 300) } : {}),
      history: history.slice(-MAX_PER_LIST),
      attempts: attemptsOfProblem.length,
      sessionsStoppedByTurn: turnStopped,
      spendUsd: p.problemSpend(problem.problem_id).usd,
      claims,
      signed,
      tree,
      openLeaves,
      counterexamples: counterexamples.slice(0, MAX_PER_LIST),
      obstructions: obstructions.slice(0, MAX_PER_LIST),
      conjectures: conjectures.slice(0, MAX_PER_LIST),
      next,
    });
  }

  // Disagreements between informal validators (PC9): shown whether or not they ended the turn.
  const disagreements = p.nodes(JUDGMENT_KIND).filter((node) => object(node.data)?.disagreement === true);

  // What the team is asked to do.
  const asked: string[] = [];
  const bp = end?.breakpoint;
  if (bp?.kind === "impasse" && bp.problemId !== undefined) asked.push(`Problem ${bp.problemId} is at an impasse: a hint (harness hint --claim), a steer (drop it, forbid a strategy) or a signature may unblock it.`);
  if (bp?.kind === "settled" && bp.problemId !== undefined) asked.push(`Problem ${bp.problemId} is settled: read its claims and their checks below, and sign the edges you accept (harness sign).`);
  if (bp?.kind === "disagreement") asked.push(`Two informal validators disagree (${bp.nodeId ?? "see the judgment"}): decide which reading is right (harness hint, or harness sign on the edge in question).`);
  if (end !== undefined && ["tokens", "usd", "minutes"].includes(end.reason)) asked.push(`The turn's ${end.reason} limit was reached: set the next turn's limit (harness steer --turn-limit) or resume as it is.`);
  if (end !== undefined && end.waiting.length === 0) asked.push("Nothing waits: the run is over.");
  for (const node of disagreements.slice(0, 3)) if (bp?.nodeId !== node.node_id) asked.push(`Informal validators disagree about ${node.claim_id ?? node.node_id} (${node.node_id}).`);

  // Records the account does not read.
  const unknownKinds: Record<string, number> = {};
  const kinds = new Map<string, number>();
  for (const event of events) if (event.type === "node.recorded") kinds.set(event.data.kind, (kinds.get(event.data.kind) ?? 0) + 1);
  for (const [kind, n] of [...kinds].sort(([a], [b]) => (a < b ? -1 : 1))) if (!READ_KINDS.has(kind)) unknownKinds[kind] = n;

  const total = p.totalSpend();
  const limit = record.limit;
  const next = nextLimit(events, consortium ?? { limit: {}, impasse: { posteriorBelow: 0.1, minAttempts: 8 }, narrative: false });
  const turnSpend = record.end?.spent.turn;
  const narrativeHash = record.end?.narrative?.hash;
  const narrativeText = narrativeHash !== undefined ? options.blob?.(narrativeHash) : undefined;
  const last = events.at(-1);
  return {
    version: 1,
    runId: started.data.runId,
    turn,
    journal: { events: events.length, head: last?.hash ?? "" },
    ended: end === undefined ? null : { reason: end.reason, detail: end.detail, minutes: record.end?.minutes ?? 0, ...(end.breakpoint !== undefined ? { breakpoint: end.breakpoint } : {}) },
    limit: { ...limit, source: record.source },
    summary: {
      problems: problems.length,
      proved: problems.filter((x) => x.state === "proved").length,
      refuted: problems.filter((x) => x.state === "refuted").length,
      candidates: problems.filter((x) => x.state === "candidate" || x.claimStatus === "computed").length,
      waiting: end?.waiting ?? problems.filter((x) => x.state === "waiting" || x.state === "in progress").map((x) => x.problemId),
      asked,
    },
    spend: {
      turn: turnSpend === undefined ? null : { usd: turnSpend.usd, tokens: turnSpend.inputTokens + turnSpend.outputTokens },
      run: { usd: total.usd, inputTokens: total.inputTokens, outputTokens: total.outputTokens },
      ...(budgetUsd !== undefined ? { budgetUsd, leftUsd: Math.max(0, budgetUsd - total.usd) } : {}),
    },
    problems,
    team: {
      hints: p.nodes(HINT_KIND).length,
      signatures,
      steers: p.nodes(STEER_KIND).length,
      since,
    },
    nextTurn: { limit: next.limit, source: next.source },
    unknownKinds,
    ...(narrativeText !== undefined && narrativeHash !== undefined ? { narrative: { text: narrativeText, hash: narrativeHash, modelWritten: true as const } } : {}),
    ...(record.end?.narrative?.rejected !== undefined ? { narrativeRefused: record.end.narrative.rejected } : {}),
  };
}

function taskLine(task: TaskRow): string {
  return `${task.kind} task ${task.task_id} (${task.status})${task.title !== null ? `: ${clip(task.title, 120)}` : ""}${task.status === "blocked" && task.blocked_by !== null ? `, blocked by ${task.blocked_by.join(", ")}` : ""}`;
}

/** The strategies tried on a claim, each with how its attempts went and how the last failure failed. */
function strategiesTried(p: Projection, claimId: string): StrategyTried[] {
  const groups = new Map<string, StrategyTried>();
  for (const attempt of p.attempts(claimId)) {
    if (attempt.finished_seq === null) continue;
    const strategy = attempt.strategy ?? attempt.declared_strategy ?? "unlabeled";
    const key = `${attempt.subgoal ?? ""}\u0000${strategy}`;
    const group = groups.get(key) ?? { strategy, attempts: 0, outcomes: {}, ...(attempt.subgoal !== null ? { subgoal: attempt.subgoal } : {}) };
    group.attempts += 1;
    const outcome = attempt.outcome ?? "unknown";
    group.outcomes[outcome] = (group.outcomes[outcome] ?? 0) + 1;
    if (outcome !== "valid") {
      const how = [attempt.failure_class, attempt.failure_detail, attempt.error, attempt.stopped_by !== null ? `ended by ${attempt.stopped_by}` : undefined].filter((x): x is string => x != null && x !== "");
      group.lastFailure = clip(how.join("; "), 200);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

function money(usd: number): string {
  return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
}

function counts(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return entries.map(([k, n]) => `${n} ${k}`).join(", ");
}

function limitText(limit: { tokens?: number; usd?: number; minutes?: number }): string {
  const parts = [limit.tokens !== undefined ? `${limit.tokens} tokens` : "", limit.usd !== undefined ? `$${limit.usd}` : "", limit.minutes !== undefined ? `${limit.minutes} minutes` : ""].filter((x) => x !== "");
  return parts.length === 0 ? "no limit (only the breakpoints end a turn)" : parts.join(", ");
}

/** The account as the team reads it. */
export function renderAccount(a: Account): string {
  const lines: string[] = [];
  lines.push(`# Turn ${a.turn} of run ${a.runId}`, "");
  lines.push(`This account is built from the journal alone, with no model call (journal head: ${a.journal.events} events, hash \`${a.journal.head.slice(0, 16)}\`). Lean is the judge: nothing here changes a claim's status, and nothing you answer will.`, "");
  lines.push("## Summary", "");
  lines.push(`- Why the turn ended: **${a.ended?.reason ?? "it has not ended"}**${a.ended !== null ? ` - ${a.ended.detail}` : ""}.`);
  lines.push(`- The turn's limit was ${limitText(a.limit)} (${a.limit.source}).`);
  lines.push(`- Problems: ${a.summary.problems}; proved ${a.summary.proved}, refuted ${a.summary.refuted}, with a candidate ${a.summary.candidates}; ${a.summary.waiting.length} waiting${a.summary.waiting.length > 0 ? ` (${a.summary.waiting.map((id) => `\`${id}\``).join(", ")})` : ""}.`);
  lines.push(
    `- Spend: ${a.spend.turn !== null ? `this turn ${money(a.spend.turn.usd)} (${a.spend.turn.tokens} tokens), ` : ""}the run ${money(a.spend.run.usd)} (${a.spend.run.inputTokens} in, ${a.spend.run.outputTokens} out)` +
      `${a.spend.budgetUsd !== undefined ? `; the run's budget is ${money(a.spend.budgetUsd)}, ${money(a.spend.leftUsd ?? 0)} left` : "; the run has no budget"}.`,
  );
  lines.push(`- The next turn: ${limitText(a.nextTurn.limit)} (${a.nextTurn.source}).`);
  if (a.summary.asked.length > 0) {
    lines.push("", "### What the team is asked", "");
    for (const ask of a.summary.asked) lines.push(`- ${ask}`);
  }
  if (a.narrative !== undefined) {
    lines.push("", "### Narrative (written by a model, not part of the record)", "", `Every id below was checked to exist in this journal. Blob \`${a.narrative.hash.slice(0, 16)}\`.`, "");
    for (const line of a.narrative.text.split("\n")) lines.push(`> ${line}`);
  } else if (a.narrativeRefused !== undefined) {
    lines.push("", `A model-written narrative was asked for and refused: ${a.narrativeRefused}`);
  }

  for (const x of a.problems) {
    lines.push("", `## ${x.target}`, "");
    lines.push(`Problem \`${x.problemId}\`, claim \`${x.claimId}\`. State: **${x.state}**; the claim is **${x.claimStatus}**.${x.reason !== undefined ? ` ${x.reason}` : ""}`);
    lines.push(`${plural(x.attempts, "attempt")} so far, ${money(x.spendUsd)} spent${x.sessionsStoppedByTurn > 0 ? `; ${plural(x.sessionsStoppedByTurn, "session")} stopped by the turn, with notes and sketch kept` : ""}.`);
    lines.push("", "### How it got here", "");
    if (x.history.length === 0) lines.push("- The claim has not changed status.");
    for (const h of x.history) lines.push(`- ${h}`);
    lines.push("", "### Claims proved, computed and refuted", "");
    if (x.claims.length === 0) lines.push("- None.");
    for (const c of x.claims) lines.push(`- \`${c.id}\` **${c.status}**: ${c.statement}. Checked by ${c.checkedBy}.`);
    for (const s of x.signed) lines.push(`- Signed by ${s.by}: edge \`${s.edgeId}\` (${s.kind}) from \`${s.from}\` to ${s.to.map((t) => `\`${t}\``).join(", ")}. A signature does not propagate and changes no claim's status.`);
    lines.push("", "### Decomposition", "");
    if (x.tree.length <= 1) lines.push("- The claim has not been decomposed.");
    else for (const n of x.tree) lines.push(`${"  ".repeat(n.depth)}- \`${n.id}\` ${n.status}${n.leaf ? " (leaf)" : ""}: ${n.statement}`);
    lines.push("", "### Open leaves and what was tried", "");
    if (x.openLeaves.length === 0) lines.push("- No open leaf.");
    for (const leaf of x.openLeaves) {
      lines.push(`- \`${leaf.id}\`: ${leaf.statement}`);
      if (leaf.forbidden.length > 0) lines.push(`  - The team forbids: ${leaf.forbidden.join(", ")}.`);
      if (leaf.tried.length === 0) lines.push("  - No strategy has been tried yet.");
      for (const t of leaf.tried) {
        lines.push(`  - ${t.subgoal !== undefined ? `on ${clip(t.subgoal, 60)}: ` : ""}\`${t.strategy}\`, ${plural(t.attempts, "attempt")} (${counts(t.outcomes)})${t.lastFailure !== undefined ? `; the last failed: ${t.lastFailure}` : ""}`);
      }
    }
    lines.push("", "### Counterexamples and obstructions", "");
    if (x.counterexamples.length + x.obstructions.length === 0) lines.push("- None recorded.");
    for (const r of [...x.counterexamples, ...x.obstructions]) lines.push(`- ${r.kind} \`${r.id}\`${r.claimId !== undefined ? ` on \`${r.claimId}\`` : ""}: ${r.text}`);
    lines.push("", "### Conjectures and their evidence", "");
    if (x.conjectures.length === 0) lines.push("- None recorded.");
    for (const r of x.conjectures) lines.push(`- \`${r.id}\`${r.claimId !== undefined ? ` on \`${r.claimId}\`` : ""}: ${r.text}`);
    lines.push("", "### What runs next", "");
    if (x.next.length === 0) lines.push(x.state === "proved" || x.state === "refuted" || x.state === "candidate" || x.state === "unsolved" ? "- Nothing: the problem has its outcome." : "- Nothing is planned.");
    for (const n of x.next) lines.push(`- ${n}`);
  }

  lines.push("", "## The team's answers", "");
  lines.push(`So far: ${plural(a.team.hints, "hint")}, ${plural(a.team.signatures, "signature")}, ${plural(a.team.steers, "steer")}.`);
  for (const s of a.team.since) lines.push(`- Since the turn before: ${s.kind} by ${s.by}: ${s.text}`);
  lines.push("", "Answer with `harness hint <runDir> --claim ID \"text\"`, `harness sign <runDir> EDGE_ID`, `harness steer <runDir> ...`, then `harness resume <runDir>`. Several people may answer before one resumes.");
  if (Object.keys(a.unknownKinds).length > 0) {
    lines.push("", "## Records this account does not read", "", `The journal holds records of kinds this account has no section for: ${counts(a.unknownKinds)}. They are in the journal.`);
  }
  return `${lines.join("\n")}\n`;
}

/** Writes `turns/<n>/report.md` and `report.json` in a run directory, from its journal alone. */
export function writeAccount(dir: string, turn: number): Account {
  const events = readEvents(join(dir, "journal.jsonl"));
  const blobs = new BlobStore(join(dir, "blobs"));
  const account = buildAccount(events, turn, { blob: (hash) => blobs.get(hash) });
  const out = join(dir, "turns", String(turn));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.json"), `${JSON.stringify(account, null, 2)}\n`);
  writeFileSync(join(out, "report.md"), renderAccount(account));
  return account;
}

// ---------------------------------------------------------------------------------------------
// The narrative: an optional text a model writes about the turn, from the account alone.

/** One model call, as the run makes it: the answer's text and what it cost. */
export type NarrativeCall = (request: { system: string; prompt: string; maxTokens: number }) => Promise<{ text: string; modelCallId: string }>;

const NARRATIVE_WORDS = 250;

/** The narrative's own budget, in dollars: a short text from one or two calls. */
export const NARRATIVE_USD = 0.25;

/** The site of the narrative's model call in the journal, so that the report shows what it cost. */
export const SITE_TURN_NARRATIVE = "turn.narrative";

/**
 * The narrative's model call: one response, charged to `ledger` (a child of the run's, with its own small
 * limit) and journaled as a `model_call.finished` of the orchestrator at the site `turn.narrative`. It
 * is made after the turn's gate has closed, since the narrative describes a turn that is over, and the
 * turn counts what it costs because it is written before `turn.ended`.
 */
export function narrativeCall(o: {
  journal: Journal;
  blobs: BlobStore;
  models: Models;
  model: Model<Api>;
  name: string;
  thinkingLevel: ThinkingLevel;
  ledger: Ledger;
  signal?: AbortSignal | undefined;
}): NarrativeCall {
  return async (request) => {
    if (o.ledger.exhausted) throw new Error("the narrative's budget is spent");
    const modelCallId = newId("mc");
    const requestHash = o.blobs.putJson({ model: o.name, system: request.system, prompt: request.prompt, maxTokens: request.maxTokens });
    const started = performance.now();
    const options: SimpleStreamOptions = {
      maxTokens: request.maxTokens,
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
      ...(o.thinkingLevel !== "off" ? { reasoning: o.thinkingLevel as NonNullable<SimpleStreamOptions["reasoning"]> } : {}),
    };
    const message = await o.models.completeSimple(
      o.model,
      { systemPrompt: request.system, messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }] },
      options,
    );
    const cost = messageCost(o.model, message);
    o.ledger.charge(cost);
    const answer = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
    const outcome = message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "ok";
    o.journal.emit(
      "model_call.finished",
      {
        modelCallId,
        line: "orchestrator",
        model: o.name,
        outcome,
        site: SITE_TURN_NARRATIVE,
        requestHash,
        ...(outcome === "ok" ? { responseHash: o.blobs.put(answer) } : {}),
        ...(outcome !== "ok" ? { error: (message.errorMessage ?? `the model's answer was ${outcome}`).slice(0, 1000) } : {}),
        durationMs: Math.round(performance.now() - started),
        usd: cost.usd,
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        ...(cost.cachedInputTokens !== undefined ? { cachedInputTokens: cost.cachedInputTokens } : {}),
      },
      "orchestrator",
    );
    if (outcome !== "ok") throw new Error(`the narrative's model call failed: ${message.errorMessage ?? outcome}`);
    return { text: answer, modelCallId };
  };
}

/** Whether an id names something in the journal: a claim, edge, node, problem, attempt, validation or task. */
export function idResolves(p: Projection, id: string): boolean {
  const text = id.trim();
  return (
    p.claim(text) !== undefined ||
    p.edge(text) !== undefined ||
    p.node(text) !== undefined ||
    p.problem(text) !== undefined ||
    p.attempt(text) !== undefined ||
    p.validation(text) !== undefined ||
    p.task(text) !== undefined
  );
}

const BARE_ID = /\b[a-z]{2,8}_[0-9A-Z]{26}\b/g;

/**
 * The ids and references of a narrative that name nothing in the journal (M6's citation check, here
 * against the journal's ids): a `[cite: ID]` whose id does not exist, an id written bare that does not
 * exist, a literature reference (an identifier or an appeal to a known result), or a marker with no id.
 * Empty when the narrative is sound.
 */
export function unresolvedInNarrative(p: Projection, narrative: string): string[] {
  const bad: string[] = [];
  for (const reference of referencesIn(narrative)) {
    if (reference.kind !== "marker" || reference.text === "" || !idResolves(p, reference.text)) bad.push(reference.text === "" ? "[cite: ]" : reference.text);
  }
  for (const match of narrative.matchAll(BARE_ID)) if (!idResolves(p, match[0])) bad.push(match[0]);
  return [...new Set(bad)];
}

/**
 * A model's narrative of the turn, with its own small budget (the caller's call is charged to the run, so
 * the turn counts it). The model sees the account and nothing else; every id it cites must resolve, and
 * it gets one chance to correct itself. Returns the blob to record, or why none was kept.
 */
export async function turnNarrative(o: {
  journal: Journal;
  turn: number;
  ending: Ending;
  call: NarrativeCall;
  keep: (text: string) => string;
  log?: (message: string) => void;
}): Promise<{ hash?: string; rejected?: string }> {
  const events = readEvents(o.journal.log.path);
  const account = buildAccount(events, o.turn, { ending: o.ending });
  const p = projectionOf(events);
  const system =
    `You write a short narrative of one turn of a mathematical research run for the research team, from the account you are given and nothing else. ` +
    `At most ${NARRATIVE_WORDS} words, plain prose. Every sentence that speaks of a claim, edge, node, attempt, problem, validation or task cites the id the account gives it as [cite: ID]. ` +
    `Never cite the literature and never invent an id. Say a claim is proved or refuted only when the account gives that status. You may say what the team might consider, but you decide nothing.`;
  const prompt = renderAccount(account).slice(0, 14_000);
  let feedback = "";
  for (let tries = 0; tries < 2; tries++) {
    const answer = await o.call({ system, prompt: `${prompt}${feedback}`, maxTokens: 1200 });
    const text = answer.text.trim();
    if (text === "") {
      feedback = "\n\nYour last answer was empty. Write the narrative.";
      continue;
    }
    const unresolved = unresolvedInNarrative(p, text);
    if (unresolved.length === 0) return { hash: o.keep(text) };
    feedback = `\n\nYour last narrative cited ${unresolved.slice(0, 8).join(", ")}, which name nothing in this journal. Cite only ids that appear in the account, as [cite: ID], and no literature.`;
    o.log?.(`the turn's narrative cited ${unresolved.length} id(s) that do not exist: ${tries === 0 ? "asking again" : "it is left out"}`);
    if (tries === 1) return { rejected: `it cited ${unresolved.slice(0, 8).join(", ")}, which resolve to nothing in the journal` };
  }
  return { rejected: "the model gave no narrative" };
}

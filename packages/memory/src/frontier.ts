import type { Json } from "@seshat/core";
import { ACCEPTED_LEMMAS_KIND } from "./card.ts";
import { normalizeDetail } from "./obstruction.ts";
import type { Attempt, Claim, Edge, MemoryNode, MemoryStore } from "./store.ts";

/**
 * The verified frontier (plan change LH1, documentation/frontier.md): everything a run has established about a problem, a projection of the
 * journal computed by code with no model call, no clock and no randomness, so the same journal gives the same frontier, byte for byte.
 * It is the progress meter of a long run (what Lean accepted, and what it cost), read by the state card, the account, the report and
 * the plateau rule. It never changes a claim's status, and an `evidence` entry is never a status: it is shown as evidence wherever it is.
 *
 * What the journal shows today: subclaims (parts joined by `decomposes_into` that are `computed` or `proved`, and the `aux_` lemmas of the
 * `accepted_lemmas` nodes), cases and variants (proved claims joined to the target by a variant edge), reductions (`lean_checked`
 * `implies` edges into the target or a subclaim), dead ends (refuted subclaims and variants, and `lean_checked` `refuted_by` edges to a
 * counter-model), evidence (the `hygiene` nodes `plausible` with no counterexample and test lemmas that passed, and `datatable` nodes)
 * and `best` (the `search_result` nodes of M16). What it cannot show yet: a counter-model search that found none (M11 records a
 * `counter_model` node only for an object it found, and nothing for a battery that found none), so that evidence is missing.
 */

export const FRONTIER_KINDS = ["subclaim", "case", "variant", "reduction", "dead_end", "evidence", "best"] as const;
export type FrontierKind = (typeof FRONTIER_KINDS)[number];

/** The default weights of the score: every entry 1, a reduction or a subclaim 3, evidence 0.5, a dead end 1. */
export const FRONTIER_WEIGHTS: Readonly<Record<FrontierKind, number>> = { subclaim: 3, case: 1, variant: 1, reduction: 3, dead_end: 1, evidence: 0.5, best: 1 };

/** The node kinds the frontier reads (their names, since the packages that own them depend on this one). */
const HYGIENE_KIND = "hygiene";
const DATATABLE_KIND = "datatable";
const SEARCH_RESULT_KIND = "search_result";
const SEARCH_SPEC_KIND = "search_spec";

const STATEMENT_CHARS = 160;
const DETAIL_CHARS = 200;

/** Where an entry comes from: the journal's event sequence numbers, and who made the record when the journal says (an attempt's prover, a claim's origin). */
export interface FrontierProvenance {
  seqs: number[];
  actor?: string;
}

export interface FrontierEntry {
  kind: FrontierKind;
  /** A claim id, a lemma name, an edge id or a node id. */
  id: string;
  /** The statement, short and normalised (a lemma's name for a lemma). */
  statement: string;
  detail?: string;
  /** The claim's status for an entry that is a claim; absent for the others. */
  status?: string;
  /** Dollars and milliseconds the journal has for the entry (the attempts behind it); absent when it has none. */
  usd?: number;
  ms?: number;
  /** The event the entry was established at: its place in the order of the frontier's growth. */
  seq: number;
  provenance: FrontierProvenance;
  /** True for an `evidence` entry, which is shown as evidence, not proof. */
  evidence: boolean;
}

export interface Frontier {
  claimId: string;
  /** Sorted by (seq, kind, id). */
  entries: FrontierEntry[];
  score: number;
  counts: Record<FrontierKind, number>;
}

export interface FrontierOptions {
  /** Weights by kind, over `FRONTIER_WEIGHTS`. */
  weights?: Partial<Record<FrontierKind, number>>;
}

export interface GrowthPoint {
  /** Dollars the attempts on the problem's claims had cost when the entries of this point were established. */
  usd: number;
  score: number;
  seq: number;
}

const clip = (text: string, chars: number): string => (text.length <= chars ? text : `${text.slice(0, chars - 1)}…`);
const objectOf = (data: Json): Record<string, Json> | undefined => (data !== null && typeof data === "object" && !Array.isArray(data) ? data : undefined);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const VARIANT_EDGES = ["special_case_of", "instance_of", "strengthens", "equiv", "negation_of"] as const;

/** The weights in force: the defaults, then the options (a weight that is not a finite non-negative number is ignored). */
export function frontierWeights(options: FrontierOptions = {}): Record<FrontierKind, number> {
  const weights = { ...FRONTIER_WEIGHTS };
  for (const kind of FRONTIER_KINDS) {
    const w = options.weights?.[kind];
    if (typeof w === "number" && Number.isFinite(w) && w >= 0) weights[kind] = w;
  }
  return weights;
}

/** The weighted count of entries. */
export function frontierScore(entries: readonly FrontierEntry[], options: FrontierOptions = {}): number {
  const weights = frontierWeights(options);
  return entries.reduce((sum, e) => sum + weights[e.kind], 0);
}

function sum(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0);
}

/** The target's subclaims: the parts of its `decomposes_into` edges, and theirs, breadth first, without the target itself. */
function subclaimIds(store: MemoryStore, claimId: string): string[] {
  const found: string[] = [];
  const seen = new Set([claimId]);
  const queue = [claimId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const edge of store.edges({ from: id, kinds: ["decomposes_into"] })) {
      for (const part of edge.to) {
        if (seen.has(part) || store.claim(part) === undefined) continue;
        seen.add(part);
        found.push(part);
        queue.push(part);
      }
    }
  }
  return found;
}

/** The entry of a claim with a status: its statement, the attempts on it as cost, its first event and its origin as provenance. */
function claimEntry(store: MemoryStore, kind: FrontierKind, claim: Claim, extra: { detail?: string; seqs?: number[] } = {}): FrontierEntry {
  const attempts = store.attempts(claim.claimId);
  const usd = sum(attempts.map((a) => a.usd));
  const ms = sum(attempts.map((a) => a.durationMs));
  const seq = Math.max(claim.updatedSeq, ...(extra.seqs ?? []));
  return {
    kind,
    id: claim.claimId,
    statement: clip(normalizeDetail(claim.statement), STATEMENT_CHARS),
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    status: claim.status,
    ...(usd !== undefined ? { usd } : {}),
    ...(ms !== undefined ? { ms } : {}),
    seq,
    provenance: { seqs: [...new Set([claim.updatedSeq, ...(extra.seqs ?? [])])].sort((a, b) => a - b), actor: claim.origin },
    evidence: false,
  };
}

function attemptCost(attempt: Attempt | undefined): { usd?: number; ms?: number } {
  return attempt === undefined ? {} : { ...(attempt.usd !== undefined ? { usd: attempt.usd } : {}), ...(attempt.durationMs !== undefined ? { ms: attempt.durationMs } : {}) };
}

/** The variants of a target: claims joined to it by a variant edge, either way, with the edge. */
function variantsOf(store: MemoryStore, claimId: string): Array<{ claim: Claim; edge: Edge; special: boolean }> {
  const out: Array<{ claim: Claim; edge: Edge; special: boolean }> = [];
  const seen = new Set<string>();
  const add = (id: string, edge: Edge, special: boolean): void => {
    const claim = store.claim(id);
    if (claim === undefined || id === claimId || seen.has(id)) return;
    seen.add(id);
    out.push({ claim, edge, special });
  };
  for (const edge of store.edges({ to: claimId, kinds: VARIANT_EDGES })) add(edge.from, edge, edge.kind === "special_case_of" || edge.kind === "instance_of");
  for (const edge of store.edges({ from: claimId, kinds: VARIANT_EDGES })) for (const id of edge.to) add(id, edge, false);
  return out;
}

/**
 * The frontier of a claim, read from the memory as it stands. A pure function of the store: the same journal gives the same entries in the
 * same order. A kind the journal cannot show returns no entries. Undefined entries never appear: an unknown claim has an empty frontier.
 */
export function frontier(store: MemoryStore, claimId: string, options: FrontierOptions = {}): Frontier {
  const entries: FrontierEntry[] = [];
  const target = store.claim(claimId);
  const counts = Object.fromEntries(FRONTIER_KINDS.map((k) => [k, 0])) as Record<FrontierKind, number>;
  if (target === undefined) return { claimId, entries, score: 0, counts };
  const taken = new Set<string>([claimId]);
  const subs = subclaimIds(store, claimId);
  const scope = [claimId, ...subs];

  // Subclaims that Lean has accepted, and the dead ends among them.
  for (const id of subs) {
    const claim = store.claim(id) as Claim;
    taken.add(id);
    if (claim.status === "computed" || claim.status === "proved") entries.push(claimEntry(store, "subclaim", claim));
    else if (claim.status === "refuted") entries.push(claimEntry(store, "dead_end", claim, { detail: "refuted by Lean" }));
  }

  // The `aux_` lemmas Lean accepted: each once, at the first check that accepted it.
  const lemmaAt = new Map<string, { node: MemoryNode; claim: string }>();
  for (const id of scope) {
    for (const node of store.nodes(ACCEPTED_LEMMAS_KIND, { claimId: id })) {
      const names = objectOf(node.data)?.names;
      if (!Array.isArray(names)) continue;
      for (const name of names) if (typeof name === "string" && /^[\p{L}_][\p{L}\p{N}_'.!?₀-₉]*$/u.test(name) && !lemmaAt.has(`${id}\u0000${name}`)) lemmaAt.set(`${id}\u0000${name}`, { node, claim: id });
    }
  }
  const attemptsById = new Map<string, Attempt>();
  for (const id of scope) for (const a of store.attempts(id)) attemptsById.set(a.attemptId, a);
  for (const [key, { node, claim }] of lemmaAt) {
    const name = key.slice(claim.length + 1);
    const attemptId = objectOf(node.data)?.attemptId;
    const attempt = typeof attemptId === "string" ? attemptsById.get(attemptId) : undefined;
    entries.push({
      kind: "subclaim",
      id: name,
      statement: name,
      detail: "an aux_ lemma Lean accepted",
      ...attemptCost(attempt),
      seq: node.createdSeq,
      provenance: { seqs: [node.createdSeq], ...(attempt !== undefined ? { actor: attempt.prover } : {}) },
      evidence: false,
    });
  }

  // Cases and variants proved, with their edge to the target; refuted ones are dead ends.
  for (const { claim, edge, special } of variantsOf(store, claimId)) {
    if (taken.has(claim.claimId)) continue;
    taken.add(claim.claimId);
    const how = `${edge.kind} edge ${edge.edgeId} (${edge.status})`;
    if (claim.status === "proved") entries.push(claimEntry(store, special ? "case" : "variant", claim, { detail: how, seqs: [edge.createdSeq] }));
    else if (claim.status === "refuted") entries.push(claimEntry(store, "dead_end", claim, { detail: `a variant refuted by Lean; ${how}`, seqs: [edge.createdSeq] }));
  }

  // Reductions: a Lean-checked implication into the target or a subclaim. Counter-models Lean checked: dead ends.
  for (const id of scope) {
    for (const edge of store.edges({ to: id, kinds: ["implies"], minStatus: "lean_checked" })) {
      const from = store.claim(edge.from);
      const attempt = edge.attemptId !== undefined ? attemptsById.get(edge.attemptId) : undefined;
      entries.push({
        kind: "reduction",
        id: edge.edgeId,
        statement: clip(`${normalizeDetail(from?.statement ?? edge.from)} implies ${normalizeDetail(store.claim(id)?.statement ?? id)}`, STATEMENT_CHARS),
        detail: `a Lean-checked implication${edge.link !== undefined ? ` (${edge.link.name})` : ""}`,
        ...attemptCost(attempt),
        seq: edge.updatedSeq,
        provenance: { seqs: [...new Set([edge.createdSeq, edge.updatedSeq])], ...(attempt !== undefined ? { actor: attempt.prover } : {}) },
        evidence: false,
      });
    }
    if (id === claimId) continue;
    for (const edge of store.edges({ from: id, kinds: ["refuted_by"], minStatus: "lean_checked" })) {
      for (const nodeId of edge.to) {
        const node = store.node(nodeId);
        if (node === undefined || node.kind !== "counter_model" || taken.has(nodeId)) continue;
        taken.add(nodeId);
        const description = objectOf(node.data)?.description;
        entries.push({
          kind: "dead_end",
          id: nodeId,
          statement: clip(normalizeDetail(store.claim(id)?.statement ?? id), STATEMENT_CHARS),
          detail: `a counter-model Lean checked${typeof description === "string" ? `: ${clip(description, DETAIL_CHARS)}` : ""}`,
          seq: edge.updatedSeq,
          provenance: { seqs: [...new Set([node.createdSeq, edge.updatedSeq])] },
          evidence: false,
        });
      }
    }
  }

  // Evidence: bounded computations. Never a status.
  for (const id of scope) {
    for (const node of store.nodes(HYGIENE_KIND, { claimId: id })) {
      const d = objectOf(node.data);
      if (d === undefined) continue;
      const okPlausible = d.check === "plausible" && d.result === "no_counterexample";
      const okTests = d.check === "test_lemmas" && d.result === "passed";
      if (!okPlausible && !okTests) continue;
      entries.push({
        kind: "evidence",
        id: node.nodeId,
        statement: okPlausible ? "plausible found no counterexample" : "the first cases hold (test lemmas passed)",
        detail: typeof d.detail === "string" ? clip(normalizeDetail(d.detail), DETAIL_CHARS) : "a bounded check",
        seq: node.createdSeq,
        provenance: { seqs: [node.createdSeq] },
        evidence: true,
      });
    }
    for (const node of store.nodes(DATATABLE_KIND, { claimId: id })) {
      const d = objectOf(node.data);
      if (d === undefined) continue;
      const objects = typeof d.objects === "number" ? d.objects : undefined;
      entries.push({
        kind: "evidence",
        id: node.nodeId,
        statement: `a table of ${objects ?? "some"} ${typeof d.family === "string" ? d.family : "objects"}`,
        detail: "first cases computed; a table proves nothing",
        seq: node.createdSeq,
        provenance: { seqs: [node.createdSeq] },
        evidence: true,
      });
    }
  }

  // The best score of each M16 search, with its witness when Lean certified it.
  const best = new Map<string, FrontierEntry>();
  for (const id of scope) {
    for (const node of store.nodes(SEARCH_RESULT_KIND, { claimId: id })) {
      const d = objectOf(node.data);
      const done = d === undefined ? undefined : objectOf(d.done as Json);
      const found = done === undefined ? undefined : objectOf(done.best as Json);
      if (d === undefined || done === undefined || found === undefined || typeof found.score !== "number") continue;
      const key = `${id}\u0000${typeof d.key === "string" ? d.key : node.nodeId}`;
      const certified = typeof done.verdict === "string" && done.verdict.startsWith("valid");
      const spec = store.nodes(SEARCH_SPEC_KIND, { claimId: id }).find((n) => objectOf(n.data)?.key === d.key);
      const description = objectOf(objectOf(spec?.data ?? null)?.spec as Json)?.description;
      const entry: FrontierEntry = {
        kind: "best",
        id: key.replace("\u0000", ":"),
        statement: clip(`best score ${found.score}${typeof description === "string" ? ` of "${normalizeDetail(description)}"` : ""}`, STATEMENT_CHARS),
        detail: certified ? `its witness${done.witness !== undefined ? ` ${clip(JSON.stringify(done.witness), 80)}` : ""} was certified by Lean` : "its witness is not certified by Lean",
        seq: node.createdSeq,
        provenance: { seqs: [node.createdSeq], actor: "line:M16" },
        evidence: false,
      };
      const prior = best.get(key);
      const priorScore = prior === undefined ? -Infinity : Number(/best score (-?[\d.e+-]+)/.exec(prior.statement)?.[1]);
      if (prior === undefined || found.score > priorScore) best.set(key, entry);
    }
  }
  entries.push(...best.values());

  entries.sort((a, b) => a.seq - b.seq || FRONTIER_KINDS.indexOf(a.kind) - FRONTIER_KINDS.indexOf(b.kind) || compare(a.id, b.id));
  for (const e of entries) counts[e.kind] += 1;
  return { claimId, entries, score: frontierScore(entries, options), counts };
}

/**
 * The score over spend, for the plateau rule (LH3): one point for each event at which the frontier grew, with the dollars the attempts on
 * the problem's claims (the target, its subclaims and variants) had cost by then. The first point is the empty frontier.
 */
export function frontierGrowth(store: MemoryStore, claimId: string, options: FrontierOptions = {}): GrowthPoint[] {
  const f = frontier(store, claimId, options);
  if (store.claim(claimId) === undefined) return [];
  const weights = frontierWeights(options);
  const claims = new Set<string>([claimId, ...subclaimIds(store, claimId), ...variantsOf(store, claimId).map((v) => v.claim.claimId)]);
  const spend: Array<{ seq: number; usd: number }> = [];
  for (const id of [...claims].sort(compare)) for (const a of store.attempts(id)) if (a.finishedSeq !== undefined && a.usd !== undefined) spend.push({ seq: a.finishedSeq, usd: a.usd });
  spend.sort((a, b) => a.seq - b.seq || a.usd - b.usd);
  const usdAt = (seq: number): number => spend.filter((s) => s.seq <= seq).reduce((total, s) => total + s.usd, 0);
  const points: GrowthPoint[] = [{ usd: 0, score: 0, seq: 0 }];
  let score = 0;
  for (const e of f.entries) {
    score += weights[e.kind];
    const last = points[points.length - 1] as GrowthPoint;
    if (last.seq === e.seq) last.score = score;
    else points.push({ usd: usdAt(e.seq), score, seq: e.seq });
  }
  return points;
}

/** The entries to show first: heaviest kind first, then the latest; `evidence` last. */
export function topEntries(f: Frontier, count: number, options: FrontierOptions = {}): FrontierEntry[] {
  const weights = frontierWeights(options);
  return [...f.entries].sort((a, b) => weights[b.kind] - weights[a.kind] || b.seq - a.seq || compare(a.id, b.id)).slice(0, Math.max(0, count));
}

const entryLine = (e: FrontierEntry): string => `${e.kind}: ${e.statement}${e.status !== undefined ? ` [${e.status}]` : ""}`;

/** The frontier's lines for a state card, within `maxChars` characters: the top entries, the rest counted. Empty for an empty frontier. */
export function frontierCardLines(f: Frontier, maxChars: number, options: FrontierOptions = {}): string[] {
  if (f.entries.length === 0 || maxChars < 80) return [];
  const head = `Established so far (${f.entries.length} entries, score ${f.score}; an evidence entry is evidence, not proof):`;
  const lines: string[] = [head];
  let used = head.length + 1;
  const top = topEntries(f, f.entries.length, options);
  let shown = 0;
  for (const e of top) {
    const line = `- ${e.evidence ? "evidence, not proof - " : ""}${entryLine(e)}`;
    const clipped = clip(line, Math.min(220, Math.max(40, maxChars - used - 40)));
    if (used + clipped.length + 1 > maxChars - 30) break;
    lines.push(clipped);
    used += clipped.length + 1;
    shown += 1;
  }
  if (shown < f.entries.length) lines.push(`- and ${f.entries.length - shown} more`);
  return lines;
}

/** The section "Established so far" of a report: the entries Lean accepted, then the evidence apart, labelled. Empty for an empty frontier. */
export function frontierMarkdown(f: Frontier, options: { heading?: string } = {}): string {
  if (f.entries.length === 0) return "";
  const heading = options.heading ?? "## Established so far";
  const established = f.entries.filter((e) => !e.evidence);
  const evidence = f.entries.filter((e) => e.evidence);
  const cost = (e: FrontierEntry): string => (e.usd !== undefined ? ` ($${e.usd.toFixed(2)})` : "");
  const out = [heading, "", `${f.entries.length} entries, score ${f.score}. Nothing here changes a claim's status.`, ""];
  for (const e of established) out.push(`- ${e.kind}: ${e.statement}${e.status !== undefined ? ` [${e.status}]` : ""}${e.detail !== undefined ? ` - ${e.detail}` : ""}${cost(e)}`);
  if (evidence.length > 0) {
    out.push("", "Evidence, not proof:", "");
    for (const e of evidence) out.push(`- ${e.statement}${e.detail !== undefined ? ` - ${e.detail}` : ""}`);
  }
  return `${out.join("\n")}\n`;
}

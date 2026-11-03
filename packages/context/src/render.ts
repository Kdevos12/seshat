import type { EdgeKind, EdgeStatus, ClaimStatus } from "@seshat/core";
import { screenProse } from "@seshat/memory";
import type { Fact } from "./facts.ts";
import type { CitableIds } from "./ids.ts";
import type { Premise } from "./premises.ts";
import { screenLean } from "./screen.ts";
import { estimateTokens } from "./tokens.ts";
import { imports, type Use } from "./access.ts";

/** How the relations among the shown claims are written (plan §13: chosen by A/B on the bench). */
export type Rendering = "list" | "merged" | "table";
export const RENDERINGS: readonly Rendering[] = ["list", "merged", "table"];

export interface RenderOptions {
  /** Show a claim's one-line gloss (screened) beside its statement. */
  gloss: boolean;
  /** Show the status badge of a fact. */
  badges: boolean;
  rendering: Rendering;
  /** The most edges of the graph shown (about 100 for a small model, 200 for a frontier model; set per model). */
  graphEdges: number;
}

export interface ShownEdge {
  kind: EdgeKind;
  status: EdgeStatus;
  from: string;
  to: readonly string[];
}

export interface Lesson {
  nodeId: string;
  scope: string;
  text: string;
}

export interface PrefixInput {
  theorem: string;
  statement: string;
  goalId: string;
  goalGloss?: string;
  facts: readonly Fact[];
  edges: readonly ShownEdge[];
  premises: readonly Premise[];
  /** The modules the problem's header already imports, as `import X` lines. */
  header: string;
  tried: readonly string[];
  lessons: readonly Lesson[];
  ids: CitableIds;
  /** Tokens the prefix may take. */
  budget: number;
  options: RenderOptions;
}

export interface Rendered {
  text: string;
  /** What each section kept of what it was given, for the report and the tests. */
  shown: { facts: number; edges: number; premises: number; tried: number; lessons: number; tokens: number };
}

const STATUS_BADGE: Partial<Record<ClaimStatus, string>> = {
  proved: "proved: Lean's kernel replayed the proof",
  computed: "accepted by Lean's check, not yet replayed by the certifier",
  refuted: "refuted",
};

const USE_NAME: Record<Use, string> = { apply: "apply or exact", rw: "rewrite with", simp: "simp lemma", definition: "definition" };
const USE_ORDER: readonly Use[] = ["apply", "rw", "simp", "definition"];

/** The lines that fit in `allowed` tokens, in order, whole; the heading is paid for once with the first. */
function fit(lines: readonly string[], allowed: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > allowed) break;
    out.push(line);
    used += cost;
  }
  return out;
}

function prose(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const r = screenProse(text, { max });
  return r.ok ? r.text : undefined;
}

function edgeLines(edges: readonly ShownEdge[], name: (claimId: string) => string, style: Rendering): string[] {
  const rows = edges.flatMap((e) => e.to.map((to) => ({ from: name(e.from), kind: e.kind, status: e.status, to: name(to) })));
  if (style === "table") return ["| from | relation | status | to |", "|---|---|---|---|", ...rows.map((r) => `| ${r.from} | ${r.kind} | ${r.status} | ${r.to} |`)];
  if (style === "merged") {
    const groups = new Map<string, { head: string; kind: string; status: string; tails: string[] }>();
    for (const r of rows) {
      const key = `${r.from}\u0000${r.kind}\u0000${r.status}`;
      const g = groups.get(key) ?? { head: r.from, kind: r.kind, status: r.status, tails: [] };
      groups.set(key, g);
      if (!g.tails.includes(r.to)) g.tails.push(r.to);
    }
    return [...groups.values()].map((g) => `${g.head} -${g.kind}[${g.status}]-> ${g.tails.join(", ")}`);
  }
  return rows.map((r) => `${r.from} -${r.kind}[${r.status}]-> ${r.to}`);
}

function premiseLine(p: Premise, id: string, header: string): string | undefined {
  const e = p.entry;
  const signature = screenLean(e.signature, 240);
  if (signature === undefined) return undefined;
  const gloss = prose(e.gloss, 160);
  const standing = e.claimStatus === undefined ? "" : e.claimStatus === "proved" ? " [proved, replayed by the certifier]" : " [accepted by Lean's check, not yet replayed]";
  const needs = e.module !== undefined && !imports(header, e.module) ? ` (needs: import ${e.module})` : "";
  const paste = e.text !== undefined ? " (paste its text into your auxiliary region: expand it)" : "";
  return `${id} [${e.label}] ${e.name} ${signature}${standing}${gloss !== undefined ? ` -- ${gloss}` : ""}${needs}${paste}`;
}

/**
 * The prefix of the packet (plan §4): the sections that the session keeps, in their fixed order: the goal, the useful facts,
 * the candidate premises, what was already tried, the active lessons as drawn. The goal is never cut; the other sections
 * share what is left of `budget` (30%, 35%, 20%, 15%, what one leaves unused going to the next), and an item is whole or
 * left out. Every statement, signature and gloss that came from a model or another run passes the strict screen; one that
 * fails it is left out, not repaired.
 */
export function renderPrefix(i: PrefixInput): Rendered {
  const { ids, options: o } = i;
  const goal = ids.name("C", i.goalId);
  const out: string[] = [];
  const gloss = o.gloss ? prose(i.goalGloss, 200) : undefined;
  out.push(
    `# Goal ${goal}`,
    `Determine whether this holds, and prove it if it does.`,
    "```lean",
    `theorem ${i.theorem} ${i.statement}`,
    "```",
    ...(gloss !== undefined ? [gloss] : []),
    "Items below have ids (C for a claim, L for a premise, A for advice). The tool expand(id) shows one in full and graph_query explores the graph around it.",
  );
  const pool = Math.max(0, i.budget - estimateTokens(out.join("\n")));
  const shown = { facts: 0, edges: 0, premises: 0, tried: 0, lessons: 0, tokens: 0 };
  let left = pool;

  // The sections in turn; each may use its share plus what the sections before it left over.
  const shares = [0.3, 0.35, 0.2, 0.15];
  let spare = 0;
  const spend = (allowed: number, lines: readonly string[], headingCost: number): string[] => {
    const kept = fit(lines, Math.max(0, Math.min(allowed, left) - (lines.length > 0 ? headingCost : 0)));
    const used = kept.reduce((n, l) => n + estimateTokens(l) + 1, 0) + (kept.length > 0 ? headingCost : 0);
    spare = Math.max(0, allowed - used);
    left = Math.max(0, left - used);
    return kept;
  };
  const take = (k: number, lines: readonly string[], heading: string): string[] => {
    const kept = spend(Math.floor((shares[k] as number) * pool) + spare, lines, estimateTokens(heading) + 1);
    return kept.length === 0 ? [] : ["", heading, ...kept];
  };

  // Useful facts.
  const factLines = i.facts.flatMap((f) => {
    const statement = screenLean(f.statement, 300);
    if (statement === undefined) return [];
    const badge = o.badges ? ` [${STATUS_BADGE[f.status] ?? f.status}]` : "";
    const g = o.gloss ? prose(f.gloss, 160) : undefined;
    return [`${ids.name("C", f.claimId)}${badge} ${statement}${g !== undefined ? ` -- ${g}` : ""}`];
  });
  const factsKept = take(0, factLines, "# Useful facts (checked by Lean)");
  shown.facts = Math.max(0, factsKept.length - 2);
  const claimNames = new Map<string, string>([[i.goalId, goal], ...i.facts.map((f) => [f.claimId, ids.name("C", f.claimId)] as [string, string])]);
  const keptNames = new Set(factsKept.flatMap((l) => /^(C\d+)\b/.exec(l)?.[1] ?? []).concat(goal));
  const between = i.edges.filter((e) => keptNames.has(claimNames.get(e.from) ?? "") && e.to.every((t) => keptNames.has(claimNames.get(t) ?? ""))).slice(0, Math.max(0, o.graphEdges));
  const edgeText = shown.facts === 0 ? [] : edgeLines(between, (id) => claimNames.get(id) as string, o.rendering);
  // The graph is shown from what the facts left over; an edge line is whole or left out.
  const edgesKept = edgeText.length === 0 ? [] : spend(spare, ["Relations among them and the goal:", ...edgeText], 0);
  shown.edges = edgesKept.length <= 1 ? 0 : Math.min(between.length, edgesKept.length - 1);
  out.push(...factsKept, ...edgesKept);

  // Candidate premises.
  const seeded = i.premises.filter((p) => p.via.every((v) => v === "seed" || v === "neighbour"));
  const plain = i.premises.filter((p) => !seeded.includes(p));
  const premiseLines: string[] = [];
  for (const p of plain) {
    const line = premiseLine(p, ids.name("L", p.entry.id), i.header);
    if (line === undefined) continue;
    premiseLines.push(`${line}${p.via.includes("knn") ? " (used by proofs of similar statements)" : ""} (${p.use === "rw" ? "rewrite" : p.use === "apply" ? "apply" : p.use})`);
  }
  for (const use of USE_ORDER) {
    const group = seeded.filter((p) => p.use === use);
    const lines = group.flatMap((p) => premiseLine(p, ids.name("L", p.entry.id), i.header) ?? []);
    if (lines.length > 0) {
      premiseLines.push(`Suggested by the shape of the goal, to ${USE_NAME[use]}:`, ...lines);
    }
  }
  const premisesKept = take(1, premiseLines, "# Candidate premises (this file, the library, other packages, Mathlib)");
  shown.premises = premisesKept.filter((l) => /^L\d+ /.test(l)).length;
  out.push(...premisesKept);

  const triedKept = take(2, [...i.tried], "# Already tried");
  shown.tried = Math.max(0, triedKept.length - 2);
  out.push(...triedKept);

  const lessonLines = i.lessons.flatMap((l) => {
    const text = prose(l.text, 240);
    return text === undefined ? [] : [`${ids.name("A", l.nodeId)} (${l.scope}) ${text}`];
  });
  const lessonsKept = take(3, lessonLines.length === 0 ? [] : ["Advice from the outcomes of earlier attempts. It is not proved and may be wrong for this problem: Lean's verdicts and the goal decide.", ...lessonLines], "# Active lessons");
  shown.lessons = lessonsKept.filter((l) => /^A\d+ /.test(l)).length;
  out.push(...lessonsKept);

  const text = out.join("\n");
  shown.tokens = estimateTokens(text);
  return { text, shown };
}

export interface TailInput {
  session: number;
  sessions: number;
  request: number;
  aux: string;
  proof: string;
  /** The goals of the holes of the last check; undefined: no check has said. */
  holes?: readonly string[];
  /** What Lean said to the last check, raw. */
  feedback?: string;
  /** What the tools other than lean_check answered to the model's last turn, and nothing older: the packet replaces the history, so this is the one place the model reads them. */
  toolResults?: ReadonlyArray<{ tool: string; text: string; isError?: boolean }>;
  /** The harness's own instruction for this request (the wrap-up), when the last message of the session was one. */
  instruction?: string;
  budgetLeft?: string;
  /** Tokens the tail may take (the file and the holes are never cut). */
  budget: number;
}

const FEEDBACK_NOTE = "(only the last check is shown)";

/**
 * The tail of the packet: the sketch's state (the file's two regions as last checked and the open holes with their goals), the last
 * raw Lean feedback, and the budget left, compiled for each request. The regions and the holes are the prover's own work and are
 * never cut; the feedback is cut to what the budget leaves.
 */
export function renderTail(t: TailInput): string {
  const out: string[] = [`# Where you are`, `Session ${t.session} of at most ${t.sessions}, request ${t.request}.${t.budgetLeft !== undefined ? ` ${t.budgetLeft}` : ""}`];
  out.push("", "# Your file, as last checked", "AUX region:", "```lean", t.aux, "```", "PROOF region:", "```lean", t.proof, "```");
  if (t.holes !== undefined) {
    out.push("", t.holes.length === 0 ? "# Open holes\nThe last check reported no hole." : `# Open holes (${t.holes.length})`);
    t.holes.forEach((goal, k) => out.push(`${k + 1}. ${goal.trim().split("\n").join("\n   ")}`));
  }
  const used = estimateTokens(out.join("\n"));
  if (t.feedback !== undefined) {
    const room = Math.max(200, t.budget - used);
    const chars = Math.floor(room * 3.5);
    const body = t.feedback.length > chars ? `${t.feedback.slice(0, chars)}\n[... ${t.feedback.length - chars} more characters]` : t.feedback;
    out.push("", `# Last Lean feedback ${FEEDBACK_NOTE}`, body);
  }
  if (t.toolResults !== undefined && t.toolResults.length > 0) {
    const each = Math.max(400, Math.floor(((t.budget - used) * 3.5) / t.toolResults.length));
    out.push("", "# Answers to your last tool calls (only the last turn's are shown)");
    for (const r of t.toolResults) out.push(`${r.tool}${r.isError === true ? " (error)" : ""}:`, r.text.length > each ? `${r.text.slice(0, each)}\n[... ${r.text.length - each} more characters]` : r.text);
  }
  if (t.instruction !== undefined) out.push("", t.instruction);
  return out.join("\n");
}

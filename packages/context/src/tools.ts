import { CLAIM_STATUSES, EDGE_KINDS, EDGE_STATUSES } from "@seshat/core";
import { connect, graphQuery, MAX_CONNECT_DEPTH, parseGraphQuery, renderConnection, renderSubgraph, renderSubgraphAs, type PathStyle } from "@seshat/graph";
import type { Entry } from "@seshat/library";
import type { JsonObject, LineTool } from "@seshat/lines";
import { type Edge, type MemoryStore, screenProse } from "@seshat/memory";
import type { LessonRecord } from "@seshat/lessons";
import { imports } from "./access.ts";
import type { CitableIds } from "./ids.ts";
import { parsePattern } from "./pattern.ts";
import type { Rendering } from "./render.ts";
import { ident, moduleName, screenLean } from "./screen.ts";

/** A node with more neighbours than this answers `expand` with its relation kinds and their counts first (PC5 item 4). */
export const HUB = 50;

/** What the two tools read, for one session. */
export interface ToolEnv {
  memory: MemoryStore;
  goalId: string;
  ids: CitableIds;
  /** The premises the packet has shown or the tools have named, by their id in the index. */
  entries: Map<string, Entry>;
  /** Every entry the pattern search may look at (the visible tiers). */
  searchable: () => readonly Entry[];
  lessons: () => readonly LessonRecord[];
  /** The full text of the declarations of the problem's own file, by name. */
  localText: (name: string) => string | undefined;
  header: string;
  rendering: Rendering;
  graphEdges: number;
}

/** The bounds of what a model may ask of `graph_query`, and the most characters of any answer. */
export const MAX_LIMIT = 50;
export const MAX_DEPTH = 4;
export const MAX_ANCHORS = 6;
export const MAX_FROM = 10;
export const MAX_ANSWER_CHARS = 12000;

/** The lines of a proof text that the strict screen accepts; the others (comments, instructions) are replaced. */
export function cleanText(text: string, maxLines = 60): string {
  const lines = text.split("\n").slice(0, maxLines);
  const out = lines.map((l) => (l.trim() === "" ? "" : (screenLean(l, 240) === undefined ? "(line not shown)" : l.replace(/\s+$/, ""))));
  return out.join("\n") + (text.split("\n").length > maxLines ? "\n(more lines not shown)" : "");
}

const bounded = (text: string): string => (text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS)}\n(the answer was cut at ${MAX_ANSWER_CHARS} characters)` : text);

const prose = (text: string | undefined, max: number): string | undefined => {
  if (text === undefined) return undefined;
  const r = screenProse(text, { max });
  return r.ok ? r.text : undefined;
};

/** A claim of an answer with its statement and gloss through the screen: the graph holds text from models and other runs. */
function clean<T extends { statement: string; gloss?: string }>(c: T): T {
  const { gloss, ...rest } = c;
  const g = prose(gloss, 160);
  return { ...rest, statement: screenLean(c.statement, 200) ?? "(not shown)", ...(g !== undefined ? { gloss: g } : {}) } as T;
}

function unknown(env: ToolEnv, name: string): Error {
  const names = env.ids.all();
  const shown = names.slice(0, 40).join(", ");
  return new Error(`no item ${JSON.stringify(name)} in this session. Only ids the packet or a tool answer has shown exist${names.length > 0 ? `: ${shown}${names.length > 40 ? `, and ${names.length - 40} more` : ""}` : ""}.`);
}

function neighbours(env: ToolEnv, claimId: string): Array<{ edge: Edge; other: string; direction: "out" | "in" }> {
  const rows: Array<{ edge: Edge; other: string; direction: "out" | "in" }> = [];
  for (const edge of env.memory.edges({ from: claimId })) for (const to of edge.to) rows.push({ edge, other: to, direction: "out" });
  for (const edge of env.memory.edges({ to: claimId })) rows.push({ edge, other: edge.from, direction: "in" });
  return rows.sort((a, b) => a.edge.createdSeq - b.edge.createdSeq || (a.other < b.other ? -1 : 1));
}

function expandClaim(env: ToolEnv, name: string, claimId: string, kind: string | undefined): string {
  const claim = env.memory.claim(claimId);
  if (claim === undefined) throw unknown(env, name);
  const statement = screenLean(claim.statement, 600) ?? "(the statement did not pass the screen and is not shown)";
  const gloss = prose(claim.gloss, 200);
  const out = [`${name} [${claim.status}] ${statement}`];
  if (gloss !== undefined) out.push(gloss);
  out.push(`kind: ${claim.kind}; origin: ${claim.origin}${name === env.ids.name("C", env.goalId) ? "; this is the goal" : ""}`);
  const all = neighbours(env, claimId);
  if (all.length === 0) return `${out.join("\n")}\nNo relation to another claim is recorded.`;
  if (kind !== undefined && !(EDGE_KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of ${EDGE_KINDS.join(", ")}`);
  if (kind === undefined && all.length > HUB) {
    const counts = new Map<string, number>();
    for (const n of all) counts.set(`${n.edge.kind}\u0000${n.direction}`, (counts.get(`${n.edge.kind}\u0000${n.direction}`) ?? 0) + 1);
    out.push(`${all.length} neighbours: too many to list. Call expand again with kind set to one of these relations.`, "| relation | direction | count |", "|---|---|---|");
    for (const [key, count] of [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))) {
      const [k, d] = key.split("\u0000");
      out.push(`| ${k} | ${d} | ${count} |`);
    }
    return out.join("\n");
  }
  const rows = kind === undefined ? all : all.filter((n) => n.edge.kind === kind);
  const shown = rows.slice(0, HUB);
  out.push(`${rows.length} neighbour${rows.length === 1 ? "" : "s"}${kind !== undefined ? ` by ${kind}` : ""}:`, "| relation | direction | id | edge status | status | statement |", "|---|---|---|---|---|---|");
  for (const n of shown) {
    const other = env.memory.claim(n.other);
    const text = other === undefined ? "" : (screenLean(other.statement, 120) ?? "");
    out.push(`| ${n.edge.kind} | ${n.direction} | ${env.ids.name("C", n.other)} | ${n.edge.status} | ${other?.status ?? "?"} | ${text} |`);
  }
  if (rows.length > shown.length) out.push(`(${rows.length - shown.length} more not shown)`);
  return out.join("\n");
}

function expandPremise(env: ToolEnv, name: string, key: string): string {
  const e = env.entries.get(key);
  if (e === undefined) throw unknown(env, name);
  const out = [`${name} [${ident(e.label)}] ${ident(e.name)}`, `statement: ${screenLean(e.signature, 800) ?? "(it did not pass the screen and is not shown)"}`];
  const gloss = prose(e.gloss, 200);
  if (gloss !== undefined) out.push(gloss);
  if (e.module !== undefined) out.push(imports(env.header, e.module) ? `module: ${moduleName(e.module)} (already imported)` : `needs: import ${moduleName(e.module)}`);
  if (e.claimStatus !== undefined) out.push(e.claimStatus === "proved" ? "status: proved (replayed by the certifier)" : "status: accepted by Lean's check, not yet replayed by the certifier");
  if (e.text !== undefined) out.push("Paste this into your auxiliary region, then use it by name:", "```lean", cleanText(e.text), "```");
  const local = e.source === "local" ? env.localText(e.name) : undefined;
  if (local !== undefined) out.push("As written in the file:", "```lean", cleanText(local), "```");
  return out.join("\n");
}

function expandLesson(env: ToolEnv, name: string, nodeId: string): string {
  const l = env.lessons().find((x) => x.nodeId === nodeId);
  if (l === undefined) throw unknown(env, name);
  const text = prose(l.text, 240) ?? "(the text did not pass the screen and is not shown)";
  return [
    `${name} (${l.scope}${l.scope === "global" ? "" : `: ${prose(l.scopeKey, 60) ?? "?"}`}) ${text}`,
    `type: ${l.type}; learned from ${l.support.length} attempt${l.support.length === 1 ? "" : "s"} on ${l.claims.length} claim${l.claims.length === 1 ? "" : "s"}.`,
    "Advice from the outcomes of earlier attempts. It is not proved and may be wrong for this problem.",
  ].join("\n");
}

function expandEdge(env: ToolEnv, name: string, edgeId: string): string {
  const e = env.memory.edge(edgeId);
  if (e === undefined) throw unknown(env, name);
  const note = e.note === undefined ? undefined : screenLean(e.note, 200);
  return [`${name} ${e.kind} [${e.status}]`, "| from | to |", "|---|---|", `| ${env.ids.name("C", e.from)} | ${e.to.map((t) => env.ids.name("C", t)).join(", ")} |`, ...(note !== undefined ? [`note: ${note}`] : [])].join("\n");
}

/** `expand(id, kind?)` for a name the packet or a tool answer gave. */
export function expandTool(env: ToolEnv): LineTool {
  return {
    journaled: true,
    name: "expand",
    description:
      "Shows one item of your context in full: a claim (C17) with its statement and a table of its neighbours in the graph, a premise or lemma (L4) with its whole statement and what to import or paste, a piece of advice (A2), or an edge (E5). " +
      "A claim with more than 50 neighbours answers with its relation kinds and their counts; call again with `kind` to list one relation. Only ids that your context or a tool answer showed exist.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "An id from your context, such as C17, L4, A2 or E5." },
        kind: { type: "string", enum: [...EDGE_KINDS], description: "For a claim with many neighbours: list the neighbours by this relation." },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const name = typeof args.id === "string" ? args.id.trim() : "";
      if (name === "") throw new Error("expand needs an id, such as C17 or L4");
      const key = env.ids.resolve(name);
      if (key === undefined) throw unknown(env, name);
      const shown = env.ids.kindOf(name) as "C" | "E" | "L" | "A";
      const canonical = name.toUpperCase();
      const kind = typeof args.kind === "string" ? args.kind : undefined;
      if (shown === "C") return expandClaim(env, canonical, key, kind);
      if (shown === "E") return expandEdge(env, canonical, key);
      if (shown === "L") return expandPremise(env, canonical, key);
      return expandLesson(env, canonical, key);
    },
  };
}

function names(env: ToolEnv, value: unknown, what: string): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
  if (list === undefined || list.length === 0) throw new Error(`${what} must be an id or a list of ids`);
  const most = what === "anchors" ? MAX_ANCHORS : MAX_FROM;
  if (list.length > most) throw new Error(`${what} takes at most ${most} ids`);
  return list.map((n) => {
    const key = env.ids.resolve(n);
    if (key !== undefined && env.ids.kindOf(n) === "C") return key;
    throw unknown(env, n);
  });
}

function styleOf(value: unknown, fallback: Rendering): Rendering {
  if (value === undefined) return fallback;
  if (value === "list" || value === "merged" || value === "table") return value;
  throw new Error("style must be list, merged or table");
}

function patternSearch(env: ToolEnv, pattern: string, limit: number): string {
  const p = parsePattern(pattern);
  const claims = env.memory
    .claims({ kind: "formal" })
    .filter((c) => c.status !== "retracted" && p.matches(c.statement))
    .slice(0, limit);
  const entries = env.searchable().filter((e) => p.matches(e.signature) || (p.kind === "constants" && p.matches(`${e.name} ${e.signature}`))).slice(0, limit);
  const lines = [`Pattern (${p.kind}): ${claims.length} claim${claims.length === 1 ? "" : "s"} and ${entries.length} declaration${entries.length === 1 ? "" : "s"} match.`];
  for (const c of claims) lines.push(`${env.ids.name("C", c.claimId)} [${c.status}] ${screenLean(c.statement, 200) ?? "(not shown)"}`);
  for (const e of entries) {
    env.entries.set(e.id, e);
    lines.push(`${env.ids.name("L", e.id)} [${ident(e.label)}${e.claimStatus !== undefined ? `, ${e.claimStatus}` : ""}] ${ident(e.name)} ${screenLean(e.signature, 200) ?? "(not shown)"}`);
  }
  return lines.join("\n");
}

/** `graph_query`: typed path queries, paths that connect several claims, and statement patterns, over the research graph. */
export function graphQueryTool(env: ToolEnv): LineTool {
  return {
    journaled: true,
    name: "graph_query",
    description:
      "Queries the research graph in code. Three forms. (1) A typed path query: `from` (ids from your context, default the goal), `kinds`, `edgeStatuses`, `claimStatuses`, `direction`, `depth`: the claims reached and the edges followed. " +
      "(2) `anchors`: two or more claims; returns the paths (up to three edges) that link them, the best of each pattern of relations. " +
      "(3) `pattern`: a Loogle-style statement pattern: constants (`Nat.succ, Finset.sum`), a shape with metavariables (`?a + ?b = ?b + ?a`), or the shape of a conclusion (`⊢ ?a ∣ ?b`); returns the claims and declarations whose statement matches. " +
      "Every id in an answer exists in the graph and can be given to expand.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "array", items: { type: "string" }, description: "Start claims, by id. Default: the goal." },
        anchors: { type: "array", items: { type: "string" }, description: "Claims to link (two or more): returns the connecting paths." },
        pattern: { type: "string", description: "A statement pattern to search for." },
        kinds: { type: "array", items: { type: "string", enum: [...EDGE_KINDS] }, description: "Follow only edges of these kinds." },
        edgeStatuses: { type: "array", items: { type: "string", enum: [...EDGE_STATUSES] } },
        claimStatuses: { type: "array", items: { type: "string", enum: [...CLAIM_STATUSES] } },
        direction: { type: "string", enum: ["out", "in", "both"] },
        depth: { type: "integer", description: `The longest path in edges (default 2; at most ${MAX_CONNECT_DEPTH} for anchors).` },
        limit: { type: "integer", description: "The most results." },
        style: { type: "string", enum: ["list", "merged", "table"], description: "How the edges are written." },
      },
      additionalProperties: false,
    },
    run: async (args: JsonObject) => {
      const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.min(MAX_LIMIT, Math.floor(args.limit)) : 10;
      const depth = typeof args.depth === "number" && args.depth >= 1 ? Math.min(MAX_DEPTH, Math.floor(args.depth)) : undefined;
      return bounded(await answer(args, limit, depth));
    },
  };

  async function answer(args: JsonObject, limit: number, depth: number | undefined): Promise<string> {
      if (typeof args.pattern === "string") return patternSearch(env, args.pattern, limit);
      const style = styleOf(args.style, env.rendering);
      const shared = {
        ...(Array.isArray(args.kinds) ? { kinds: args.kinds as never } : {}),
        ...(Array.isArray(args.edgeStatuses) ? { edgeStatuses: args.edgeStatuses as never } : {}),
        ...(Array.isArray(args.claimStatuses) ? { claimStatuses: args.claimStatuses as never } : {}),
      };
      if (args.anchors !== undefined) {
        const found = connect(env.memory, { anchors: names(env, args.anchors, "anchors"), ...shared, ...(depth !== undefined ? { depth } : {}) }, env.ids);
        return renderConnection({ ...found, claims: found.claims.map(clean) }, style === "list" ? "chains" : (style satisfies PathStyle), { edges: env.graphEdges, name: (id) => env.ids.name("C", id) });
      }
      const from = args.from === undefined ? [env.goalId] : names(env, args.from, "from");
      const query = parseGraphQuery({ ...args, from, ...(depth !== undefined ? { depth } : { depth: undefined }) } as never, env.goalId);
      const found = graphQuery(env.memory, query, env.ids);
      const capped = { ...found, claims: found.claims.map(clean), edges: found.edges.slice(0, env.graphEdges), truncated: found.truncated || found.edges.length > env.graphEdges };
      return style === "list" ? renderSubgraph(capped) : renderSubgraphAs(capped, style, { name: (id) => env.ids.name("C", id) });
  }
}

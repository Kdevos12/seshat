import type { HarnessEvent } from "@seshat/core";

/**
 * What a run of lines M2 (the graph) and M4 (the context compiler) did, from the journal alone (plan change KG1): the counts the smoke test
 * of the arm `solve-v2-graph` reads. A block exists only for a line that was enabled; a count is what the journal holds and no more.
 * M4's depth widenings are not in the journal, so they are not counted; M2's derived proposals that `validate` accepted are not either.
 */
export interface GraphReport {
  /** Present when M4 ran. */
  context?: {
    /** The packets M4 compiled (one `context_packet` node per attempt) and their size in tokens (prefix and first tail, as the line estimates it). */
    packets: number;
    packetTokens: number;
    /** The facts the packets showed, summed over the packets. */
    factsShown: number;
    /** The provers' calls of M4's two tools. */
    expandCalls: number;
    graphQueryCalls: number;
  };
  /** Present when M2 ran. */
  graph?: {
    /** The claims M2 created (the variants: the negation and what it derived). */
    variants: number;
    /** The edges M2 added, and how many of them are `lean_checked` (added so, or moved there by a valid link lemma). */
    edges: number;
    leanCheckedEdges: number;
  };
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The report's block, or undefined when neither M2 nor M4 was enabled. `lines` are the ids the run's configuration recorded. */
export function graphReport(events: readonly HarnessEvent[], lines: readonly string[] | undefined): GraphReport | undefined {
  const m2 = lines?.includes("M2") === true;
  const m4 = lines?.includes("M4") === true;
  if (!m2 && !m4) return undefined;
  const out: GraphReport = {};
  if (m4) {
    const context = { packets: 0, packetTokens: 0, factsShown: 0, expandCalls: 0, graphQueryCalls: 0 };
    for (const e of events) {
      if (e.type === "node.recorded" && e.data.kind === "context_packet") {
        const data = (typeof e.data.data === "object" && e.data.data !== null && !Array.isArray(e.data.data) ? e.data.data : {}) as Record<string, unknown>;
        const shown = (typeof data.shown === "object" && data.shown !== null ? data.shown : {}) as Record<string, unknown>;
        context.packets += 1;
        context.packetTokens += num(data.prefixTokens) + num(data.tailTokens);
        context.factsShown += num(shown.facts);
      } else if (e.type === "tool_run.started" && e.data.attemptId !== undefined) {
        if (e.data.capability === "expand") context.expandCalls += 1;
        else if (e.data.capability === "graph_query") context.graphQueryCalls += 1;
      }
    }
    out.context = context;
  }
  if (m2) {
    const added = new Map<string, boolean>();
    let variants = 0;
    for (const e of events) {
      if (e.type === "claim.created" && e.actor === "line:M2") variants += 1;
      else if (e.type === "edge.added" && e.actor === "line:M2") added.set(e.data.edgeId, e.data.status === "lean_checked");
      else if (e.type === "edge.status_changed" && added.has(e.data.edgeId)) added.set(e.data.edgeId, e.data.to === "lean_checked");
    }
    out.graph = { variants, edges: added.size, leanCheckedEdges: [...added.values()].filter(Boolean).length };
  }
  return out;
}

/** The report's lines: one for each line that ran. */
export function renderGraphReport(report: GraphReport): string[] {
  return [
    ...(report.context !== undefined
      ? [`Context compiler (M4): ${report.context.packets} packet(s) of ${report.context.packetTokens} token(s) in all, ${report.context.factsShown} fact(s) shown; the provers called expand ${report.context.expandCalls} time(s) and graph_query ${report.context.graphQueryCalls} time(s).`]
      : []),
    ...(report.graph !== undefined ? [`Graph (M2): ${report.graph.variants} variant(s) created, ${report.graph.edges} edge(s) added, ${report.graph.leanCheckedEdges} of them lean_checked.`] : []),
  ];
}

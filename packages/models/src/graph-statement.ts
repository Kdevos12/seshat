import { type Binder, MAX_STATEMENT_LENGTH, splitSignature, TYPE_SORT } from "./statement.ts";

/**
 * A statement about simple graphs that the line can try on small graphs and refute with a graph
 * (CA18): a signature that quantifies over one graph of Mathlib's `SimpleGraph`. The rule, in full
 * (documentation/models.md, "Statements about graphs"):
 *
 * - the text mentions `SimpleGraph`, and is a signature (binders, then `:` and the type) that holds no
 *   token the validator refuses and no `#`, `--` or `/-` (`splitSignature`, the reader of the
 *   statements of magmas and numbers);
 * - the first binder is the type of the vertices, `(V : Type)`, `{V : Type*}`, `(V : Type u)`...;
 * - then come instance binders (`[Fintype V]`, `[DecidableEq V]`...) and exactly one graph binder
 *   `(G : SimpleGraph V)`, with nothing else before it;
 * - after the graph: instance binders (`[DecidableRel G.Adj]`), then hypotheses, which are named
 *   binders `(h : P)` whose type is not a type or a number (a second variable is not tried).
 *
 * Anything else is left alone, with the reason.
 */
export interface GraphStatement {
  kind: "graph";
  /** The name of the type of the vertices, such as `V`. */
  vertexType: string;
  /** The sort of that type as written: `Type`, `Type*`, `Type u`... A sort other than `Type` is a universe parameter (the vertices are then `ULift (Fin n)`). */
  sort: string;
  /** The name of the graph, such as `G`. */
  graph: string;
  /** The arguments of the claim before its hypotheses, in order: the type, the instances, the graph, the instances after it. */
  parameters: Array<{ role: "type" | "instance" | "graph"; /** For an instance: its type, as written. */ type: string; /** True for `DecidableRel G.Adj`, which the proof may supply itself. */ adjacency: boolean }>;
  /** The statement as it was given. */
  text: string;
}

export type GraphRecognition = { statement: GraphStatement } | { reason: string };

const ADJACENCY = /^DecidableRel\s*\(?\s*([\p{L}_][\p{L}\p{N}_'!?]*)\.Adj\s*\)?$/u;

/** Whether a statement is about a graph, and the shape of its binders; or why it is not. */
export function recognizeGraphStatement(text: string): GraphRecognition {
  if (!/\bSimpleGraph\b/u.test(text)) return { reason: "the statement does not mention SimpleGraph" };
  if ([...text].length > MAX_STATEMENT_LENGTH) return { reason: `the statement has more than ${MAX_STATEMENT_LENGTH} characters` };
  const split = splitSignature(text);
  if ("reason" in split) return { reason: split.reason };
  const { binders } = split;
  const first = binders[0] as Binder | undefined;
  if (first === undefined || first.names.length !== 1 || first.bracket === "[" || !TYPE_SORT.test(first.type)) {
    return { reason: "the first binder is not the type of the vertices, such as (V : Type)" };
  }
  const vertexType = first.names[0] as string;
  const parameters: GraphStatement["parameters"] = [{ role: "type", type: first.type, adjacency: false }];
  let graph: string | undefined;
  for (const binder of binders.slice(1)) {
    if (binder.bracket === "[") {
      const adjacency = graph !== undefined && ADJACENCY.exec(binder.type)?.[1] === graph;
      parameters.push({ role: "instance", type: binder.type, adjacency });
      continue;
    }
    const isGraph = binder.type === `SimpleGraph ${vertexType}`;
    if (graph === undefined) {
      if (!isGraph) return { reason: `the binder ${binder.bracket}${binder.names.join(" ")} : ${binder.type} comes before the graph, and only instances of ${vertexType} may` };
      if (binder.names.length !== 1) return { reason: "the statement has more than one graph" };
      graph = binder.names[0] as string;
      parameters.push({ role: "graph", type: binder.type, adjacency: false });
      continue;
    }
    if (isGraph) return { reason: "the statement has more than one graph" };
    if (binder.bracket !== "(" || binder.names.length !== 1) return { reason: `the binder ${binder.bracket}${binder.names.join(" ")} : ${binder.type} is not a hypothesis` };
    if (TYPE_SORT.test(binder.type) || /^(?:ℕ|Nat|ℤ|Int|ℝ|ℚ)$/u.test(binder.type)) return { reason: `${binder.names[0]} is a second variable: only statements about one graph are tried` };
    break;
  }
  if (graph === undefined) return { reason: `no binder (G : SimpleGraph ${vertexType}) before the hypotheses` };
  return { statement: { kind: "graph", vertexType, sort: first.type, graph, parameters, text } };
}

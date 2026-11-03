import type { Json } from "@seshat/core";
import type { MemoryNode, MemoryStore } from "@seshat/memory";
import { Bm25Index } from "./bm25.ts";

/**
 * The schemas of line M15 (documentation/schemas.md): the shapes of closed decompositions, kept in the library with an index of their
 * own. A schema is a typed skeleton, a conclusion and the parts that imply it with variables where problems differ, and the main
 * proof that put the parts together. It is learned from outcomes, not from Lean, so its node is stamped with the run's provenance
 * and a schema shown to a session goes through the randomized inclusion of unverified items (documentation/memory.md). This package
 * owns the kind and the shape of `data`; the line that writes and reads them is `@seshat/scheduler`'s.
 */
export const SCHEMA_KIND = "library_schema";

export type SchemaState = "active" | "inactive" | "superseded";

/** One closed decomposition a schema was made from. */
export type SchemaSupport = {
  problemId: string;
  /** The decomposed claim. */
  claimId: string;
  edgeId: string;
};

/** The data of a `library_schema` node. Variables are written `?1`, `?2`... */
export interface SchemaData {
  /** `schema_<region>_<six digits>`, from the skeleton. */
  name: string;
  /** The statement the parts imply, as a skeleton in signature form. */
  conclusion: string;
  /** The parts, as skeletons in signature form, in the order of the source's holes. */
  parts: string[];
  /** The source's names for its holes (`aux_left`): the main proof names them. */
  names: string[];
  /** The main proof of the source's sketch, as a skeleton: it closes the conclusion once the parts are given as `names`. */
  mainProof: string;
  /** The variables that are a part's own binders, by number, with the name the source gave them. */
  locals: Record<string, string>;
  /** The variables that are the conclusion's own binders; the others stand for subterms that differ between the sources. */
  binderVars: number[];
  /** Strategy family of the main proof, and the cell region (`3p:=`): how many parts and the conclusion's main symbol. */
  family: string;
  region: string;
  /** The decompositions it was made from and how many of them were seen (a schema generalizes several). */
  supports: SchemaSupport[];
  state: SchemaState;
  /** The schemas this one generalizes (they are `superseded`). */
  generalizes?: string[];
  /** Why it left use, when it did. */
  deactivated?: { reason: string };
  gloss: string;
  [key: string]: Json | undefined;
}

export interface SchemaRecord {
  nodeId: string;
  data: SchemaData;
  epoch: number;
}

const asData = (node: MemoryNode): SchemaData => node.data as unknown as SchemaData;

/** Every schema the memory holds, in the order they were made. */
export function allSchemas(memory: MemoryStore): SchemaRecord[] {
  return memory.nodes(SCHEMA_KIND).map((node) => ({ nodeId: node.nodeId, data: asData(node), epoch: node.epoch }));
}

/** The schemas that may be shown: active ones, neither superseded by a generalization nor deactivated by their effect. */
export function usableSchemas(memory: MemoryStore): SchemaRecord[] {
  return allSchemas(memory).filter((s) => s.data.state === "active");
}

/** The text a schema is indexed under: its skeleton without the variables, which say nothing about the shape's words. */
function indexed(data: SchemaData): Record<string, string> {
  const bare = (text: string) => text.replace(/\?\d+/g, " ");
  return { name: data.region, signature: bare(data.conclusion), gloss: `${data.parts.map(bare).join(" ")} ${data.family}` };
}

/** The index of the schemas, a BM25 over the shape of the conclusion (the schemas' own, apart from the lemmas'). */
export class SchemaIndex {
  readonly #bm25: Bm25Index;
  readonly size: number;

  constructor(schemas: readonly SchemaRecord[]) {
    this.#bm25 = new Bm25Index(schemas.map((s) => ({ id: s.nodeId, fields: indexed(s.data) })));
    this.size = schemas.length;
  }

  /** The schemas that share words with the statement, best first. */
  search(statement: string): string[] {
    return this.#bm25.search(statement.replace(/\?\d+/g, " ")).map((r) => r.id);
  }
}

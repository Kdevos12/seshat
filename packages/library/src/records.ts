import type { ClaimStatus, Json } from "@seshat/core";
import type { MemoryNode, MemoryStore } from "@seshat/memory";

/** The node kinds of the library. This package owns them and the shape of their `data`. */
export const LEMMA_KIND = "library_lemma";
export const CANDIDATE_KIND = "library_candidate";
export const USE_KIND = "library_use";

/** Where a promoted lemma came from. */
export type LemmaSource = {
  problemId: string;
  /** The problem's claim. */
  claimId: string;
  attemptId: string;
  /** The name it had in the submission. */
  name: string;
};

/**
 * The data of a `library_lemma` node: a lemma that passed the promotion criteria. Its claim is the
 * lemma's own: the lemma was submitted through `validate`, so the claim is `computed`, and `proved`
 * once the certifier replays it. Nothing here is a status; the node's standing is its claim's.
 */
export interface LemmaData {
  /** The name in the library, `aux_lib_...`. */
  name: string;
  statementId: string;
  /** The lemma's claim. */
  claimId: string;
  /** Signature form. */
  statement: string;
  /** Tactics, without `by`. */
  proof: string;
  doc?: string;
  /** The imports it stands on and nothing else: the reference header of the problem it came from. */
  header: string;
  /** The problem's first domain (`msc:11`), or `general`. */
  domain: string;
  gloss: string;
  source: LemmaSource;
  /** The Mathlib revision (the bench's) the lemma was last compiled under (PE1). */
  mathlibRev?: string;
  /** The Lean environment the run was in when it was promoted. */
  leanEnv?: { name: string; hash: string | null };
  promotedAt?: string;
  /** Set by a compile again: false when it no longer compiles, and the revision it was tried under. */
  stale?: boolean;
  checkedRev?: string;
  [key: string]: Json | undefined;
}

/** Why a candidate was or was not promoted. */
export type CandidateStatus = "pending" | "promoted" | "duplicate" | "trivial" | "unproved";

/** The data of a `library_candidate` node: an auxiliary lemma of an attempt that the library looked at. */
export interface CandidateData {
  status: CandidateStatus;
  reason?: string;
  problemId: string;
  claimId: string;
  attemptId: string;
  name: string;
  statement: string;
  proof: string;
  doc?: string;
  header: string;
  /** The library name, once promoted or found a duplicate of. */
  libraryName?: string;
  [key: string]: Json | undefined;
}

/** The data of a `library_use` node: what a finished attempt's submission used from the library and from other sources. */
export interface UseData {
  attemptId: string;
  claimId: string;
  /** The attempt's outcome: `valid` is a proof the fast check accepted. */
  outcome: string;
  used: Array<{ name: string; source: string }>;
  [key: string]: Json | undefined;
}

/** A library lemma as the memory holds it. */
export interface LibraryLemma extends LemmaData {
  nodeId: string;
  /** The status of its claim in this run: `open` when an earlier run's was reset by another Lean environment. */
  claimStatus: ClaimStatus;
  seq: number;
}

function object(data: Json): { [key: string]: Json } | undefined {
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as { [key: string]: Json }) : undefined;
}

function toLemma(node: MemoryNode, memory: MemoryStore): LibraryLemma | undefined {
  const d = object(node.data);
  if (d === undefined) return undefined;
  const text = (key: string): string | undefined => (typeof d[key] === "string" ? (d[key] as string) : undefined);
  const name = text("name");
  const claimId = text("claimId");
  const statement = text("statement");
  const proof = text("proof");
  const source = object(d.source ?? null);
  if (name === undefined || claimId === undefined || statement === undefined || proof === undefined || source === undefined) return undefined;
  const claim = memory.claim(claimId);
  if (claim === undefined) return undefined;
  const leanEnv = object(d.leanEnv ?? null);
  return {
    ...(d as LemmaData),
    name,
    claimId,
    statement,
    proof,
    statementId: text("statementId") ?? claim.statementId,
    header: text("header") ?? "",
    domain: text("domain") ?? "general",
    gloss: text("gloss") ?? "",
    source: {
      problemId: typeof source.problemId === "string" ? source.problemId : "",
      claimId: typeof source.claimId === "string" ? source.claimId : "",
      attemptId: typeof source.attemptId === "string" ? source.attemptId : "",
      name: typeof source.name === "string" ? source.name : "",
    },
    ...(leanEnv !== undefined ? { leanEnv: { name: String(leanEnv.name ?? ""), hash: typeof leanEnv.hash === "string" ? leanEnv.hash : null } } : {}),
    nodeId: node.nodeId,
    claimStatus: claim.status,
    seq: node.createdSeq,
  };
}

/** Every library lemma the memory holds, in the order they were promoted, whatever the standing of its claim. */
export function allLemmas(memory: MemoryStore): LibraryLemma[] {
  return memory.nodes(LEMMA_KIND).flatMap((node) => {
    const lemma = toLemma(node, memory);
    return lemma === undefined ? [] : [lemma];
  });
}

/** Whether a lemma can be offered: its claim passed a Lean check in this run's environment and it still compiles. */
export function isUsable(lemma: LibraryLemma): boolean {
  return (lemma.claimStatus === "computed" || lemma.claimStatus === "proved") && lemma.stale !== true;
}

/** The lemmas a session can be offered. A claim reset by another Lean environment is `open`, so its lemma is not here. */
export function usableLemmas(memory: MemoryStore): LibraryLemma[] {
  return allLemmas(memory).filter(isUsable);
}

export interface Candidate extends CandidateData {
  nodeId: string;
}

export function candidates(memory: MemoryStore, filter: { status?: CandidateStatus; problemId?: string } = {}): Candidate[] {
  return memory.nodes(CANDIDATE_KIND).flatMap((node) => {
    const d = object(node.data);
    if (d === undefined || typeof d.status !== "string" || typeof d.name !== "string" || typeof d.statement !== "string" || typeof d.proof !== "string") return [];
    const c = { ...(d as CandidateData), nodeId: node.nodeId };
    if (filter.status !== undefined && c.status !== filter.status) return [];
    if (filter.problemId !== undefined && c.problemId !== filter.problemId) return [];
    return [c];
  });
}

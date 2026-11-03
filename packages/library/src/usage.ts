import { type HarnessEvent, type Json, maskCommentsAndStrings, mergePatch } from "@seshat/core";
import type { CandidateStatus, LemmaData, UseData } from "./records.ts";
import { CANDIDATE_KIND, LEMMA_KIND, USE_KIND } from "./records.ts";

/** One name a submission may use, and where it comes from: `library`, a package, `Mathlib`. */
export interface KnownName {
  name: string;
  /** The label that is counted: `library`, `PFR`, `Mathlib`. */
  label: string;
}

/**
 * The names of `known` that a submission uses. The submission's comments and strings are blanked, then its
 * identifiers are read; a name is used when an identifier is the name, or its last component when exactly one
 * known name ends in it (a proof under `open Nat` writes `add_comm` for `Nat.add_comm`). It is an
 * approximation from the text: Lean's own list of the constants a proof uses is `lean.meta`'s
 * `#seshat_premises`, which a run with the meta tool could use instead.
 */
export function usedNames(text: string, known: readonly KnownName[]): KnownName[] {
  const full = new Map<string, KnownName>();
  const last = new Map<string, KnownName[]>();
  for (const k of known) {
    full.set(k.name, k);
    const tail = k.name.split(".").at(-1) as string;
    last.set(tail, [...(last.get(tail) ?? []), k]);
  }
  const used = new Map<string, KnownName>();
  const identifiers = maskCommentsAndStrings(text).match(/[\p{L}_][\p{L}\p{N}_'.!?]*/gu) ?? [];
  for (const id of identifiers) {
    const exact = full.get(id);
    if (exact !== undefined) {
      used.set(exact.name, exact);
      continue;
    }
    const candidates = last.get(id);
    if (candidates !== undefined && candidates.length === 1) used.set((candidates[0] as KnownName).name, candidates[0] as KnownName);
  }
  return [...used.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** What the library report says (documentation/library.md, "Measured"). */
export interface LibraryReport {
  /** Lemmas in the library at the end of the run, by domain. */
  lemmas: { total: number; byDomain: Record<string, number> };
  /** What the candidates came to. */
  candidates: Record<CandidateStatus, number>;
  /** Finished attempts whose proof the fast check accepted, and how many of those used a library lemma. */
  proofs: { total: number; withLibrary: number; share: number };
  /** Proofs that use a declaration from each source (LC2): the harness library, each extra package, Mathlib. */
  bySource: Record<string, number>;
}

/**
 * The library's measures, from a run's events alone: the lemmas by domain, what the candidates came to,
 * the share of accepted proofs that use a library lemma, and the proofs that use a declaration of each source.
 * Undefined when the run recorded nothing of the library.
 */
export function libraryReport(events: readonly HarnessEvent[]): LibraryReport | undefined {
  const nodes = new Map<string, { kind: string; data: Json }>();
  for (const event of events) {
    if (event.type === "node.recorded") nodes.set(event.data.nodeId, { kind: event.data.kind, data: event.data.data });
    else if (event.type === "node.updated") {
      const node = nodes.get(event.data.nodeId);
      if (node !== undefined) node.data = mergePatch(node.data, event.data.patch);
    }
  }
  const lemmas = [...nodes.values()].filter((n) => n.kind === LEMMA_KIND).map((n) => n.data as unknown as LemmaData);
  const candidates = [...nodes.values()].filter((n) => n.kind === CANDIDATE_KIND).map((n) => (n.data as { status?: CandidateStatus }).status);
  const uses = [...nodes.values()].filter((n) => n.kind === USE_KIND).map((n) => n.data as unknown as UseData);
  const accepted = uses.filter((u) => u.outcome === "valid");
  const attempts = events.filter((e) => e.type === "attempt.finished" && e.data.outcome === "valid").length;
  if (lemmas.length === 0 && candidates.length === 0 && uses.length === 0) return undefined;
  const byDomain: Record<string, number> = {};
  for (const l of lemmas) byDomain[l.domain] = (byDomain[l.domain] ?? 0) + 1;
  const counts: Record<CandidateStatus, number> = { pending: 0, promoted: 0, duplicate: 0, trivial: 0, unproved: 0 };
  for (const status of candidates) if (status !== undefined && status in counts) counts[status] += 1;
  const bySource: Record<string, number> = {};
  for (const u of accepted) for (const label of new Set(u.used.map((x) => x.source))) bySource[label] = (bySource[label] ?? 0) + 1;
  const withLibrary = accepted.filter((u) => u.used.some((x) => x.source === "library")).length;
  return {
    lemmas: { total: lemmas.length, byDomain },
    candidates: counts,
    proofs: { total: attempts, withLibrary, share: attempts === 0 ? 0 : withLibrary / attempts },
    bySource,
  };
}

/** The paragraph of a run report (`report.md`). */
export function renderLibraryReport(report: LibraryReport): string {
  const domains = Object.entries(report.lemmas.byDomain).map(([d, n]) => `${d} ${n}`).join(", ");
  const c = report.candidates;
  const sources = Object.entries(report.bySource).map(([s, n]) => `${s} ${n}`).join(", ");
  return (
    `Library: ${report.lemmas.total} lemma(s)${domains === "" ? "" : ` (${domains})`}; candidates: ${c.promoted} promoted, ${c.duplicate} duplicate, ` +
    `${c.trivial} trivial, ${c.unproved} not proved alone, ${c.pending} pending. ` +
    `${report.proofs.withLibrary} of ${report.proofs.total} accepted proof(s) (${(report.proofs.share * 100).toFixed(0)}%) use a library lemma` +
    `${sources === "" ? "" : `; proofs that use a declaration from: ${sources}`}.`
  );
}

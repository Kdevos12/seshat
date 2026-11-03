import { isInterrupted, type ProblemContext } from "@seshat/lines";
import { allLemmas } from "./records.ts";
import { libraryEntry } from "./search.ts";

export interface RecheckResult {
  /** The Mathlib revision the library was compiled under. */
  rev: string;
  /** Lemmas that compile under it, and lemmas that no longer do (now stale). */
  compiled: number;
  stale: number;
}

/**
 * Compiles the library again under the current Mathlib revision (plan change PE1). A library lemma carries the
 * revision it was last compiled under; when the run's is another, the lemma is checked as a file of its own (its
 * imports, then its text) through `lean.check`, and its node is updated with `checkedRev`, and `stale: true` if it
 * no longer compiles, so that it is not offered. A lemma whose claim is open (another Lean environment reset it)
 * is not compiled: it is not offered anyway. A lemma is offered only once it was compiled under the current revision
 * (`isUsable`), so Lean not answering, a timeout, or the limit of `maxRecheck` lemmas per call leaves a lemma withheld until a
 * later call compiles it; the library fails closed. Returns undefined when nothing was due or the store has no revision.
 */
export async function recheckLibrary(problem: ProblemContext, options: { maxRecheck: number }): Promise<RecheckResult | undefined> {
  let rev: string;
  try {
    rev = problem.memory.stamp().mathlibRev;
  } catch {
    return undefined;
  }
  const due = allLemmas(problem.memory)
    .filter((l) => l.claimStatus !== "open" && (l.checkedRev ?? l.mathlibRev) !== rev)
    .slice(0, options.maxRecheck);
  if (due.length === 0) return undefined;
  const snippets = due.map((l, i) => ({ id: `lib:${i}`, code: `${l.header}\n\n${libraryEntry(l).text}\n` }));
  let results: Array<{ id: string; status: string }>;
  try {
    const { output } = await problem.registry.invoke("lean.check", { snippets }, { actor: `line:${problem.line}`, signal: problem.signal });
    results = (output as unknown as { results: Array<{ id: string; status: string }> }).results;
  } catch (error) {
    if (problem.signal.aborted || isInterrupted(error)) throw error;
    // Lean could not be reached: the lemmas stay unchecked, so they are not offered, and the next call tries again.
    problem.log(`library: ${due.length} lemma(s) could not be compiled again under revision ${rev}, so they are not offered yet: ${error instanceof Error ? error.message : String(error)}`);
    return { rev, compiled: 0, stale: 0 };
  }
  const result: RecheckResult = { rev, compiled: 0, stale: 0 };
  for (const [i, lemma] of due.entries()) {
    const status = results.find((r) => r.id === `lib:${i}`)?.status;
    // Lean did not answer: it is tried again next time.
    if (status === undefined || status === "repl_error" || status === "server_error" || status === "timeout") continue;
    const ok = status === "valid";
    problem.memory.updateNode(lemma.nodeId, { checkedRev: rev, stale: !ok }, `compiled again under Mathlib revision ${rev}: ${ok ? "it compiles" : "it no longer compiles"}`);
    if (ok) result.compiled += 1;
    else {
      result.stale += 1;
      problem.log(`library: ${lemma.name} no longer compiles under revision ${rev}; it is not offered`);
    }
  }
  return result;
}

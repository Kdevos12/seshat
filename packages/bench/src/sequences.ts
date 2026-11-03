import type { ProblemEntry } from "./formal-conjectures.ts";

/**
 * Sequences of related problems (plan Task 14, deliverable 3; for the lemma library of line M3): an earlier problem of a sequence
 * leaves lemmas the later ones can use, so a run that works a sequence in order measures what the library gives. They are built from
 * the structure of the formal-conjectures checkout alone: the variants of one problem (`erdos_1`, `erdos_1.variants.weaker`) and the
 * problems that share a file (and so its definitions).
 */
export interface Sequence {
  /** `variants:<path>#<stem>` or `file:<path>`. */
  id: string;
  kind: "variants" | "file";
  path: string;
  /** For `variants`: the full name of the problem the others are variants of. */
  stem?: string;
  /** The problem ids in the order a run works them: the stem first, then by line in the file. */
  problems: string[];
}

const VARIANT = /^(.*?)\.variants\./;

/** The full name of the problem a variant belongs to, or the name itself. */
export function stemOf(fullName: string): string {
  return VARIANT.exec(fullName)?.[1] ?? fullName;
}

/** The sequences of a list of problems, ordered by id. A sequence has at least two problems. */
export function buildSequences(problems: readonly ProblemEntry[]): Sequence[] {
  const byFile = new Map<string, ProblemEntry[]>();
  for (const p of problems) byFile.set(p.path, [...(byFile.get(p.path) ?? []), p]);
  const out: Sequence[] = [];
  for (const [path, inFile] of byFile) {
    const ordered = [...inFile].sort((a, b) => a.line - b.line);
    const byStem = new Map<string, ProblemEntry[]>();
    for (const p of ordered) byStem.set(stemOf(p.fullName), [...(byStem.get(stemOf(p.fullName)) ?? []), p]);
    for (const [stem, members] of byStem) {
      if (members.length < 2) continue;
      // The problem the others vary comes first; the rest keep their order in the file.
      const sorted = [...members].sort((a, b) => Number(b.fullName === stem) - Number(a.fullName === stem) || a.line - b.line);
      out.push({ id: `variants:${path}#${stem}`, kind: "variants", path, stem, problems: sorted.map((p) => p.id) });
    }
    if (ordered.length >= 2) out.push({ id: `file:${path}`, kind: "file", path, problems: ordered.map((p) => p.id) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The problems of a sequence, in the sequence's order. */
export function sequenceProblems(problems: readonly ProblemEntry[], sequences: readonly Sequence[], id: string): ProblemEntry[] {
  const found = sequences.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no sequence ${JSON.stringify(id)} in the bench (harness-bench sequences lists them)`);
  const byId = new Map(problems.map((p) => [p.id, p]));
  return found.problems.map((pid) => {
    const p = byId.get(pid);
    if (p === undefined) throw new Error(`sequence ${id} names ${pid}, which is not in the bench`);
    return p;
  });
}

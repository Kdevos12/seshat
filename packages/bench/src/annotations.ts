import type { ProblemEntry } from "./formal-conjectures.ts";

/**
 * Problems tagged with an analogy or an induction (plan Task 14, deliverable 3; for the lines that look for them). The tags are written by a
 * person in a file, and checked here; `suggestTags` only proposes, from the shape of the statements, and never writes one.
 *
 * File format (`bench/annotations.json`, version 1):
 *
 *     { "v": 1, "tags": [
 *       { "problem": "<bench problem id>", "kind": "induction", "note": "why: the variable the induction runs on", "by": "name" },
 *       { "problem": "<bench problem id>", "kind": "analogy", "with": "<bench problem id>", "note": "what carries over", "by": "name" },
 *       { "problem": "<bench problem id>", "kind": "analogy", "withText": "a result outside the bench", "note": "...", "by": "name" } ] }
 */
export const TAG_KINDS = ["analogy", "induction"] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export interface Tag {
  problem: string;
  kind: TagKind;
  /** For an analogy: the bench problem it is an analogue of, or a description of one outside it. */
  with?: string;
  withText?: string;
  note: string;
  by?: string;
}

export interface Annotations {
  v: 1;
  tags: Tag[];
}

/** What is wrong with an annotations file, against a list of problems: nothing, when the list is empty. */
export function validateAnnotations(value: unknown, problems: readonly ProblemEntry[]): string[] {
  const out: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["the annotations are an object"];
  const file = value as { v?: unknown; tags?: unknown };
  if (file.v !== 1) out.push(`unsupported annotations version ${String(file.v)}`);
  if (!Array.isArray(file.tags)) return [...out, "tags must be a list"];
  const ids = new Set(problems.map((p) => p.id));
  const seen = new Set<string>();
  file.tags.forEach((raw: unknown, i: number) => {
    const at = `tag ${i}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      out.push(`${at}: not an object`);
      return;
    }
    const t = raw as Record<string, unknown>;
    const extra = Object.keys(t).filter((k) => !["problem", "kind", "with", "withText", "note", "by"].includes(k));
    if (extra.length > 0) out.push(`${at}: unknown field(s) ${extra.join(", ")}`);
    if (typeof t.problem !== "string" || !ids.has(t.problem)) out.push(`${at}: problem ${JSON.stringify(t.problem)} is not in the bench`);
    if (!(TAG_KINDS as readonly unknown[]).includes(t.kind)) out.push(`${at}: kind must be one of ${TAG_KINDS.join(", ")}`);
    if (typeof t.note !== "string" || t.note.trim().length < 10) out.push(`${at}: a note of at least 10 characters says why`);
    if (t.kind === "analogy") {
      const hasWith = typeof t.with === "string";
      const hasText = typeof t.withText === "string" && t.withText.trim() !== "";
      if (hasWith === hasText) out.push(`${at}: an analogy names what it is an analogue of with exactly one of "with" (a bench problem) or "withText"`);
      if (hasWith && !ids.has(t.with as string)) out.push(`${at}: with ${JSON.stringify(t.with)} is not in the bench`);
      if (hasWith && t.with === t.problem) out.push(`${at}: a problem is not an analogue of itself`);
    } else if (t.with !== undefined || t.withText !== undefined) {
      out.push(`${at}: only an analogy has "with" or "withText"`);
    }
    const key = `${String(t.problem)}\u0000${String(t.kind)}\u0000${String(t.with ?? t.withText ?? "")}`;
    if (seen.has(key)) out.push(`${at}: the same tag twice`);
    seen.add(key);
  });
  return out;
}

/** The tags by problem, from a validated file. */
export function tagsByProblem(annotations: Annotations): Record<string, TagKind[]> {
  const out: Record<string, TagKind[]> = {};
  for (const t of annotations.tags) out[t.problem] = [...new Set([...(out[t.problem] ?? []), t.kind])].sort();
  return out;
}

/** The problems of a list that carry a tag. */
export function taggedWith(problems: readonly ProblemEntry[], tags: Readonly<Record<string, readonly TagKind[]>>, kind: TagKind): ProblemEntry[] {
  return problems.filter((p) => tags[p.id]?.includes(kind) === true);
}

export interface Suggestion {
  problem: string;
  kind: TagKind;
  reason: string;
  with?: string;
}

/** The shape of a statement with its names and numbers masked: two problems with one shape are candidates for an analogy. */
export function shapeOf(statement: string): string {
  return statement.replace(/\b[A-Za-z_][A-Za-z0-9_']*\b/g, (w) => (/^(fun|forall|exists|if|then|else|let|in|ℕ|ℤ|ℚ|ℝ|Nat|Int|Finset|Set)$/.test(w) ? w : "v")).replace(/\d+/g, "0").replace(/\s+/g, " ").trim();
}

/**
 * Candidates to be confirmed by hand: induction where the statement quantifies a natural number over a sum, a product, a power or a factorial; an analogy
 * between two problems of different files whose statements have the same shape. A suggestion is not a tag.
 */
export function suggestTags(problems: readonly ProblemEntry[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const p of problems) {
    const s = p.statement;
    if (/(∀|∃)?\s*\(?\s*[a-z]\w*\s*:\s*(ℕ|Nat)(?!\w)/.test(s) && /(∑|∏|\^|!|Finset\.range|Nat\.factorial)/.test(s)) {
      out.push({ problem: p.id, kind: "induction", reason: "a natural number quantified over a sum, a product, a power or a factorial" });
    }
  }
  const byShape = new Map<string, ProblemEntry[]>();
  for (const p of problems) {
    const shape = shapeOf(p.statement);
    if (shape.length >= 25) byShape.set(shape, [...(byShape.get(shape) ?? []), p]);
  }
  for (const group of byShape.values()) {
    const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : 1));
    const [first, ...rest] = sorted;
    if (first === undefined) continue;
    for (const p of rest) if (p.path !== first.path) out.push({ problem: p.id, kind: "analogy", with: first.id, reason: "the same statement shape as a problem of another file" });
  }
  return out.sort((a, b) => (a.problem < b.problem ? -1 : a.problem > b.problem ? 1 : a.kind < b.kind ? -1 : 1));
}

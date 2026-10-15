import type { EdgeKind } from "@seshat/core";

/** What a rule says about a claim: it is proved, or refuted (its negation is proved). */
export type Goal = "proved" | "refuted";

export interface Fact {
  goal: Goal;
  claim: string;
}

/** `P:<claim>` for a proved claim, `R:<claim>` for a refuted one. */
export function factKey(fact: Fact): string {
  return `${fact.goal === "proved" ? "P" : "R"}:${fact.claim}`;
}

export function parseFactKey(key: string): Fact {
  const goal = key.startsWith("P:") ? "proved" : key.startsWith("R:") ? "refuted" : undefined;
  if (goal === undefined) throw new Error(`not a fact key: ${key}`);
  return { goal, claim: key.slice(2) };
}

/** A `lean_checked` edge, the only kind of edge the rules read. */
export interface EdgeAtom {
  id: string;
  kind: EdgeKind;
  from: string;
  to: readonly string[];
}

type End = "from" | "to";

/** A rule on a binary edge: when `premise` holds at one end, `conclusion` holds at one end. */
interface BinaryRule {
  id: string;
  kind: EdgeKind;
  premise: readonly [End, Goal];
  conclusion: readonly [End, Goal];
  doc: string;
}

/** The rules on a `decomposes_into` edge, whose targets are the parts of the `from` claim. */
interface DecompositionRule {
  id: string;
  kind: "decomposes_into";
  shape: "parts" | "last-part";
  doc: string;
}

export type Rule = BinaryRule | DecompositionRule;

/**
 * The propagation rules (plan §3.2), as data. Each reads one `lean_checked` edge whose link lemma
 * has the shape of [links.ts](./links.ts), and gives one fact; nothing else propagates. Read `A`
 * for the `from` end and `B` for the `to` end of the edge.
 *
 * A twentieth rule, the consistency check, is not a derivation: a claim that is proved and refuted
 * at once is reported by `Engine.contradictions`.
 */
export const RULES: readonly Rule[] = [
  { id: "implies/proved", kind: "implies", premise: ["from", "proved"], conclusion: ["to", "proved"], doc: "A is proved and A implies B: B is proved." },
  { id: "implies/refuted", kind: "implies", premise: ["to", "refuted"], conclusion: ["from", "refuted"], doc: "B is refuted and A implies B: A is refuted." },
  { id: "strengthens/proved", kind: "strengthens", premise: ["from", "proved"], conclusion: ["to", "proved"], doc: "A strengthens B and A is proved: B is proved." },
  { id: "strengthens/refuted", kind: "strengthens", premise: ["to", "refuted"], conclusion: ["from", "refuted"], doc: "A strengthens B and B is refuted: A is refuted." },
  { id: "special_case_of/proved", kind: "special_case_of", premise: ["to", "proved"], conclusion: ["from", "proved"], doc: "A is a special case of B and B is proved: A is proved." },
  { id: "special_case_of/refuted", kind: "special_case_of", premise: ["from", "refuted"], conclusion: ["to", "refuted"], doc: "A is a special case of B and A is refuted: B is refuted." },
  { id: "instance_of/proved", kind: "instance_of", premise: ["to", "proved"], conclusion: ["from", "proved"], doc: "A is an instance of B and B is proved: A is proved." },
  { id: "instance_of/refuted", kind: "instance_of", premise: ["from", "refuted"], conclusion: ["to", "refuted"], doc: "A is an instance of B and A is refuted: B is refuted." },
  { id: "equiv/proved-forward", kind: "equiv", premise: ["from", "proved"], conclusion: ["to", "proved"], doc: "A is equivalent to B and A is proved: B is proved." },
  { id: "equiv/proved-backward", kind: "equiv", premise: ["to", "proved"], conclusion: ["from", "proved"], doc: "A is equivalent to B and B is proved: A is proved." },
  { id: "equiv/refuted-forward", kind: "equiv", premise: ["from", "refuted"], conclusion: ["to", "refuted"], doc: "A is equivalent to B and A is refuted: B is refuted." },
  { id: "equiv/refuted-backward", kind: "equiv", premise: ["to", "refuted"], conclusion: ["from", "refuted"], doc: "A is equivalent to B and B is refuted: A is refuted." },
  { id: "negation_of/proved", kind: "negation_of", premise: ["from", "proved"], conclusion: ["to", "refuted"], doc: "A is the negation of B and A is proved: B is refuted." },
  { id: "negation_of/refuted", kind: "negation_of", premise: ["from", "refuted"], conclusion: ["to", "proved"], doc: "A is the negation of B and A is refuted: B is proved." },
  { id: "negation_of/proved-back", kind: "negation_of", premise: ["to", "proved"], conclusion: ["from", "refuted"], doc: "A is the negation of B and B is proved: A is refuted." },
  { id: "negation_of/refuted-back", kind: "negation_of", premise: ["to", "refuted"], conclusion: ["from", "proved"], doc: "A is the negation of B and B is refuted: A is proved." },
  { id: "decomposes_into/parts", kind: "decomposes_into", shape: "parts", doc: "Every part of A is proved: A is proved." },
  { id: "decomposes_into/last-part", kind: "decomposes_into", shape: "last-part", doc: "A is refuted and every part of A but one is proved: that part is refuted." },
  { id: "refuted_by/counterexample", kind: "refuted_by", premise: ["to", "proved"], conclusion: ["from", "refuted"], doc: "The counterexample B of A is proved: A is refuted." },
];

/** The kinds of edge the rules read. */
export const LOGIC_KINDS: ReadonlySet<EdgeKind> = new Set(RULES.map((rule) => rule.kind));

/** One rule applied to one edge: premises that must hold, and the conclusion they give. */
export interface Instance {
  id: string;
  rule: string;
  edge: string;
  /** Fact keys. */
  premises: string[];
  conclusion: string;
}

/** Every instance of the rules on an edge, whatever holds now. */
export function instancesOf(edge: EdgeAtom): Instance[] {
  const out: Instance[] = [];
  const at = (end: End): string => (end === "from" ? edge.from : (edge.to[0] as string));
  for (const rule of RULES) {
    if (rule.kind !== edge.kind) continue;
    if ("shape" in rule) {
      if (edge.to.length === 0) continue;
      const parts = edge.to.map((claim) => factKey({ goal: "proved", claim }));
      if (rule.shape === "parts") {
        out.push({ id: `${edge.id}#${rule.id}`, rule: rule.id, edge: edge.id, premises: parts, conclusion: factKey({ goal: "proved", claim: edge.from }) });
      } else {
        edge.to.forEach((claim, j) => {
          out.push({
            id: `${edge.id}#${rule.id}#${j}`,
            rule: rule.id,
            edge: edge.id,
            premises: [factKey({ goal: "refuted", claim: edge.from }), ...parts.filter((_, k) => k !== j)],
            conclusion: factKey({ goal: "refuted", claim }),
          });
        });
      }
    } else if (edge.to.length === 1) {
      out.push({
        id: `${edge.id}#${rule.id}`,
        rule: rule.id,
        edge: edge.id,
        premises: [factKey({ goal: rule.premise[1], claim: at(rule.premise[0]) })],
        conclusion: factKey({ goal: rule.conclusion[1], claim: at(rule.conclusion[0]) }),
      });
    }
  }
  return out;
}

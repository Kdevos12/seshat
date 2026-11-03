import { hash32, type Json } from "@seshat/core";
import { type Briefing, isInterrupted, type JsonObject, type Line, type ProblemContext, type ResumedProblem } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { compileLaw, type MagmaStatement, magmaBattery, recognizeStatement } from "@seshat/models";
import { describeRelation, findIntegerRelation } from "./pslq.ts";
import { type Equation, equationVariables, explore, magmaStructure, natStructure, printEquation, type Structure } from "./explore.ts";
import { optionReader } from "./options.ts";
import { statementProblem } from "./screen.ts";

const ACTOR = "line:M13";

/** The node kind of a law poured into the library as a candidate (documentation/induction.md, "Theory exploration"). */
export const LIBRARY_CANDIDATE_KIND = "library_candidate";

/** The node kind of an integer relation found among constants: evidence, never a status. */
export const RELATION_KIND = "integer_relation";

/** A conjecture of the exploration that the library (line M3) may take in. It is an `open` claim until a prover proves it. */
export interface LibraryCandidate {
  claimId: string;
  statement: string;
  header?: string;
  source: "M13";
  /** The claim the exploration was about. */
  targetClaimId: string;
  /** The test points the law held on. */
  support: number;
}

/** Where the candidates go. The default records them in the memory; M3 gives its own with `createM13({ sink })`. */
export interface LibrarySink {
  add: (candidate: LibraryCandidate) => void | Promise<void>;
}

/** The sink that records a candidate as a node about its claim, once. */
export function memorySink(memory: MemoryStore): LibrarySink {
  return {
    add: (c) => {
      if (memory.nodes(LIBRARY_CANDIDATE_KIND, { claimId: c.claimId }).length > 0) return;
      memory.recordNode({ kind: LIBRARY_CANDIDATE_KIND, claimId: c.claimId, data: { statement: c.statement, source: c.source, target: c.targetClaimId, support: c.support } as unknown as Json });
    },
  };
}

export const M13_OPTIONS: JsonObject = {
  /** The most nodes in a term. */
  maxSize: 5,
  /** The cut on the terms kept. */
  maxTerms: 4000,
  /** The most laws poured into the library per problem. */
  maxLaws: 12,
  /** Magmas that satisfy the target's hypotheses, at most, to test on. */
  models: 40,
  /** `auto`: by the target (numbers or magmas); or `nat`. */
  theory: "auto",
  /** Integer relations to look for with PSLQ: a list of lists of constants (`pi`, `e`, `ln(2)`, `sqrt(3)`, `1`, decimal texts). */
  relations: [],
};

interface Settings {
  maxSize: number;
  maxTerms: number;
  maxLaws: number;
  models: number;
  theory: "auto" | "nat";
  relations: string[][];
}

export function readM13Options(raw: Readonly<JsonObject>): Settings {
  const o = optionReader("M13", raw);
  const theory = o.text("theory");
  if (theory !== "auto" && theory !== "nat") throw new RangeError(`option M13.theory is "auto" or "nat", not ${JSON.stringify(theory)}`);
  return { maxSize: o.integer("maxSize", 3, 8), maxTerms: o.integer("maxTerms", 50, 50_000), maxLaws: o.integer("maxLaws", 1, 100), models: o.integer("models", 1, 400), theory, relations: relationsOf(o.list("relations")) };
}

function relationsOf(raw: unknown[]): string[][] {
  return raw.map((r, i) => {
    if (!Array.isArray(r) || r.length < 2 || r.length > 12 || r.some((x) => typeof x !== "string")) throw new TypeError(`option M13.relations[${i}] is a list of 2 to 12 constants, as texts`);
    return r as string[];
  });
}

/** The Lean statement of a law about magmas, under the target's own binders and hypotheses. */
function magmaLawStatement(target: MagmaStatement, e: Equation, text: string): string {
  const hypotheses = target.hypotheses.map((h, i) => `(h${i + 1} : ${h.text})`).join(" ");
  const variables = equationVariables(e).join(" ");
  return `(${target.type} : ${target.sort}) [${target.operation} ${target.type}] ${hypotheses}${hypotheses === "" ? "" : " "}: ∀ ${variables} : ${target.type}, ${text}`;
}

export interface M13Hooks {
  sink?: (memory: MemoryStore) => LibrarySink;
}

/**
 * The line M13: theory exploration. For a target about the natural numbers it explores 0, 1, + and *; for a target
 * about magmas, the operation, over the magmas that satisfy the target's hypotheses. The equations that hold on every test
 * point and do not follow from the smaller ones are the conjectures: each becomes an `open` claim (origin `line:M13`,
 * parent the target, a `derived_from` edge to it) and goes to the library's sink as a candidate. The target gets
 * a briefing with them. No status changes here.
 */
export function createM13(hooks: M13Hooks = {}): Line {
  const found = new Map<string, string[]>();
  const keyOf = (p: ProblemContext): string => `${p.runId}/${p.problemId}`;

  async function run(problem: ProblemContext, _held?: ResumedProblem): Promise<void> {
    const s = readM13Options(problem.options);
    const memory = problem.memory.withActor(ACTOR);
    const target = memory.claim(problem.claimId);
    if (target === undefined) return;
    // Classical conjecturing: integer relations among constants (PSLQ). A relation is a numerical coincidence: a node about the claim.
    for (const inputs of s.relations) {
      const subject = inputs.join(", ");
      if (memory.nodes(RELATION_KIND, { claimId: problem.claimId }).some((n) => (n.data as { inputs?: string[] }).inputs?.join(", ") === subject)) continue;
      try {
        const found = findIntegerRelation(inputs);
        memory.recordNode({
          kind: RELATION_KIND,
          claimId: problem.claimId,
          data: (found === undefined
            ? { inputs, found: false }
            : { inputs, found: true, relation: found.relation.map(String), text: describeRelation(found.relation, inputs), agreementDigits: Number.isFinite(found.agreementDigits) ? found.agreementDigits : null, relationDigits: found.relationDigits, significant: found.significant }) as unknown as Json,
        });
        problem.log(`M13: ${found === undefined ? `no integer relation among ${subject}` : `${describeRelation(found.relation, inputs)}${found.significant ? "" : " (not significant)"}`}`);
      } catch (error) {
        problem.log(`M13: the relation among ${subject} could not be searched: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const recognized = recognizeStatement(target.statement);
    if (!("statement" in recognized)) {
      problem.log(`M13: nothing to explore: ${recognized.reason}`);
      return;
    }
    const seed = hash32(`${problem.seed ?? problem.runId}/${problem.problemId}/M13`);
    const statement = recognized.statement;
    let structure: Structure<number>;
    if (statement.kind === "nat" || s.theory === "nat") {
      structure = natStructure({ seed });
    } else {
      const laws = statement.hypotheses.map((h) => compileLaw(h.law));
      const battery = magmaBattery({ exhaustive: 3, sampleSize: 4, samples: 200, seed: seed & 0x7fffffff });
      const models = battery.objects.filter((m) => laws.every((holds) => holds(m) === undefined)).slice(0, s.models);
      if (models.length < 2) {
        problem.log(`M13: only ${models.length} magma(s) satisfy the hypotheses; nothing to explore`);
        return;
      }
      structure = magmaStructure(models, { seed: seed & 0x7fffffff, symbol: statement.operation === "Mul" ? "*" : "◇" });
    }
    try {
      const result = explore(structure, { maxSize: s.maxSize, maxTerms: s.maxTerms, maxLaws: s.maxLaws });
      const sink = hooks.sink?.(memory) ?? memorySink(memory);
      const texts: string[] = [];
      for (const e of result.minimal.slice(0, s.maxLaws)) {
        const text = printEquation(e, structure.symbols);
        const claim = statement.kind === "magma" && s.theory !== "nat" ? magmaLawStatement(statement, e, text) : `(${equationVariables(e).join(" ")} : ℕ) : ${text}`;
        if (statementProblem(claim) !== undefined) continue;
        let claimId: string;
        try {
          claimId = (await memory.ensureClaim({ statement: claim, ...(target.header !== undefined ? { header: target.header } : {}), origin: ACTOR, kind: "formal", parentId: problem.claimId, gloss: `holds on ${e.points} test points` })).claimId;
        } catch (error) {
          if (isInterrupted(error) || problem.signal.aborted) throw error;
          problem.log(`M13: a law was refused: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (claimId === problem.claimId) continue;
        if (!memory.edges({ from: claimId, kinds: ["derived_from"] }).some((x) => x.to[0] === problem.claimId)) {
          memory.addEdge({ kind: "derived_from", from: claimId, to: problem.claimId, note: `theory exploration: ${text}` });
        }
        await sink.add({ claimId, statement: claim, ...(target.header !== undefined ? { header: target.header } : {}), source: "M13", targetClaimId: problem.claimId, support: e.points });
        texts.push(claim);
      }
      found.set(keyOf(problem), texts);
      problem.log(`M13: ${result.terms} terms, ${result.equations.length} equations, ${texts.length} laws kept${result.capped ? " (the enumeration was cut by maxTerms)" : ""}`);
    } catch (error) {
      if (isInterrupted(error) || problem.signal.aborted) throw error;
      problem.log(`M13: failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    id: "M13",
    title: "theory exploration and classical conjecturing",
    requires: [],
    options: M13_OPTIONS,
    version: "m13-1",
    // The exploration is a pure function of the target and the seed, and the claims, edges and candidates are not written twice.
    resume: "rebuild",
    hooks: {
      beforeProvers: (problem) => run(problem),
      resumeProblem: (problem, held) => run(problem, held),
      afterProblem: async (problem) => {
        found.delete(keyOf(problem));
      },
      briefing: async (session): Promise<Briefing | undefined> => {
        const laws = found.get(keyOf(session));
        if (laws === undefined || laws.length === 0) return undefined;
        return {
          title: "Laws found by theory exploration",
          text: `These equations held on every test point of a small exploration. They are open claims, not theorems; any may be false:\n${laws.slice(0, 8).map((l) => `- ${l}`).join("\n")}`,
        };
      },
    },
  };
}

export const M13 = createM13();

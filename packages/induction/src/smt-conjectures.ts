import { hashJson, type Json } from "@seshat/core";
import { findInvariant, findOptimum, type InvariantOutcome, type OptimumOutcome, type ParsedOptimum, type ParsedSystem, parseOptimumSpec, parseTransitionSystem, type RecipeAnswer, registrySolvers, type SmtCall, ToolMissing } from "@seshat/classical";
import { isInterrupted, type JsonObject, type ProblemContext } from "@seshat/lines";
import { optionReader } from "./options.ts";
import { statementProblem } from "./screen.ts";

/**
 * The z3 recipes of plan change CX7 in a line (M14's `invariants`, M8's `optima`): each spec given as an option goes
 * to `smt.z3` once per problem, and an answer that the strict reader of `@seshat/classical` (`smt-recipes.ts`) turns
 * into a Lean statement becomes an `open` claim derived from the problem's claim, with an `smt_recipe` evidence node.
 * The statement is written from integers and the spec's own names, and screened again here. Nothing else changes:
 * z3's answer is evidence, and the claim changes status only when a prover's Lean proof goes through `validate`.
 */
export const SMT_RECIPE_KIND = "smt_recipe";

export type SmtRecipe = { recipe: "invariant"; system: ParsedSystem } | { recipe: "optimum"; question: ParsedOptimum };

/** The data of an `smt_recipe` node: one run of a recipe for a problem, what z3 answered and what came of it. */
export interface SmtRecipeData {
  /** The hash of the recipe and its spec: a resumed problem does not ask z3 again. */
  key: string;
  /** The problem's claim the recipe ran for. */
  target: string;
  recipe: "invariant" | "optimum";
  name: string;
  answer: RecipeAnswer;
  detail?: string;
  /** The invariant, as the recipe rewrote it in SMT-LIB. */
  invariant?: string;
  /** The optimum and the point z3 gave for it (checked against the constraints). */
  value?: string;
  witness?: Record<string, string>;
  statement?: string;
  /** The `open` claim made from the answer. */
  claimId?: string;
  elapsedMs?: number;
}

/** Reads a line's option that lists recipe specs (absent: none); a bad spec fails with its place, `M14.invariants[0].step`. */
export function readSmtRecipes(line: string, raw: Readonly<JsonObject>, key: string, recipe: SmtRecipe["recipe"]): SmtRecipe[] {
  if (raw[key] === undefined) return [];
  return optionReader(line, raw)
    .list(key)
    .map((spec, i): SmtRecipe => (recipe === "invariant" ? { recipe, system: parseTransitionSystem(spec, `${line}.${key}[${i}]`) } : { recipe, question: parseOptimumSpec(spec, `${line}.${key}[${i}]`) }));
}

const GLOSS = {
  invariant: (name: string) => `z3's Spacer proposes an inductive invariant of the transition system ${name} that implies its property`,
  optimum: (name: string) => `z3's Optimize proposes the optimum of ${name} under its constraints`,
};

/** Runs each recipe once for the problem and makes an `open` claim of each answer that has a statement. */
export async function smtRecipeConjectures(problem: ProblemContext, actor: string, recipes: readonly SmtRecipe[]): Promise<SmtRecipeData[]> {
  const line = actor.replace(/^line:/u, "");
  const memory = problem.memory.withActor(actor);
  const target = memory.claim(problem.claimId);
  if (target === undefined || recipes.length === 0) return [];
  const done = new Map<string, SmtRecipeData>();
  for (const node of memory.nodes(SMT_RECIPE_KIND)) {
    const d = node.data as unknown as SmtRecipeData;
    if (d.target === problem.claimId) done.set(d.key, d);
  }
  let smt: SmtCall | null | undefined;
  const made: SmtRecipeData[] = [];
  for (const r of recipes) {
    const spec = r.recipe === "invariant" ? r.system.spec : r.question.spec;
    const key = hashJson({ recipe: r.recipe, spec } as unknown as Json).slice(0, 16);
    const known = done.get(key);
    if (known !== undefined) {
      made.push(known);
      continue;
    }
    smt ??= registrySolvers(problem.registry, { actor }).smt;
    if (smt === null) {
      problem.log(`${line}: the ${r.recipe} recipe ${spec.name} did not run: the host does not offer smt.z3`);
      continue;
    }
    let outcome: InvariantOutcome | OptimumOutcome;
    try {
      outcome = r.recipe === "invariant" ? await findInvariant(smt, r.system, problem.signal) : await findOptimum(smt, r.question, problem.signal);
    } catch (error) {
      if (isInterrupted(error) || problem.signal.aborted) throw error;
      problem.log(`${line}: the ${r.recipe} recipe ${spec.name} did not run: ${error instanceof ToolMissing ? error.message : error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const data: SmtRecipeData = { key, target: problem.claimId, recipe: r.recipe, name: spec.name, ...outcome };
    if (data.statement !== undefined) {
      const refused = statementProblem(data.statement);
      try {
        if (refused !== undefined) throw new Error(refused);
        data.claimId = (await memory.ensureClaim({ statement: data.statement, ...(target.header !== undefined ? { header: target.header } : {}), origin: actor, kind: "formal", parentId: problem.claimId, gloss: GLOSS[r.recipe](spec.name) })).claimId;
      } catch (error) {
        if (isInterrupted(error) || problem.signal.aborted) throw error;
        Object.assign(data, { answer: "malformed", detail: `the statement was refused: ${error instanceof Error ? error.message : String(error)}` });
        delete data.statement;
      }
    }
    if (data.claimId !== undefined && data.claimId !== problem.claimId && !memory.edges({ from: data.claimId, kinds: ["derived_from"] }).some((e) => e.to[0] === problem.claimId)) {
      memory.addEdge({ kind: "derived_from", from: data.claimId, to: problem.claimId, note: `the ${r.recipe} recipe ${spec.name}: z3's answer, not checked by Lean` });
    }
    memory.recordNode({ kind: SMT_RECIPE_KIND, claimId: data.claimId ?? problem.claimId, data: data as unknown as Json });
    problem.log(`${line}: the ${r.recipe} recipe ${spec.name}: ${data.answer}${data.claimId !== undefined ? `, an open claim ${data.claimId}` : data.detail !== undefined ? ` (${data.detail})` : ""}`);
    made.push(data);
  }
  return made;
}

/** The briefing's lines for the claims the recipes made: what z3 proposed, said to be open. */
export function smtRecipeBriefing(made: readonly SmtRecipeData[]): string[] {
  return made
    .filter((d) => d.claimId !== undefined && d.statement !== undefined)
    .map((d) =>
      d.recipe === "invariant"
        ? `z3 (Spacer) proposes an inductive invariant of ${d.name}; it is an open claim, not checked by Lean: ${d.statement}`
        : `z3 (Optimize) proposes ${d.value} as the optimum of ${d.name}, reached at ${Object.entries(d.witness ?? {}).map(([k, v]) => `${k} = ${v}`).join(", ")}; it is an open claim, not checked by Lean: ${d.statement}`,
    );
}

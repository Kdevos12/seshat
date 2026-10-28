import type { Json } from "@seshat/core";
import { completeJson, type Llm, withAntiSycophancy } from "@seshat/lines";
import type { JsonSchema } from "@seshat/registry";
import type { DataTable } from "./datatable.ts";
import { type ProgramLimits, runValues } from "./sandbox.ts";
import { statementProblem } from "./screen.ts";

/**
 * Hypotheses a model proposes about the objects of a data table, at several levels of abstraction, each as an
 * executable program (documentation/induction.md, "Hypotheses"). The program is what makes a hypothesis
 * testable: it is run on the table's objects in the sandbox and a hypothesis it fails on is dropped, with the
 * objects it fails on kept (they are the material of a repair). A hypothesis that passes is a conjecture, not a fact.
 */
export const LEVELS = ["observation", "pattern", "structure", "generalization"] as const;
export type Level = (typeof LEVELS)[number];

export interface Hypothesis {
  /** A short lowercase name, unique in a proposal. */
  id: string;
  level: Level;
  /** In words. */
  informal: string;
  /** The Lean statement in signature form, when the model gave one; formalization asks for it when not. */
  statement?: string;
  /** JavaScript: an object to a boolean; the hypothesis speaks of the objects it is true for. Absent: every object. */
  premise?: string;
  /** JavaScript: an object to a boolean; what holds of the objects in the premise. */
  conclusion: string;
  /** The names of the table's columns it uses: the dependencies between invariants. */
  uses: string[];
}

export function hypothesesSchema(max: number): JsonSchema {
  return {
    type: "object",
    properties: {
      hypotheses: {
        type: "array",
        minItems: 1,
        maxItems: max,
        items: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,23}$", description: "A short lowercase name." },
            level: { type: "string", enum: [...LEVELS], description: "observation: about particular values; pattern: a family of objects; structure: why the invariants are tied; generalization: a wider setting." },
            informal: { type: "string", minLength: 1, description: "The hypothesis in plain mathematical language." },
            statement: { type: "string", description: "Optional: the Lean 4 statement in signature form (binders, then ':' and the proposition), no ':=' and no proof." },
            premise: { type: "string", description: "Optional JavaScript function expression of an object returning true for the objects the hypothesis is about." },
            conclusion: { type: "string", description: "JavaScript function expression of an object returning true when the hypothesis holds of it." },
            uses: { type: "array", items: { type: "string" }, description: "The columns of the table the hypothesis relies on." },
          },
          required: ["id", "level", "informal", "conclusion", "uses"],
          additionalProperties: false,
        },
      },
    },
    required: ["hypotheses"],
    additionalProperties: false,
  };
}

/** What the model is shown of a table: the columns with their code, and the first rows. */
export function describeTable(table: DataTable, rows = 12): string {
  const names = table.columns.map((c) => c.name);
  const lines = [`Objects: ${table.family}, ${table.objects.length} of them. Columns: ${table.columns.map((c) => `${c.name}${c.description ? ` (${c.description})` : ""}`).join(", ")}.`];
  lines.push(names.join(" | "));
  for (let i = 0; i < Math.min(rows, table.rows.length); i++) lines.push(`${table.objectIds[i]}: ${(table.rows[i] ?? []).map((v) => JSON.stringify(v)).join(" | ")}`);
  return lines.join("\n");
}

export interface ProposeInput {
  /** The target's statement, in words or Lean: what the hypotheses are around. */
  target: string;
  table: DataTable;
  count: number;
  /** Facts already held (proved lemmas, earlier conjectures): the next round starts from them. */
  known?: readonly string[];
  /** The round, from 1: it is in the prompt, so that a resumed process asking the same round finds its answer in the journal. */
  round: number;
  model?: string;
}

/** Asks the model for hypotheses (site `induction.hypotheses`). Their programs and statements are checked here, not trusted. */
export async function proposeHypotheses(llm: Llm, input: ProposeInput): Promise<{ hypotheses: Hypothesis[]; refused: string[]; modelCallIds: readonly string[] }> {
  const known = input.known?.length ? `\n\nFacts already established (you may build on them, do not restate them):\n${input.known.map((k) => `- ${k}`).join("\n")}` : "";
  const prompt =
    `Target: ${input.target}\n\nData:\n${describeTable(input.table)}${known}\n\n` +
    `Round ${input.round}. Propose up to ${input.count} hypotheses about these objects that could help settle the target, at different levels of abstraction ` +
    `(${LEVELS.join(", ")}). Each must be executable: a JavaScript function expression of one object (as the columns' code receives it) returning true or false. ` +
    "Give the Lean statement when you can. Do not commit to one approach; a hypothesis may be false, and it will be run on every object.";
  const answer = await completeJson<{ hypotheses: Hypothesis[] }>(llm, {
    system: withAntiSycophancy("You propose conjectures about mathematical data. Your answer is read by a program."),
    prompt,
    schema: hypothesesSchema(input.count),
    site: "induction.hypotheses",
    reuse: true,
    ...(input.model !== undefined ? { model: input.model } : {}),
  });
  const hypotheses: Hypothesis[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();
  const columns = new Set(input.table.columns.map((c) => c.name));
  for (const h of answer.value.hypotheses) {
    if (seen.has(h.id)) {
      refused.push(`${h.id}: the id is used twice`);
      continue;
    }
    seen.add(h.id);
    if (h.statement !== undefined && h.statement.trim() !== "") {
      const problem = statementProblem(h.statement);
      if (problem !== undefined) {
        // The informal hypothesis and its programs stay; only the model's Lean text is refused.
        refused.push(`${h.id}: statement refused: ${problem}`);
        const { statement: _dropped, ...rest } = h;
        hypotheses.push({ ...rest, uses: h.uses.filter((u) => columns.has(u)) });
        continue;
      }
    }
    const { statement, ...rest } = h;
    hypotheses.push({ ...rest, ...(statement !== undefined && statement.trim() !== "" ? { statement } : {}), uses: h.uses.filter((u) => columns.has(u)) });
  }
  return { hypotheses, refused, modelCallIds: answer.modelCallIds };
}

export interface Executed {
  hypothesis: Hypothesis;
  premise?: Array<boolean | null>;
  conclusion: Array<boolean | null>;
  /** Objects (by index) in the premise where the conclusion is false. */
  counterexamples: number[];
  /** A note when a program did not run on every object. */
  notes: string[];
}

const asBooleans = (values: ReadonlyArray<Json | undefined>): Array<boolean | null> => values.map((v) => (typeof v === "boolean" ? v : null));

/**
 * Runs the programs of hypotheses on the table's objects, in the sandbox. A hypothesis is `consistent` when no
 * object of its premise breaks the conclusion and the programs gave a verdict on at least `minVerdicts` objects.
 */
export async function executeHypotheses(table: DataTable, hypotheses: readonly Hypothesis[], limits?: Partial<ProgramLimits>, signal?: AbortSignal): Promise<Executed[]> {
  const out: Executed[] = [];
  for (const hypothesis of hypotheses) {
    const notes: string[] = [];
    const conclusionRun = await runValues(hypothesis.conclusion, table.objects, limits, signal);
    if (conclusionRun.stopped !== undefined) notes.push(`conclusion: ${conclusionRun.stopped}`);
    const conclusion = asBooleans(conclusionRun.values);
    let premise: Array<boolean | null> | undefined;
    if (hypothesis.premise !== undefined && hypothesis.premise.trim() !== "") {
      const run = await runValues(hypothesis.premise, table.objects, limits, signal);
      if (run.stopped !== undefined) notes.push(`premise: ${run.stopped}`);
      premise = asBooleans(run.values);
    }
    const counterexamples = conclusion.flatMap((v, i) => (v === false && (premise === undefined || premise[i] === true) ? [i] : []));
    out.push({ hypothesis, ...(premise !== undefined ? { premise } : {}), conclusion, counterexamples, notes });
  }
  return out;
}

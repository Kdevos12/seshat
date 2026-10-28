import type { Json, ValidationReport } from "@seshat/core";
import { type Briefing, completeJson, type Llm, withAntiSycophancy } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import type { JsonSchema } from "@seshat/registry";

/**
 * The step DAG of an informal-first session (plan change PC11 item 1, documentation/fleet.md,
 * "Informal-first sessions"): the informal argument broken into steps, each a statement that later
 * steps use. The model writes it; the harness checks its shape before anything is formalized
 * (ProofFlow: acyclic, no forward reference, every node used), records it as a node, and the prover
 * writes one `aux_` lemma per step. Nothing here is a verdict: the steps are informal claims that
 * stay open, and only Lean, through `validate`, ever changes a claim's status.
 */
export interface Step {
  /** A short lowercase name, the suffix of the lemma `aux_<id>`. */
  id: string;
  /** The step in plain mathematical language. */
  statement: string;
  /** The steps it uses: earlier ones. */
  dependsOn: string[];
}

export interface StepDag {
  /** The informal argument as a whole. */
  proof: string;
  /** In order: each step comes after the ones it uses, and the last is the one the theorem follows from. */
  steps: Step[];
  /** Why the model doubts the statement, when it does. */
  doubt?: string;
}

/** The node kind of a recorded step DAG. */
export const STEP_DAG_KIND = "step_dag";
/** The node kind of what Lean said about each step after a session. */
export const STEP_STATUS_KIND = "step_status";
/** The node kind of a DAG the model could not write in a shape that checks (so that a claim does not pay for it every session). */
export const STEP_DAG_FAILURE_KIND = "step_dag_failure";

/** The most DAGs a claim gets written for before its informal-first sessions run as standard ones. */
export const MAX_DAG_TRIES = 2;

const STEP_ID = /^[a-z][a-z0-9_]{0,23}$/;

export function stepDagSchema(maxSteps: number): JsonSchema {
  return {
    type: "object",
    properties: {
      proof: { type: "string", minLength: 1, description: "The informal argument as a whole, in a few sentences." },
      doubt: { type: "string", description: "Only if you believe the statement is false as written: why, with a counterexample if you have one." },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: maxSteps,
        description: "The steps of the argument, each after the ones it uses; the last is the step the theorem follows from.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", pattern: STEP_ID.source, description: "A short lowercase name such as s1 or bound_step." },
            statement: { type: "string", minLength: 1, description: "The step as a statement in plain mathematical language." },
            dependsOn: { type: "array", items: { type: "string" }, description: "The ids of the earlier steps this step uses." },
          },
          required: ["id", "statement", "dependsOn"],
          additionalProperties: false,
        },
      },
    },
    required: ["proof", "steps"],
    additionalProperties: false,
  };
}

/**
 * What is wrong with a DAG's shape, in words the model can act on; empty when it checks. A cycle is
 * reported as one, a dependency on a step that comes later (or on itself) as a forward reference,
 * and a step that nothing uses (the last one apart) as unused.
 */
export function checkStepDag(dag: StepDag, maxSteps: number): string[] {
  const problems: string[] = [];
  const { steps } = dag;
  if (steps.length === 0) return ["the DAG has no step"];
  if (steps.length > maxSteps) problems.push(`the DAG has ${steps.length} steps, at most ${maxSteps} are allowed`);
  const index = new Map<string, number>();
  for (const [i, step] of steps.entries()) {
    if (!STEP_ID.test(step.id)) problems.push(`the id ${JSON.stringify(step.id)} is not a short lowercase name`);
    else if (index.has(step.id)) problems.push(`the id ${step.id} is used by two steps`);
    else index.set(step.id, i);
    if (step.statement.trim() === "") problems.push(`step ${step.id} has an empty statement`);
  }
  const unknown = new Set<string>();
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!index.has(dependency) && !unknown.has(`${step.id}>${dependency}`)) {
        unknown.add(`${step.id}>${dependency}`);
        problems.push(`step ${step.id} uses ${dependency}, which is not a step`);
      }
    }
  }
  if (problems.length > 0) return problems;
  // A cycle among the declared dependencies, whatever the order the steps are listed in.
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "open") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "open");
    path.push(id);
    for (const dependency of steps[index.get(id) as number]?.dependsOn ?? []) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const step of steps) {
    const cycle = visit(step.id);
    if (cycle !== undefined) return [`the steps form a cycle: ${cycle.join(" -> ")}`];
  }
  for (const [i, step] of steps.entries()) {
    for (const dependency of step.dependsOn) {
      if ((index.get(dependency) as number) >= i) problems.push(`forward reference: step ${step.id} uses ${dependency}, which comes after it (list a step after the ones it uses)`);
    }
  }
  const used = new Set(steps.flatMap((step) => step.dependsOn));
  for (const step of steps.slice(0, -1)) {
    if (!used.has(step.id)) problems.push(`step ${step.id} is not used by any later step (every step but the last must be used)`);
  }
  return problems;
}

/** The theorem a DAG is for. */
export interface DagTarget {
  theorem: string;
  /** Its statement in signature form. */
  statement: string;
}

function dagPrompt(target: DagTarget, maxSteps: number, problems: readonly string[] = []): string {
  const fix = problems.length === 0 ? "" : `\n\nYour previous DAG was refused: ${problems.slice(0, 8).join("; ")}.\nWrite it again so that it checks.`;
  return (
    `Here is a Lean 4 theorem, as its name and its signature:\n\ntheorem ${target.theorem} ${target.statement}\n\n` +
    "Work out whether it holds. Before any Lean, write the informal argument, and break it into at most " +
    `${maxSteps} steps. Each step is one statement, in plain mathematical language, that a later step or the theorem uses. ` +
    "List the steps in order, each after the ones it uses, and name in `dependsOn` the earlier steps each one uses. " +
    "The last step is the one the theorem follows from directly; every other step must be used by a later one. " +
    "If you come to believe the statement is false as written, say why in `doubt` and still give the steps of your best argument." +
    fix
  );
}

/** What `proposeStepDag` answers: the DAG, or why the model could not write one that checks. */
export type DagProposal = { ok: true; dag: StepDag; modelCallIds: readonly string[] } | { ok: false; problems: string[]; modelCallIds: readonly string[] };

/**
 * Asks the model for the informal argument and its step DAG (`completeJson`, site `fleet.dag`) and
 * checks its shape; a DAG that does not check is sent back once with what was wrong. A model call
 * that fails (budget, the model errs, an answer that does not match the schema twice) rejects.
 */
export async function proposeStepDag(llm: Llm, target: DagTarget, maxSteps: number, o: { model?: string } = {}): Promise<DagProposal> {
  const ids: string[] = [];
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await completeJson<StepDag>(llm, {
      system: withAntiSycophancy("You write informal mathematical arguments as step graphs. Your answer is read by a program."),
      prompt: dagPrompt(target, maxSteps, problems),
      schema: stepDagSchema(maxSteps),
      site: "fleet.dag",
      ...(o.model !== undefined ? { model: o.model } : {}),
    });
    ids.push(...answer.modelCallIds);
    problems = checkStepDag(answer.value, maxSteps);
    if (problems.length === 0) return { ok: true, dag: answer.value, modelCallIds: ids };
  }
  return { ok: false, problems, modelCallIds: ids };
}

/** A recorded step DAG: its node, and the claim of each step. */
export interface RecordedDag {
  nodeId: string;
  dag: StepDag;
  /** The informal claim made for each step, by step id. */
  claims: { [stepId: string]: string };
  /** The attempt of the session that asked for it. */
  attemptId?: string;
}

/**
 * Stores a checked DAG: one informal claim for each step (`origin: line:fleet`, derived from the
 * target), `decomposes_into` edges (each step from the steps it uses, and the target from the last
 * step), and then the node of the target claim (learned, so stamped). The node comes last: it is
 * what `stepDagOf` finds, so a process that ends part-way leaves claims and edges but no DAG, and
 * the next session writes it again. Both of the first two are safe to repeat: a statement already
 * known is the same claim, and an edge already there is not added twice. The edges are proposals:
 * no status of a claim moves.
 */
export async function recordStepDag(memory: MemoryStore, claimId: string, dag: StepDag, attemptId: string): Promise<RecordedDag> {
  const claims: { [stepId: string]: string } = {};
  for (const step of dag.steps) {
    claims[step.id] = (await memory.ensureClaim({ statement: step.statement, kind: "informal", origin: "line:fleet", parentId: claimId })).claimId;
  }
  const link = (from: string, to: string[]): void => {
    const known = memory.edges({ from, kinds: ["decomposes_into"] }).some((edge) => edge.to.length === to.length && edge.to.every((id, i) => id === to[i]));
    if (!known) memory.addEdge({ kind: "decomposes_into", from, to, note: "step DAG of an informal-first session" });
  };
  for (const step of dag.steps) {
    if (step.dependsOn.length > 0) link(claims[step.id] as string, step.dependsOn.map((id) => claims[id] as string));
  }
  const last = dag.steps.at(-1);
  if (last !== undefined) link(claimId, [claims[last.id] as string]);
  const node = memory.recordNode({
    kind: STEP_DAG_KIND,
    claimId,
    learned: true,
    data: { proof: dag.proof, steps: dag.steps as unknown as Json, claims, attemptId, ...(dag.doubt !== undefined ? { doubt: dag.doubt } : {}) },
  });
  return { nodeId: node.nodeId, dag, claims, attemptId };
}

function isDagData(data: Json): data is { proof: string; steps: Json[]; claims: { [id: string]: string }; attemptId?: string; doubt?: string } {
  return typeof data === "object" && data !== null && !Array.isArray(data) && typeof data.proof === "string" && Array.isArray(data.steps) && typeof data.claims === "object";
}

/** The last step DAG recorded for a claim, or undefined. */
export function stepDagOf(memory: MemoryStore, claimId: string): RecordedDag | undefined {
  const node = memory.nodes(STEP_DAG_KIND, { claimId }).at(-1);
  if (node === undefined || !isDagData(node.data)) return undefined;
  const data = node.data;
  return {
    nodeId: node.nodeId,
    dag: { proof: data.proof, steps: data.steps as unknown as Step[], ...(data.doubt !== undefined ? { doubt: data.doubt } : {}) },
    claims: data.claims,
    ...(data.attemptId !== undefined ? { attemptId: data.attemptId } : {}),
  };
}

/** What Lean said about one step in the last check of a session. */
export type StepState = "closed" | "error" | "hole" | "missing";

/**
 * Where Lean's messages fall in the lemmas of a check: for each step, whether its lemma `aux_<id>` is
 * missing from the file, has an error, has a `sorry` left, or is closed. A message is the step's when its line is
 * inside the lemma's declaration (from its head to the next command that starts a line). An error outside
 * every step lemma belongs to the main proof and to no step. Only counts and states are kept, never Lean's text.
 */
export function stepStates(dag: StepDag, report: Pick<ValidationReport, "checked" | "messages" | "sorries">): { [stepId: string]: StepState } {
  const lines = report.checked.split("\n");
  // Lean numbers lines from 1. A declaration runs from its head to the line before the next one that starts at column 0 with a command keyword.
  const head = /^(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+)*(?:theorem|lemma|def|abbrev|instance|example|structure|inductive|namespace|section|end|open|variable|set_option|#|attribute|macro|syntax|notation)\b/;
  const starts: Array<{ line: number; name?: string }> = [];
  for (const [i, text] of lines.entries()) {
    if (!head.test(text)) continue;
    const name = /^(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+)*(?:theorem|lemma|def|abbrev)\s+(\S+)/.exec(text)?.[1];
    starts.push({ line: i + 1, ...(name !== undefined ? { name } : {}) });
  }
  const states: { [stepId: string]: StepState } = {};
  for (const step of dag.steps) {
    const at = starts.findIndex((start) => start.name === `aux_${step.id}`);
    if (at < 0) {
      states[step.id] = "missing";
      continue;
    }
    const from = (starts[at] as { line: number }).line;
    const to = (starts[at + 1]?.line ?? lines.length + 2) - 1;
    const inside = (line: number): boolean => line >= from && line <= to;
    if (report.messages.some((message) => message.severity === "error" && inside(message.pos.line))) states[step.id] = "error";
    else if (report.sorries.some((sorry) => inside(sorry.pos.line)) || report.messages.some((message) => /declaration uses 'sorry'/.test(message.text) && inside(message.pos.line))) states[step.id] = "hole";
    else states[step.id] = "closed";
  }
  return states;
}

/** The latest recorded states of a DAG's steps, from the claim's `step_status` nodes. */
export function latestStepStates(memory: MemoryStore, claimId: string, dagNodeId: string): { [stepId: string]: StepState } | undefined {
  for (const node of memory.nodes(STEP_STATUS_KIND, { claimId }).reverse()) {
    const data = node.data;
    if (typeof data === "object" && data !== null && !Array.isArray(data) && data.dagNodeId === dagNodeId && typeof data.states === "object") {
      return data.states as { [stepId: string]: StepState };
    }
  }
  return undefined;
}

export function dagTries(memory: MemoryStore, claimId: string): number {
  return memory.nodes(STEP_DAG_FAILURE_KIND, { claimId }).length;
}

const STATE_WORDS: Readonly<Record<StepState, string>> = {
  closed: "closed (Lean accepts its lemma without a hole)",
  error: "Lean reports an error in it",
  hole: "a sorry is left in it",
  missing: "no lemma for it yet",
};

/**
 * The briefing section of an informal-first session: the informal argument, the steps with what Lean
 * said of each after the last check, and what to do. The wording asks to determine, not to demonstrate.
 */
export function dagSection(recorded: RecordedDag, states?: { [stepId: string]: StepState }): Briefing {
  const steps = recorded.dag.steps
    .map((step) => {
      const uses = step.dependsOn.length === 0 ? "uses nothing before it" : `uses ${step.dependsOn.join(", ")}`;
      const state = states?.[step.id];
      return `- ${step.id} (${uses}${state !== undefined ? `; ${STATE_WORDS[state]}` : ""}): ${step.statement}`;
    })
    .join("\n");
  const open = states === undefined ? undefined : recorded.dag.steps.filter((step) => states[step.id] !== "closed").map((step) => step.id);
  const text =
    "This session works informal-first. An informal argument was written before any Lean, as steps that each use the earlier ones:\n\n" +
    `${recorded.dag.proof}\n\nSteps:\n${steps}\n\n` +
    (recorded.dag.doubt !== undefined ? `The argument's author doubts the statement: ${recorded.dag.doubt}\n\n` : "") +
    "Write one auxiliary lemma named aux_<id> for each step, stating it in Lean, and close the theorem from them, with sorry in the lemmas not proved yet. " +
    (open === undefined
      ? "Check the skeleton first, then fill the lemmas one at a time. "
      : open.length === 0
        ? "Every step's lemma closed in the last check; look at the main proof. "
        : `Work on the steps that are not closed (${open.join(", ")}) and leave the closed ones as they are. `) +
    "A step that turns out to be false, or not a real step, is a finding: say so in your notes.";
  return { title: "Step plan", text };
}

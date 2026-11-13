import { type BlobStore, type Journal, type Json, newId, type Projection } from "@seshat/core";
import { JsonAnswerError, type Llm } from "@seshat/lines";
import { INFORMAL_PROOF_KIND, informalProofOfNodes, informalSection, type InformalProofData, quotedSketch, screenSketch } from "@seshat/memory";

/**
 * The informal proof first (plan changes PA13, NL2, AL1, AL2, documentation/informal.md). Once per problem, before the first outer prover session and
 * before M12's first blueprint: a generator writes a proof in natural language, a verifier reads it, and the proof is revised or regenerated until
 * `passes` independent verifier passes in a row say `correct`, or `rounds` generate-or-revise calls are made. The result is a hint, journaled as an
 * `informal_proof` node of the problem's claim: it never changes a claim's status, and nothing here says "proved". Only Lean judges.
 */
export interface InformalFirst {
  /** The `correct` verdicts in a row that accept a proof. Default `DEFAULT_PASSES`. */
  passes?: number;
  /** The most generate-or-revise calls. Default `DEFAULT_ROUNDS`. */
  rounds?: number;
}

export const DEFAULT_PASSES = 3;
export const DEFAULT_ROUNDS = 4;
/** The most Mathlib facts a proof lists, and the most `lean.search` queries made for them. */
export const MAX_FACTS = 5;
/** What the gate is told each call of the loop costs, as a share of the problem's allowance. */
export const INFORMAL_CALL_SHARE = 0.02;
/** The names kept for each fact. */
export const HITS_PER_FACT = 3;

/** The sites of the loop's calls (`model_call.finished`), charged to the problem. */
export const SITE_INFORMAL_GENERATE = "informal.generate";
export const SITE_INFORMAL_VERIFY = "informal.verify";
export const SITE_INFORMAL_REVISE = "informal.revise";
/** The line the loop's calls are recorded under. */
export const INFORMAL_LINE = "informal";

/** The problems of an `informalFirst` setting; empty when it is fine. */
export function checkInformalFirst(config: InformalFirst): string[] {
  const problems: string[] = [];
  if (typeof config !== "object" || config === null || Array.isArray(config)) return ["informalFirst must be an object"];
  for (const key of Object.keys(config)) if (key !== "passes" && key !== "rounds") problems.push(`informalFirst.${key}: unknown setting; they are passes and rounds`);
  if (config.passes !== undefined && !(Number.isInteger(config.passes) && config.passes >= 1)) problems.push("informalFirst.passes must be a whole number of at least 1");
  if (config.rounds !== undefined && !(Number.isInteger(config.rounds) && config.rounds >= 1)) problems.push("informalFirst.rounds must be a whole number of at least 1");
  return problems;
}

/** The setting with its defaults. */
export function informalSettings(config: InformalFirst): { passes: number; rounds: number } {
  return { passes: config.passes ?? DEFAULT_PASSES, rounds: config.rounds ?? DEFAULT_ROUNDS };
}

export type Verdict = "correct" | "fixable" | "wrong";

const GENERATOR_SYSTEM =
  "You are a careful mathematician. You write complete, rigorous proofs in natural language. You have no tools, and a reader will check every step.";
/** The version of the verifier's prompt (journaled in the node as `verifierPrompt`). v2 (task 51): look for the first gap, name each key step to say `correct`, check against the first cases. */
export const VERIFIER_PROMPT_VERSION = "v2";
const VERIFIER_SYSTEM =
  "You are a strict referee. You read one proof of a statement and judge it as it stands, step by step. You do not repair it, and you do not trust a claim that is not shown. " +
  "Look for the first gap or error. Any unjustified step, any appeal to \"it is well known\" or \"clearly\" without a reference, and any case left out is `fixable` at least. " +
  "Answer `correct` only if you can name, in your findings, each key step of the proof and why it holds.";

const FORMAT =
  "Write the whole proof in natural language, every step justified. Then, on its own line, write `Mathlib facts:` followed by at most 5 lines, each `- ` and the name or a short description of a fact from Mathlib the proof relies on.";

/** The text of the generation call: the statement, what the harness knows of it, a person's sketch as data, and a note on a failed approach. */
export function generatePrompt(o: { statement: string; doc?: string; firstCases?: { title: string; text: string }; sketch?: { by: string; text: string }; failed?: string }): string {
  return [
    "Prove the following theorem.",
    `The statement, in Lean 4:\ntheorem target ${o.statement.trim()}`,
    o.doc !== undefined && o.doc.trim() !== "" ? `Its description in words:\n${o.doc.trim()}` : "",
    o.firstCases !== undefined ? `${o.firstCases.title}:\n${o.firstCases.text}` : "",
    o.sketch !== undefined ? `A sketch from ${o.sketch.by}, who gave it for this theorem. It is informal and unchecked: it may be wrong or incomplete. Use it for ideas.\n${quotedSketch(o.sketch.text)}` : "",
    o.failed !== undefined ? `An earlier approach failed: ${oneLine(o.failed)}. Try another.` : "",
    FORMAT,
  ].filter((t) => t !== "").join("\n\n");
}

/** The text of the revision call: the statement, the proof and what the verifier found in it. */
export function revisePrompt(o: { statement: string; doc?: string; proof: string; findings: readonly string[] }): string {
  return [
    "Revise a proof of the following theorem. A reader found problems in it that can be repaired.",
    `The statement, in Lean 4:\ntheorem target ${o.statement.trim()}`,
    o.doc !== undefined && o.doc.trim() !== "" ? `Its description in words:\n${o.doc.trim()}` : "",
    `The proof:\n${o.proof.trim()}`,
    `What the reader found:\n${o.findings.map((f) => `- ${oneLine(f)}`).join("\n")}`,
    `Fix every point, keeping what was right. ${FORMAT}`,
  ].filter((t) => t !== "").join("\n\n");
}

/**
 * The text of the verification call. It holds the statement and the final proof text, and nothing else: no reasoning content, no earlier round and no
 * finding of an earlier pass (AL1).
 */
export function verifyPrompt(o: { statement: string; doc?: string; proof: string; firstCases?: { title: string; text: string } }): string {
  return [
    "Judge the proof below of the following theorem.",
    `The statement, in Lean 4:\ntheorem target ${o.statement.trim()}`,
    o.doc !== undefined && o.doc.trim() !== "" ? `Its description in words:\n${o.doc.trim()}` : "",
    o.firstCases !== undefined ? `${o.firstCases.title}, computed by the harness (check the proof's claims against them: a claim they contradict is wrong):\n${o.firstCases.text}` : "",
    `The proof:\n${o.proof.trim()}`,
    'Look for the first gap or error. Treat any unjustified step, any appeal to "it is well known" or "clearly" without a reference, and any case left out as `fixable` at least. ' +
      'Answer `correct` only if every step holds and the proof is complete, and you can name each key step and why it holds. `fixable` if it has gaps or errors that a repair of the same argument would fix, `wrong` if the approach cannot work or proves something else. ' +
      'List what you found in "findings", one short sentence each: for a `correct` proof, each key step and why it holds; otherwise each gap or error. A `correct` with no findings is read as `fixable`.',
  ].filter((t) => t !== "").join("\n\n");
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Splits an answer into the proof and the Mathlib facts it lists at its end (at most `MAX_FACTS`). */
export function splitProof(answer: string): { proof: string; facts: string[] } {
  const text = answer.replace(/\r\n?/g, "\n");
  const marker = /^[ \t>*#_]*Mathlib facts[ \t*_]*:?[ \t*_]*$/im;
  let at = -1;
  let after = "";
  const all = [...text.matchAll(new RegExp(marker.source, "gim"))];
  const last = all.at(-1);
  if (last?.index !== undefined) {
    at = last.index;
    after = text.slice(last.index + last[0].length);
  }
  if (at < 0) return { proof: screenSketch(text), facts: [] };
  const facts = after
    .split("\n")
    .map((line) => line.replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]*/, "").trim())
    .filter((line) => line !== "")
    .map((line) => oneLine(line).slice(0, 200))
    .slice(0, MAX_FACTS);
  return { proof: screenSketch(text.slice(0, at)), facts };
}

/** What the loop ends with. */
export interface InformalOutcome {
  /** The accepted proof, or the last one written; undefined when none was. */
  proof?: string;
  facts: string[];
  accepted: boolean;
  /** The `correct` verdicts in a row at the end. */
  passes: number;
  /** The generate-or-revise calls made. */
  rounds: number;
  verdicts: Verdict[];
  stop: "accepted" | "rounds" | "gate" | "failed" | "stopped";
  /** Why a loop ended other than by acceptance or the cap, in words. */
  detail?: string;
}

export interface InformalLoopOptions {
  settings: { passes: number; rounds: number };
  /** The problem's one-shot calls. A call goes to the model of its role: the planner's for the sites `informal.generate` and `informal.revise`, the verifier's for `informal.verify`. */
  llm: Llm;
  statement: string;
  /** The statement's docstring or natural-language form. */
  doc?: string;
  firstCases?: { title: string; text: string };
  sketch?: { by: string; text: string };
  /** The problem's budget gate, asked before every call; a skip ends the loop. */
  ask?: (estimateUsd: number) => Promise<{ action: "launch" | "skip"; reason: string }>;
  /** What the gate is told a call costs, in dollars. */
  estimateUsd: number;
  signal: AbortSignal;
  /** An error that is not a failure of the loop (the turn is over): thrown again. */
  interrupted?: (error: unknown) => boolean;
  log?: (text: string) => void;
}

const VERDICT_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["correct", "fixable", "wrong"] }, findings: { type: "array", items: { type: "string" } } },
  required: ["verdict", "findings"],
} as const;

/**
 * The loop (AL1): generate; verify the final text in a fresh call; `correct` counts one pass and the proof is accepted after `passes` of them in a row;
 * `fixable` goes, with its findings, to a revision whose answer is verified again; `wrong` starts a fresh generation that is told only that an earlier
 * approach failed and why, in a line. At most `rounds` generate-or-revise calls. Every call is asked of the gate first, and a skip ends the loop.
 * A call that fails ends it too, with the last proof kept and not accepted.
 */
export async function runInformalLoop(o: InformalLoopOptions): Promise<InformalOutcome> {
  const { passes: required, rounds: maxRounds } = o.settings;
  const verdicts: Verdict[] = [];
  let proof: string | undefined;
  let facts: string[] = [];
  let streak = 0;
  let rounds = 0;
  let failed: string | undefined;
  let findings: string[] = [];
  /** After a `wrong` verdict: the first finding, which the next generation is told in one line. */
  let note: string | undefined;
  let mode: "generate" | "revise" = "generate";
  const end = (stop: InformalOutcome["stop"], detail?: string): InformalOutcome => ({
    ...(proof !== undefined ? { proof } : {}),
    facts,
    accepted: stop === "accepted",
    passes: streak,
    rounds,
    verdicts,
    stop,
    ...(detail !== undefined ? { detail } : {}),
  });
  /** Asks the gate for one call; undefined to go on, or the reason of a skip. */
  const gated = async (): Promise<string | undefined> => {
    if (o.ask === undefined) return undefined;
    const answer = await o.ask(o.estimateUsd);
    return answer.action === "skip" ? answer.reason : undefined;
  };
  const failure = (error: unknown): InformalOutcome | undefined => {
    if (o.interrupted?.(error) === true) throw error;
    if (o.signal.aborted) return end("stopped", "the problem ended");
    const message = error instanceof Error ? error.message : String(error);
    return end("failed", message.slice(0, 200));
  };

  while (rounds < maxRounds) {
    const skipped = await gated();
    if (skipped !== undefined) return end("gate", skipped);
    rounds += 1;
    try {
      const request =
        mode === "revise" && proof !== undefined
          ? { site: SITE_INFORMAL_REVISE, system: GENERATOR_SYSTEM, prompt: revisePrompt({ statement: o.statement, ...(o.doc !== undefined ? { doc: o.doc } : {}), proof, findings }) }
          : {
              site: SITE_INFORMAL_GENERATE,
              system: GENERATOR_SYSTEM,
              prompt: generatePrompt({
                statement: o.statement,
                ...(o.doc !== undefined ? { doc: o.doc } : {}),
                ...(o.firstCases !== undefined ? { firstCases: o.firstCases } : {}),
                ...(o.sketch !== undefined ? { sketch: o.sketch } : {}),
                // The rejected proof is not shown, only the first finding, in a line.
                ...(note !== undefined ? { failed: note } : {}),
              }),
            };
      const written = splitProof((await o.llm.complete(request)).text);
      if (written.proof === "") return end("failed", "the model wrote no proof");
      proof = written.proof;
      facts = written.facts;
    } catch (error) {
      return failure(error) as InformalOutcome;
    }
    streak = 0;
    for (;;) {
      const skippedVerify = await gated();
      if (skippedVerify !== undefined) return end("gate", skippedVerify);
      let verdict: Verdict;
      let found: string[];
      try {
        const answer = await (o.llm.completeJson ?? (() => Promise.reject(new Error("the model client cannot answer in JSON"))))<{ verdict: Verdict; findings: string[] }>({
          site: SITE_INFORMAL_VERIFY,
          system: VERIFIER_SYSTEM,
          prompt: verifyPrompt({ statement: o.statement, ...(o.doc !== undefined ? { doc: o.doc } : {}), ...(o.firstCases !== undefined ? { firstCases: o.firstCases } : {}), proof }),
          schema: VERDICT_SCHEMA as never,
        });
        verdict = answer.value.verdict;
        found = answer.value.findings.map(String).filter((f) => f.trim() !== "");
        // A `correct` that names no step is no reason to accept: it is read as `fixable`.
        if (verdict === "correct" && found.length === 0) {
          verdict = "fixable";
          found = ["the verifier gave no reasons"];
        }
      } catch (error) {
        if (error instanceof JsonAnswerError && !o.signal.aborted) return end("failed", `the verifier's answer was not a verdict: ${error.message.slice(0, 160)}`);
        return failure(error) as InformalOutcome;
      }
      verdicts.push(verdict);
      if (verdict === "correct") {
        streak += 1;
        if (streak >= required) return end("accepted");
        continue;
      }
      streak = 0;
      findings = found;
      mode = verdict === "fixable" ? "revise" : "generate";
      // A `wrong` proof is not shown to the next generation: only the first finding, as a line.
      note = verdict === "wrong" ? (found[0] ?? "the verifier found the approach wrong") : undefined;
      break;
    }
  }
  return end("rounds", `${maxRounds} generate-or-revise call(s) were made and no proof had ${required} passes`);
}

/** Looks the facts up with `lean.search` (at most `MAX_FACTS` queries, no model call): the names found, in order, each once. */
export async function lookupFacts(facts: readonly string[], search: (query: string) => Promise<string[] | undefined>): Promise<string[]> {
  const names: string[] = [];
  for (const fact of facts.slice(0, MAX_FACTS)) {
    const found = (await search(fact)) ?? [];
    for (const name of found.slice(0, HITS_PER_FACT)) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Journals the loop's result as an `informal_proof` node of the claim, a hint: no status changes. The proof text is a blob. `hits` are the names the
 * search found for the facts of an accepted proof.
 */
export function recordInformalProof(
  journal: Journal,
  blobs: BlobStore,
  o: { claimId: string; problemId: string; outcome: InformalOutcome; required: number; models: { planner: string; verifier: string }; hits: string[] },
): string {
  const nodeId = newId("nod");
  const data: InformalProofData = {
    problemId: o.problemId,
    accepted: o.outcome.accepted,
    passes: o.outcome.passes,
    required: o.required,
    rounds: o.outcome.rounds,
    verdicts: [...o.outcome.verdicts],
    models: o.models,
    stop: o.outcome.stop,
    ...(o.outcome.proof !== undefined ? { proofHash: blobs.put(o.outcome.proof) } : {}),
    facts: o.outcome.facts,
    hits: o.hits,
    verifierPrompt: VERIFIER_PROMPT_VERSION,
  };
  journal.emit("node.recorded", { nodeId, kind: INFORMAL_PROOF_KIND, claimId: o.claimId, data: data as unknown as Json }, "orchestrator");
  return nodeId;
}

/** Whether the problem's claim already has the node: a problem that has it does not run the loop again; one cut mid-way runs it again. */
export function hasInformalProof(p: Projection, claimId: string, problemId: string): boolean {
  return p.nodes(INFORMAL_PROOF_KIND, claimId).some((node) => (node.data as { problemId?: unknown }).problemId === problemId);
}

/** The section of the outer prover's first briefing: the accepted informal proof, marked as not checked by Lean. Empty when none was accepted. */
export function informalBriefing(p: Projection, blobs: BlobStore, claimId: string): Array<{ title: string; text: string }> {
  const section = informalSection(informalProofOfNodes(p.nodes(INFORMAL_PROOF_KIND, claimId), (hash) => blobs.get(hash)));
  return section === undefined ? [] : [section];
}

import type { Llm } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import type { Proposal } from "./edge-check.ts";
import { failureLines } from "./failure.ts";
import type { ValidateFn } from "./realize.ts";

/** What a one-shot model attempt gave: the verdict of the last proof it submitted, if it submitted one. */
export interface ModelAttempt {
  /** `none`: the model gave no proof (or said it could not). */
  verdict: "valid" | "invalid" | "none";
  validationId?: string;
  /** Model calls made. */
  tries: number;
  reasons: string[];
}

export interface ModelAttemptOptions {
  llm: Llm;
  memory: MemoryStore;
  validate: ValidateFn;
  signal?: AbortSignal;
  /** Checked between tries: true when the claim no longer needs a proof (the other side settled). */
  stop?: () => boolean;
  attemptId?: string;
}

export type Framing = "prove" | "refute" | "link";

const SYSTEM =
  "You are a careful mathematician and an expert in Lean 4 with Mathlib. You write short, correct tactic proofs. " +
  "Answer with one ```lean block holding only the tactic proof, written without the leading `by`. " +
  "If you need auxiliary lemmas, put them in an earlier ```lean block, each named aux_<something>. " +
  "If you cannot prove the theorem, answer with the single word NOT_PROVABLE and one line saying why.";

/**
 * The prompt for one claim. A statement of unknown truth is framed neutrally (plan §9): the model is
 * told to determine whether it holds, never that it does. The refutation side proves the negation.
 */
export function attemptPrompt(framing: Framing, reference: string, failures: readonly string[]): string {
  const task =
    framing === "refute"
      ? "The theorem below is the negation of a statement whose truth is not known. Determine whether it can be proved: " +
        "look for a counterexample or an argument that the original statement fails, and if you find one, prove the theorem. " +
        "Do not assume the original statement is true, and do not assume it is false."
      : framing === "link"
        ? "Prove the theorem below. It is a link lemma between two statements; it should be short."
        : "Determine whether the theorem below holds, and if it does, prove it. Do not assume that it does.";
  const feedback = failures.length === 0 ? "" : `\n\nYour previous attempt failed:\n${failures.map((f) => `- ${f}`).join("\n")}\nGive a different proof.`;
  return `${task}\n\nThe file, where \`sorry\` stands for the proof you write:\n\n\`\`\`lean\n${reference.trim()}\n\`\`\`${feedback}`;
}

/** The proof in a model's answer: the last ```lean block, with the earlier ones as auxiliary declarations. */
export function extractProposal(text: string): Proposal | undefined {
  if (/^\s*NOT_PROVABLE\b/.test(text)) return undefined;
  const blocks = [...text.matchAll(/```[A-Za-z0-9]*[^\n]*\n([\s\S]*?)```/g)].map((m) => (m[1] as string).trim()).filter((b) => b !== "");
  // Without a non-empty block: the answer itself if it has no fence, or what follows a fence that was never closed.
  const fences = text.split("```").length - 1;
  const unclosed = /```[A-Za-z0-9]*[^\n]*\n([\s\S]*)$/.exec(text)?.[1]?.trim() ?? "";
  const raw = blocks.length > 0 ? (blocks[blocks.length - 1] as string) : fences === 0 ? text.trim() : fences % 2 === 1 ? unclosed : "";
  const proof = raw.replace(/^by\b[ \t]*\n?/, "").trim();
  if (proof === "") return undefined;
  const aux = blocks.slice(0, -1).join("\n\n");
  return { proof, ...(aux !== "" ? { aux } : {}) };
}

/**
 * Asks the model for a proof of a claim (or, for `refute`, of the negation claim) and submits it
 * through `validate`, up to `tries` times, telling the model why the last one failed. The claim's
 * status changes only if the proof is valid.
 */
export async function proveWithModel(o: ModelAttemptOptions, claimId: string, framing: Framing, tries: number): Promise<ModelAttempt> {
  const reference = o.memory.referenceFor(claimId).source;
  const failures: string[] = [];
  let made = 0;
  let last: ModelAttempt = { verdict: "none", tries: 0, reasons: [] };
  for (let k = 0; k < tries; k++) {
    if (o.signal?.aborted || o.stop?.() === true) break;
    const answer = await o.llm.complete({ system: SYSTEM, prompt: attemptPrompt(framing, reference, failures) });
    made += 1;
    const proposal = extractProposal(answer.text);
    if (proposal === undefined) {
      last = { verdict: "none", tries: made, reasons: [answer.text.trim().slice(0, 200)] };
      break;
    }
    const result = await o.validate({
      claimId,
      proof: proposal.proof,
      ...(proposal.aux !== undefined ? { aux: proposal.aux } : {}),
      ...(o.attemptId !== undefined ? { attemptId: o.attemptId } : {}),
    });
    last = {
      verdict: result.verdict,
      ...(result.validationId !== undefined ? { validationId: result.validationId } : {}),
      tries: made,
      reasons: result.reasons,
    };
    if (result.verdict === "valid" || result.report === undefined) break;
    failures.push(...failureLines(result));
  }
  return { ...last, tries: made };
}

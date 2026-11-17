import type { HarnessEvent } from "@seshat/core";
import { INFORMAL_PROOF_KIND, type InformalProofData } from "@seshat/memory";

/**
 * What `RESULT.md` and `report.md` show of the informal proof first (plan change AL3, documentation/informal.md, "What the result shows"). Built from the
 * journal's events and blobs alone, with no model call. Nothing here changes a claim's status: the proof stays a hint.
 */

/** The most characters of an informal proof the RESULT and the report show. */
export const MAX_INFORMAL_SHOWN = 4000;

/** The sentence under every informal proof that is shown. */
export const NOT_CHECKED_LINE = "This argument has not been checked by Lean; it may be wrong.";

/** The informal proof of one problem, as the journal holds it. */
export interface InformalLine {
  problemId: string;
  target: string;
  claimId: string;
  accepted: boolean;
  passes: number;
  required: number;
  rounds: number;
  /** Why the loop ended. */
  stop: string;
  models: { planner: string; verifier: string };
  /** The verdicts by model of the verifier, in the order they were given. */
  verdicts: string[];
  /** True when a valid kernel replay of the claim is in the journal: the informal proof is then not shown. */
  certified: boolean;
  /** The proof text of an accepted proof, cut at `MAX_INFORMAL_SHOWN` characters; absent when it was not accepted (it is shown to no one) or is certified. */
  text?: string;
  /** The characters of the whole text, when it was cut. */
  textChars?: number;
}

/** The informal proofs of a run, one per problem that has one, with the text of an accepted one that no Lean proof replaces. `blob` reads a blob's text. */
export function informalLines(events: readonly HarnessEvent[], blob: (hash: string) => string | undefined): InformalLine[] {
  const problems = new Map<string, { target: string; claimId: string }>();
  const nodes = new Map<string, InformalProofData>();
  const certified = new Set<string>();
  for (const e of events) {
    if (e.type === "problem.registered") problems.set(e.data.problemId, { target: e.data.target, claimId: e.data.claimId });
    else if (e.type === "node.recorded" && e.data.kind === INFORMAL_PROOF_KIND) {
      const data = e.data.data as unknown as InformalProofData;
      if (typeof data?.problemId === "string") nodes.set(data.problemId, data);
    } else if (e.type === "validation.finished" && e.data.method === "kernel_replay" && e.data.verdict === "valid") certified.add(e.data.claimId);
  }
  const lines: InformalLine[] = [];
  for (const [problemId, data] of nodes) {
    const problem = problems.get(problemId);
    if (problem === undefined) continue;
    const done = certified.has(problem.claimId);
    const whole = data.accepted && !done && typeof data.proofHash === "string" ? blob(data.proofHash) : undefined;
    lines.push({
      problemId,
      target: problem.target,
      claimId: problem.claimId,
      accepted: data.accepted,
      passes: data.passes,
      required: data.required,
      rounds: data.rounds,
      stop: data.stop,
      models: data.models,
      verdicts: [...data.verdicts],
      certified: done,
      ...(whole !== undefined ? { text: whole.length > MAX_INFORMAL_SHOWN ? whole.slice(0, MAX_INFORMAL_SHOWN) : whole, ...(whole.length > MAX_INFORMAL_SHOWN ? { textChars: whole.length } : {}) } : {}),
    });
  }
  return lines;
}

const fence = (text: string): string[] => {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const mark = "`".repeat(longest + 1);
  return [`${mark}text`, text.replace(/\n+$/, ""), mark];
};

/**
 * The Markdown of the informal proofs. An accepted proof with no certified Lean proof is shown under "Not checked by Lean", cut at 4000 characters, with
 * its passes, its models by role and the line that Lean has not checked it. One with a certified Lean proof is a line saying that it exists. A proof
 * that was not accepted is shown nowhere: the headline of the problem says "No solution found." instead.
 */
export function renderInformal(lines: readonly InformalLine[], heading = "##"): string[] {
  const out: string[] = [];
  const shown = lines.filter((l) => l.accepted && !l.certified && l.text !== undefined);
  if (shown.length > 0) {
    out.push("", `${heading} Not checked by Lean`, "");
    for (const l of shown) {
      out.push(
        `### Informal proof of \`${l.target}\``,
        "",
        `Accepted after ${l.passes} verifier pass${l.passes === 1 ? "" : "es"} in a row (${l.required} asked, ${l.rounds} generate-or-revise call${l.rounds === 1 ? "" : "s"}). Written by ${l.models.planner}, read by ${l.models.verifier}. The claim's status is unchanged.`,
        "",
        ...fence(l.text as string),
        ...(l.textChars !== undefined ? ["", `[cut: the proof is ${l.textChars} characters and this shows the first ${MAX_INFORMAL_SHOWN}; the whole text is in the journal's blob]`] : []),
        "",
        NOT_CHECKED_LINE,
        "",
      );
    }
  }
  for (const l of lines.filter((x) => x.accepted && x.certified)) {
    out.push("", `An informal proof of \`${l.target}\` also exists (accepted after ${l.passes} verifier pass${l.passes === 1 ? "" : "es"}); it is not shown, because a Lean proof was certified.`);
  }
  return out;
}

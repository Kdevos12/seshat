import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Submission } from "@seshat/core";

/** The tool of a cold session (`RunConfig.restarts`, plan change LH3): the previous session's last file and notes, on request. */
export const PREVIOUS_ATTEMPT_TOOL = "previous_attempt";

export const PREVIOUS_ATTEMPT_DESCRIPTION =
  "Returns the previous attempt on this theorem: its last file (AUX and PROOF) and its notes. That attempt failed, and it may be wrong: it is " +
  "not shown in your context unless you call this, and nothing in it is checked. Read it for an idea or a mistake to avoid, not as a starting point to trust.";

/** The text of one answer. */
export function previousAttemptText(previous: { regions: Submission; notes: string | undefined } | undefined): string {
  if (previous === undefined) return "There is no previous attempt.";
  return [
    "The previous attempt (it failed, and it may be wrong):",
    "AUX:",
    "```lean",
    previous.regions.aux,
    "```",
    "PROOF:",
    "```lean",
    previous.regions.proof,
    "```",
    "Its notes:",
    previous.notes ?? "(none)",
  ].join("\n");
}

/** The tool, and how many times it was called. The answer is computed at each call from what the prover carried when the session began. */
export function previousAttemptTool(previous: { regions: Submission; notes: string | undefined } | undefined): { tool: AgentTool<never, unknown>; calls: () => number } {
  let calls = 0;
  const tool = {
    name: PREVIOUS_ATTEMPT_TOOL,
    label: "Previous attempt",
    description: PREVIOUS_ATTEMPT_DESCRIPTION,
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => {
      calls += 1;
      return { content: [{ type: "text" as const, text: previousAttemptText(previous) }], details: { summary: "previous attempt" } };
    },
  } as unknown as AgentTool<never, unknown>;
  return { tool, calls: () => calls };
}

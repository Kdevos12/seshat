# Prompts as files, and `harness optimize-prompts`

The prover's system prompt is a text file, `packages/orchestrator/prompts/prover.system.txt`, with two placeholders the program fills in:
`{{NOTES_CHARS}}` (the notes limit) and `{{TOOLS_SECTION}}` (the section on the tools besides `lean_check`, or nothing). `systemPrompt` in
`packages/orchestrator/src/prompt.ts` renders it. A prompt that is a file can be changed by a patch, and a patch is something a person reads and merges.

Prompt text changes only with a human merge (Global Constraint 16). Nothing in the harness writes a prompt in place.

## Measuring a candidate: `RunConfig.prompts`

`RunConfig.prompts.proverSystem` replaces the text of the system prompt for one run. It is how `harness ablate` measures a candidate prompt:
an ablation arm (`Arm.prompts`) is a configuration like another, run at the same budget on the same problems. The text

- passes the strict screen at the start of the run (below), and the run is refused before anything is spent when it does not;
- is recorded in `run.started` (`config.prompts`), so that the run can be reproduced and resumed with it;
- stamps what the run learns with a prompt version of its own, `PROMPT_VERSION+` and the first eight characters of the text's hash, so that
  nothing learned under a candidate is mistaken for something learned under the merged prompt (the prompts' major version opens an epoch,
  documentation/memory.md, "Provenance and epochs").

A run without it records what it always did.

## The strict screen of a rewritten prompt

A rewrite is model-derived text that reaches a prover, so it is screened before it is measured and again before it is written
(`screenPrompt`, `packages/orchestrator/src/prompt-screen.ts`). Each target (`PROMPT_TARGETS`) names its file, its placeholders and its anchors.
A text is refused when it

- is empty, or holds control, zero-width or bidirectional characters, a link or an address;
- names a Lean token the validator refuses that the merged prompt does not already name (the merged prompt lists them to say they are refused);
- tells the model to ignore or override something, to skip the Lean check, not to call `lean_check`, or to claim a result without Lean;
- does not hold each placeholder exactly once, or holds another one;
- drops an anchor: `lean_check`, the four `-- HARNESS:` region markers, "Lean decides", "Never allowed" and `sorry`. These tie the prompt to the trust
  rules and to the file format; a self-modifying agent that removes its own guard phrases is the failure the Darwin Gödel Machine showed;
- is more than one and a half times or less than half the merged prompt's length: a longer prompt is a larger bill, and the budget would no longer be equal.

The screen is a floor, not a judgment: a text that passes it is still measured, and a person still reads it.

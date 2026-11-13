import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { BLUEPRINT_FORMAT, createM12Line } from "@seshat/scheduler";
import { check, DemoLean, demoRun, ofType, say } from "./m0-helpers.ts";
import { BP_AUX, BP_PROOF, blueprintAnswer } from "./blueprint-helpers.ts";
import { sessionPromptOf } from "./resume-helpers.ts";

type Message = TranscriptContext["messages"][number];

function textOf(message: Message): string {
  if (message.role === "assistant") return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const content = message.content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
}

/** The answer of each lean_check of the session, as the model read it. */
async function answers(aux: string, proof: string, blueprints: boolean | "no M12" = true) {
  const seen: string[] = [];
  const prompts: string[] = [];
  const last = (context: TranscriptContext) => {
    const result = context.messages.findLast((m) => m.role === "toolResult");
    if (result !== undefined) seen.push(textOf(result));
    return say("Done.");
  };
  const first = (context: TranscriptContext) => {
    prompts.push(sessionPromptOf(context));
    return check(proof, aux);
  };
  const run = await demoRun({
    ...(blueprints === "no M12" ? {} : { lines: { M12: createM12Line() } }),
    config: blueprints === "no M12" ? { provers: 1, sessions: 1 } : { lines: ["M12"], provers: 1, sessions: 1, lineOptions: { M12: { blueprints, maxInnerTasks: 0 } } },
    lean: new DemoLean(blueprintAnswer),
    responses: [first, last],
  });
  return { ...run, seen, prompts };
}

const sketches = (events: Parameters<typeof ofType>[0]) => ofType(events, "node.recorded").filter((e) => e.data.kind === "m12_sketch").map((e) => e.data.data as Record<string, unknown>);

describe("blueprints: the prover is told the format and what became of its sketch (PA16)", () => {
  it("puts the blueprint format in the briefing with the option, and not without it", { timeout: 30000 }, async () => {
    const on = await answers(BP_AUX, BP_PROOF, true);
    assert.match(on.prompts[0] ?? "", /How to write a blueprint/);
    assert.match(on.prompts[0] ?? "", /-- uses: aux_a, aux_b/);
    assert.ok((on.prompts[0] ?? "").includes(BLUEPRINT_FORMAT.split("\n")[0] as string));
    const off = await answers(BP_AUX, BP_PROOF, false);
    assert.doesNotMatch(off.prompts[0] ?? "", /How to write a blueprint|-- uses:/);
  });

  it("says a sketch is read as a blueprint, and which hole is left out and how to keep it", { timeout: 30000 }, async () => {
    const { seen, events } = await answers(BP_AUX, "exact main_ok aux_right");
    assert.match(seen[0] ?? "", /Read as a blueprint: aux_right, aux_left will be worked as separate sessions\./);
    assert.match(seen[0] ?? "", /aux_third is used by nothing and is left out; add `-- uses: aux_third` above the hole that needs it/);
    assert.equal(sketches(events)[0]?.healthy, true);
    assert.deepEqual(sketches(events)[0]?.dropped, ["aux_third"]);
  });

  it("says a main proof with a sorry is not a blueprint, and how to write one", { timeout: 30000 }, async () => {
    const { seen, events } = await answers(BP_AUX, "sorry");
    assert.match(seen[0] ?? "", /Not a blueprint yet: the main proof has a sorry of its own\.\nWrite the main proof from the holes/);
    assert.equal(sketches(events)[0]?.healthy, false);
  });

  it("names the problem when the unreachable hole is the only one", { timeout: 30000 }, async () => {
    const { seen } = await answers(BP_AUX, "exact main_ok");
    assert.match(seen[0] ?? "", /Not a blueprint yet: aux_right does not reach the target.*\nAdd `-- uses: X` directly above the hole whose proof will use X/);
  });

  it("drops an import the header already has from the aux region, says so, and the file goes to Lean", { timeout: 30000 }, async () => {
    const { seen, lean, events } = await answers(`import FormalConjectures.Util.ProblemImports\n\n${BP_AUX}`, BP_PROOF);
    assert.doesNotMatch(seen[0] ?? "", /Refused before Lean/);
    assert.match(seen[0] ?? "", /Dropped from the AUX region before checking: `import FormalConjectures.Util.ProblemImports`/);
    assert.match(seen[0] ?? "", /Read as a blueprint/);
    assert.ok((lean as DemoLean).calls.some((c) => c.code.includes("aux_right")), "Lean saw the file");
    assert.equal(sketches(events)[0]?.healthy, true);
  });

  it("an import the header does not have, and an open command, stay refused by the screen", { timeout: 30000 }, async () => {
    const foreign = await answers(`import Mathlib.Other\n\n${BP_AUX}`, BP_PROOF);
    assert.match(foreign.seen[0] ?? "", /Refused before Lean ran/);
    assert.match(foreign.seen[0] ?? "", /aux: 'import' is not allowed/);
    assert.match(foreign.seen[0] ?? "", /Not a blueprint yet: the file was refused before Lean ran/);
    const open = await answers(`open Finset BigOperators\n\n${BP_AUX}`, BP_PROOF);
    assert.match(open.seen[0] ?? "", /found 'open'/);
  });

  it("leaves the answer as it was without the option: byte for byte formatCheck", { timeout: 30000 }, async () => {
    const { seen, events } = await answers(BP_AUX, BP_PROOF, false);
    const plain = await answers(BP_AUX, BP_PROOF, "no M12");
    assert.match(plain.seen[0] ?? "", /^Checked the sketch/);
    assert.equal(seen[0], plain.seen[0]);
    assert.equal(sketches(events)[0]?.blueprint, undefined);
    // An import in aux is refused as it was, too.
    const withImport = await answers(`import FormalConjectures.Util.ProblemImports\n\n${BP_AUX}`, BP_PROOF, false);
    assert.match(withImport.seen[0] ?? "", /Refused before Lean ran/);
    assert.doesNotMatch(withImport.seen[0] ?? "", /Dropped from/);
  });
});

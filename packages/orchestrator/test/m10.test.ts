import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { check, DemoLean, demoRun } from "./m0-helpers.ts";

describe("line M10 in a run", () => {
  it("runs the battery before the prover, through lean.check and validate, and tells the prover what it did", async () => {
    const logs: string[] = [];
    const run = await demoRun({ responses: [check("exact trivial_proof")], lean: new DemoLean(() => ({})), config: { lines: ["M10"] }, log: (l) => logs.push(l) });
    assert.match(logs.join("\n"), /M10: \d+ goal\(s\); tactics: /);
    assert.match(logs.join("\n"), /M10: \w+ closed the target/);
    const types = run.events.map((e) => e.type);
    const firstAttempt = types.indexOf("attempt.started");
    const before = (type: string) => types.slice(0, firstAttempt).filter((t) => t === type).length;
    assert.ok(before("tool_run.started") > 0, "the battery's tries are tool runs, before the prover starts");
    assert.equal(before("validation.finished"), 1, "the success went through validate, once");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { frontierCommand } from "../src/frontier-command.ts";
import { scriptedJournal } from "./scripted-journal.ts";

describe("harness frontier", () => {
  it("prints the frontier of each problem from the journal, and as JSON, without writing to the run", () => {
    const s = scriptedJournal();
    s.journal.close();
    const lines: string[] = [];
    assert.equal(frontierCommand(s.dir, { out: (l) => lines.push(l) }), 0);
    const text = lines.join("\n");
    assert.match(text, /Problem Bench\.lean#goldbach/);
    assert.match(text, /## ?Established so far|^Established so far/m);
    assert.match(text, /subclaim: Part A: the base case holds \[proved\]/);
    assert.match(text, /subclaim: Part C: the small cases check \[computed\]/);
    assert.ok(!/Part B/.test(text), "an open leaf is not established");
    assert.match(text, /Problem Bench\.lean#accumulation \(claim \w+\): nothing established yet\./);
    const one: string[] = [];
    assert.equal(frontierCommand(s.dir, { claimId: s.claims.root, json: true, out: (l) => one.push(l) }), 0);
    const parsed = JSON.parse(one.join("\n")) as Array<{ claimId: string; score: number; entries: Array<{ kind: string }> }>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.claimId, s.claims.root);
    assert.equal(parsed[0]?.score, 6);
    assert.throws(() => frontierCommand(s.dir, { claimId: "clm_nope", out: () => {} }), /no claim clm_nope/);
  });
});

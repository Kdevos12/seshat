import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { createM12Line, createM15Line, M15_ARCHIVE_KIND, M15_HINT_KIND, M15_PICK_KIND } from "@seshat/scheduler";
import { SCHEMA_KIND } from "@seshat/library";
import { check, DemoLean, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";
import { m12Answer } from "./m12-helpers.ts";
import { AUX, AUXK, ConfirmingMeta, metaRegistry, SKETCH_PROOF, TWO_FILE } from "./m15-helpers.ts";
import { assertSound, certifier, consumed } from "./resume-helpers.ts";

const json = (proof: string) => say(JSON.stringify({ proof }));
const problem = (aux: string) => [check("bad"), say("notes"), check(SKETCH_PROOF, aux), say("notes"), json("exact hole_ok"), json("exact hole_ok")];
const responses = () => [...problem(AUX), ...problem(AUXK)];
const lines = () => ({ M12: createM12Line(), M15: createM15Line() });
const config = { lines: ["M12", "M15"], provers: 1, sessions: 3, budget: { problemUsd: 0.05 }, lineOptions: { M12: { fractions: [0.1], innerSessions: 1, rounds: 1 } } as never };
const count = (events: readonly HarnessEvent[], kind: string): number => ofType(events, "node.recorded").filter((e) => e.data.kind === kind).length;

describe("line M15 in a resumed run", () => {
  it("resumes a run cut at every event with the archive, the picks and the schema it would have had", { timeout: 300000 }, async () => {
    const whole = await demoRun({ lines: lines(), config, lean: new DemoLean(m12Answer), registry: metaRegistry(new ConfirmingMeta()), certifier: certifier().certifier, responses: responses(), problems: 2, file: TWO_FILE });
    assert.equal(count(whole.events, SCHEMA_KIND), 1);
    assert.ok(count(whole.events, M15_HINT_KIND) >= 1, "the second problem was offered the schema");
    assert.ok(count(whole.events, M15_PICK_KIND) >= 1);
    let exact = 0;
    for (let cut = 1; cut < whole.events.length; cut += 1) {
      const prefix = whole.events.slice(0, cut);
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      const resumed = await demoResume({
        dir: killedAt(whole.dir, cut),
        bench: whole.bench,
        responses: [...responses().slice(consumed(prefix)), json("exact hole_ok"), json("exact hole_ok"), json("exact hole_ok")],
        lines: lines(),
        lean: new DemoLean(m12Answer),
        registry: metaRegistry(new ConfirmingMeta()),
        certifier: certifier().certifier,
      });
      assert.equal(resumed.events.at(-1)?.type, "run.finished", where);
      assertSound(resumed.events);
      // Nothing the line records is recorded twice: one snapshot, and at most one schema, wherever the cut fell.
      assert.ok(count(resumed.events, M15_ARCHIVE_KIND) <= 2, where);
      assert.ok(count(resumed.events, SCHEMA_KIND) <= 1, where);
      const picked = ofType(resumed.events, "node.recorded").filter((e) => e.data.kind === M15_PICK_KIND).map((e) => (e.data.data as { attemptId: string }).attemptId);
      assert.equal(new Set(picked).size, picked.length, `${where}: one pick per session`);
      const hints = ofType(resumed.events, "node.recorded").filter((e) => e.data.kind === M15_HINT_KIND).map((e) => `${(e.data.data as { attemptId: string }).attemptId}/${(e.data.data as { schemaId: string }).schemaId}`);
      assert.equal(new Set(hints).size, hints.length, `${where}: one hint per session and schema`);
      if (ofType(prefix, "attempt.started").length === ofType(prefix, "attempt.finished").length) {
        exact += 1;
        assert.deepEqual(resumed.result.problems.map((p) => [p.outcome, p.attempts]), whole.result.problems.map((p) => [p.outcome, p.attempts]), where);
        if (resumed.result.problems.every((p) => p.outcome === "proved")) {
          assert.equal(count(resumed.events, SCHEMA_KIND), 1, `${where}: the closed decomposition became a schema`);
          assert.equal(count(resumed.events, M15_ARCHIVE_KIND), 2, where);
        }
      }
    }
    assert.ok(exact >= 20, `${exact} cuts between sessions`);
  });
});

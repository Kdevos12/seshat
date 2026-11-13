import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FakeLeanAnswer } from "../../core/test/fake-lean.ts";
import type { HarnessEvent } from "@seshat/core";
import { contextFor, createM12Line } from "@seshat/scheduler";
import { BP_AUX, blueprintAnswer } from "./blueprint-helpers.ts";
import { check, DemoLean, demoRun, ofType, say } from "./m0-helpers.ts";
import { sessionPromptOf } from "./resume-helpers.ts";

/** A hole carries the blueprint's context (task 51): a definition of the AUX that its statement names, in its claim's header, its file and its pre-flight. */
const nodes = (events: readonly HarnessEvent[], kind: string) => ofType(events, "node.recorded").filter((e) => e.data.kind === kind).map((e): Record<string, unknown> => ({ claimId: e.data.claimId, ...(e.data.data as Record<string, unknown>) }));
const holeClaims = (events: readonly HarnessEvent[]) => ofType(events, "claim.created").filter((e) => e.actor === "line:M12" && !(e.data.gloss ?? "").startsWith("link lemma"));

const DEF = `def aux_L (n : ℕ) : ℕ := n + 0`;
const HOLE = `lemma aux_hard (n : ℕ) : aux_L n + 2 = 2 + aux_L n := by
  sorry`;
const THIRD = `lemma aux_third (n : ℕ) : n * 1 = n := by
  sorry`;
const error = (text: string): FakeLeanAnswer => ({ messages: [{ severity: "error", pos: { line: 1, column: 0 }, text }] });

/** The simulated Lean knows `aux_L` only where a `def aux_L` is in the file: the 2003 B3 failure, "unknown identifier". */
const needsDef = (code: string): FakeLeanAnswer => (code.includes("aux_L") && !code.includes("def aux_L") ? error("unknown identifier 'aux_L'") : blueprintAnswer(code));
const OPTIONS = { blueprints: true, ageRatio: 1, weightRatio: 0, holeSessions: 1, rounds: 1 };

describe("a hole carries the blueprint's context (task 51)", () => {
  it("the 2003 B3 shape: a def and a hole whose statement uses it give a claim header, a file and a pre-flight with the def", { timeout: 60000 }, async () => {
    const lean = new DemoLean(needsDef);
    const { events, faux } = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 1, lineOptions: { M12: OPTIONS } },
      lean,
      responses: [check("exact main_ok aux_hard aux_third", `${DEF}\n\n${HOLE}\n\n${THIRD}`), say("Two lemmas are left."), check("exact hole_ok")],
    });
    assert.equal(faux.getPendingResponseCount(), 0);
    const [hard, third] = holeClaims(events);
    assert.match(String(hard?.data.header), /def aux_L \(n : ℕ\) : ℕ := n \+ 0/, "the hole's claim header has the def");
    assert.doesNotMatch(String(third?.data.header ?? ""), /aux_L/, "a hole that names no context command has the problem's header and nothing more");
    // The pre-flight type-checked the file with the def, and passed.
    const preflight = nodes(events, "m12_preflight").find((n) => n.claimId === hard?.data.claimId);
    assert.equal(preflight?.compileError, undefined);
    assert.ok(lean.calls.some((c) => c.code.includes("def aux_L") && /example .*aux_L n \+ 2 = 2 \+ aux_L n := by\n {2}sorry/.test(c.code)), "the type-check carries the def");
    // The session's file has the def above the lemma, and the session proved the hole.
    assert.ok(lean.calls.some((c) => c.code.includes("exact hole_ok") && c.code.indexOf("def aux_L") >= 0 && c.code.indexOf("def aux_L") < c.code.indexOf("hole_ok")));
    assert.equal(nodes(events, "m12_session").filter((n) => n.claimId === hard?.data.claimId).length, 1);
    assert.deepEqual(ofType(events, "claim.status_changed").filter((e) => e.data.claimId === hard?.data.claimId).map((e) => e.data.to), ["computed"]);
  });

  it("gives no session to a hole whose file does not type-check, and tells the planner's next round why", { timeout: 60000 }, async () => {
    const prompts: string[] = [];
    // Lean accepts the blueprint, and refuses the hole's statement on its own (the type-check is the one `example` of the pre-flight).
    const answer = (code: string): FakeLeanAnswer => (code.includes("example") && code.includes("aux_Broken") ? error("unknown identifier 'aux_Broken'\nsecond line") : blueprintAnswer(code));
    const BROKEN = `lemma aux_broken (n : ℕ) : aux_Broken n = n := by
  sorry`;
    const { events, faux } = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 1, lineOptions: { M12: { ...OPTIONS, refine: true } } },
      lean: new DemoLean(answer),
      responses: [
        check("exact main_ok aux_broken aux_third", `${BROKEN}\n\n${THIRD}`),
        say("Two lemmas are left."),
        (context: Parameters<typeof sessionPromptOf>[0]) => {
          prompts.push(sessionPromptOf(context));
          return say(JSON.stringify({ aux: THIRD, proof: "exact main_ok aux_third" }));
        },
      ],
    });
    assert.equal(faux.getPendingResponseCount(), 0);
    const [broken] = holeClaims(events);
    assert.equal(nodes(events, "m12_session").filter((n) => n.claimId === broken?.data.claimId).length, 0, "no session");
    assert.equal(ofType(events, "model_call.finished").filter((m) => m.data.site === "scheduler.hole").length, 0, "no paid hole session at all");
    const preflight = nodes(events, "m12_preflight").find((n) => n.claimId === broken?.data.claimId);
    assert.equal(preflight?.compileError, "unknown identifier 'aux_Broken'");
    assert.match(String((preflight?.notes as string[] | undefined)?.[0]), /does not type-check/);
    // The planner's round (case b) sees it as a hole with the error.
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /- aux_broken \[\w+\]: open, depth 0, last: its statement does not compile: unknown identifier 'aux_Broken'/);
  });

  it("a blueprint without a context command has the problem's header on its holes", { timeout: 60000 }, async () => {
    const { events } = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 1, lineOptions: { M12: OPTIONS } },
      lean: new DemoLean(blueprintAnswer),
      responses: [check("exact main_ok aux_right aux_third", BP_AUX), say("Three lemmas are left."), check("exact dep_ok"), check("exact hole_ok")],
    });
    for (const claim of holeClaims(events)) assert.doesNotMatch(String(claim.data.header ?? ""), /\bdef\b/);
  });
});

describe("contextFor", () => {
  const others = ["open Nat", `def aux_L (n : ℕ) : ℕ := aux_M n`, `def aux_M (n : ℕ) : ℕ := n`, `def aux_Z (n : ℕ) : ℕ := n`, `lemma aux_good (n : ℕ) : aux_L n = n := by\n  simp [aux_L, aux_M]`];

  it("is the commands a text names and what they name in turn, in file order, with the commands that declare no name", () => {
    assert.deepEqual(contextFor(others, ["(n : ℕ) : aux_L n = n"]), ["open Nat", others[1], others[2]]);
    assert.deepEqual(contextFor(others, ["(n : ℕ) : aux_good n = 1"]), [others[0], others[1], others[2], others[4]]);
  });

  it("is empty when no text names a context command, and does not match a name inside another name", () => {
    assert.deepEqual(contextFor(others, ["(n : ℕ) : n + 0 = n"]), []);
    assert.deepEqual(contextFor(others, ["(n : ℕ) : aux_Lx n = n", "(n : ℕ) : Foo.aux_L n = n"]), []);
    assert.deepEqual(contextFor([], ["(n : ℕ) : aux_L n = n"]), []);
  });
});

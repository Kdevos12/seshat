import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { buildReport, describeSet, setConfig } from "../src/index.ts";
import { call, check, demoRun, ofType, say } from "./m0-helpers.ts";

const ADVISOR = "faux/advisor";
const consulted = (events: readonly HarnessEvent[]) => ofType(events, "model_call.finished").filter((m) => m.data.site === "consult");

async function run(responses: Parameters<typeof demoRun>[0]["responses"], config: Record<string, unknown> = {}, pricePerMillion?: number) {
  return await demoRun({
    responses,
    extraModels: ["advisor"],
    config: { sessions: 1, ...config },
    ...(pricePerMillion !== undefined ? { pricePerMillion } : {}),
  });
}

describe("the consult tool (NL3, beta)", () => {
  it("is absent without the setting: a call to it is an unknown tool and no model is asked", async () => {
    let seen = "";
    const { events, faux } = await run([
      call("consult", { question: "q" }),
      (context: { messages: unknown[] }) => {
        seen = JSON.stringify(context.messages);
        return say("Done.");
      },
    ] as never);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(consulted(events).length, 0);
    assert.doesNotMatch(seen, /only Lean decides/);
  });

  it("answers a call as text, journals it at the site consult from the prover's actor, and charges it", async () => {
    let seen = "";
    const { events, result, faux } = await run(
      [
        call("consult", { question: "Which lemma closes n + 0 = n?" }),
        say("Use Nat.add_zero."),
        (context: { messages: unknown[] }) => {
          seen = JSON.stringify(context.messages);
          return check("exact trivial_proof");
        },
      ] as never,
      { consult: { model: ADVISOR } },
    );
    assert.equal(faux.getPendingResponseCount(), 0);
    const [one, ...more] = consulted(events);
    assert.equal(more.length, 0);
    assert.equal(one?.actor, "prover:p1");
    assert.equal(one?.data.model, ADVISOR);
    assert.equal(one?.data.outcome, "ok");
    assert.ok((one?.data.usd ?? 0) > 0, "priced by the model's price");
    assert.match(seen, /Advice from faux\/advisor; only Lean decides/);
    assert.match(seen, /Use Nat\.add_zero\./);
    const report = buildReport(events);
    assert.deepEqual(report.consult, { model: ADVISOR, calls: 1, usd: one?.data.usd });
    const attempts = ofType(events, "attempt.finished").reduce((sum, a) => sum + (a.data.usd ?? 0), 0);
    assert.ok(Math.abs(report.usd - (attempts + (one?.data.usd ?? 0))) < 1e-9, "the call is in the problem's cost");
    assert.equal(result.report.consult?.calls, 1);
  });

  it("is capped per session, and changes no status", async () => {
    const { events, faux } = await run(
      [call("consult", { question: "one" }), say("advice one"), call("consult", { question: "two" }), say("Done.")],
      { consult: { model: ADVISOR, maxCalls: 1 } },
    );
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(consulted(events).length, 1, "the second call was refused before any model call");
    assert.equal(ofType(events, "claim.status_changed").length, 0);
  });

  it("is refused when the call would not fit the problem's budget", async () => {
    const { events } = await run([call("consult", { question: "q" }), say("Done.")], { consult: { model: ADVISOR }, budget: { problemUsd: 1 } }, 1000);
    assert.equal(consulted(events).length, 0);
  });

  it("is in no defaults set; describeSet says so only when it is on", () => {
    for (const name of ["v1", "v2"] as const) {
      assert.equal(setConfig(name).consult, undefined);
      assert.doesNotMatch(describeSet(name).join(";"), /consult/);
    }
    assert.match(describeSet("v1", undefined, { consult: { model: ADVISOR } }).join(";"), /consult tool \(beta.*faux\/advisor/);
  });
});

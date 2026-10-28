import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxFactory, FauxDecider, jevFactory, type Fetch } from "@seshat/decide";
import type { LeanChecker } from "@seshat/core";
import { isInterrupted, type Decision, type Line } from "@seshat/lines";
import { type HostProfile, loadCatalog, Registry } from "@seshat/registry";
import { checkConfig, DEFAULT_CONFIG, REPO_ROOT, type RunOptions } from "../src/index.ts";
import { check, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";
import { leanCheckImplementation } from "@seshat/registry";
import { fakeJev } from "../../decide/test/fake-jev.ts";

const ORDER = {
  site: "prove.search.order",
  state: "n : ℕ\n⊢ n + 0 = n",
  use: "order" as const,
  question: { type: "choice" as const, instructions: "Which first?", options: { simp: "simp", omega: "omega", rfl: "rfl" } },
};

/** A line whose only act is to ask the decision, once, in `beforeProvers`. */
function asking(got: Array<Decision | Error>, request = ORDER): Line {
  return {
    id: "M4",
    title: "asks",
    requires: [],
    resume: "stateless",
    hooks: {
      beforeProvers: async (problem) => {
        try {
          got.push(await (problem.decide as NonNullable<typeof problem.decide>).decide(request));
        } catch (error) {
          got.push(error as Error);
          if (isInterrupted(error)) throw error;
        }
      },
    },
  };
}

const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
const shipped = JSON.parse(readFileSync(join(REPO_ROOT, "config/hosts/local.json"), "utf8")) as HostProfile;
const ENV = { JEV_API_KEY: "sk-test", JEV_MODEL: "PROVIDER/jev-X.Y" };

/** The demo registry plus `decide.ask`, with the shipped profile's settings for Jev, a fake server and the environment given. */
function withDecide(fetch: Fetch, env: Record<string, string>, faux = new FauxDecider()): (lean: LeanChecker) => RunOptions["registry"] {
  const decide = { ...(shipped.capabilities["decide.ask"] as object), use: ["jev", "faux"] };
  return (lean) => (journal, blobs) =>
    new Registry({
      catalog,
      host: { host: "test", capabilities: { "lean.check": { use: ["kimina"] }, "decide.ask": decide } as HostProfile["capabilities"] },
      factories: { kimina: () => leanCheckImplementation(lean), jev: jevFactory(fetch), "decide-faux": fauxFactory(faux) },
      env,
      journal,
      blobs,
    });
}

const verdict = (label: string) => say(JSON.stringify({ verdict: label }));

describe("decide in a run", () => {
  it("decides with the run's model by default: charged to the problem, tagged by site, journaled by the orchestrator", async () => {
    const got: Array<Decision | Error> = [];
    const { result, events } = await demoRun({
      lines: { M4: asking(got) },
      config: { lines: ["M4"] },
      responses: [verdict("omega"), check("exact trivial_proof")],
    });
    assert.equal((got[0] as Decision).answer, "omega");
    const made = ofType(events, "decision.made");
    assert.equal(made.length, 1);
    assert.deepEqual([made[0]?.actor, made[0]?.data.line, made[0]?.data.backend, made[0]?.data.requested, made[0]?.data.site], ["orchestrator", "M4", "llm", "llm", "prove.search.order"]);
    const calls = ofType(events, "model_call.finished");
    assert.deepEqual(calls.map((c) => c.data.site), ["prove.search.order"]);
    assert.deepEqual(made[0]?.data.modelCallIds, [calls[0]?.data.modelCallId]);
    const sessions = ofType(events, "attempt.finished").reduce((sum, a) => sum + a.data.usd, 0);
    assert.ok(Math.abs((result.problems[0]?.usd ?? 0) - sessions - (calls[0]?.data.usd ?? 0)) < 1e-9, "the decision is paid from the problem's budget");
    assert.ok(result.report.sites.some((s) => s.site === "prove.search.order"), "the report splits spend by the decision's site");
    assert.equal(ofType(events, "claim.status_changed").length, 1, "only the proof changed a status");
  });

  it("asks Jev through the capability when the configuration says so, and charges its cost to the problem", async () => {
    const got: Array<Decision | Error> = [];
    const server = fakeJev();
    const { result, events } = await demoRun({
      lines: { M4: asking(got) },
      config: { lines: ["M4"], decide: { backend: "jev" } },
      registry: withDecide(server.fetch, ENV),
      responses: [check("exact trivial_proof")],
    });
    const d = got[0] as Decision;
    assert.deepEqual([d.backend, d.answer, d.fallback], ["jev", "rfl", undefined]);
    assert.equal(server.seen.length, 1);
    assert.equal(server.seen[0]?.body.model, "PROVIDER/jev-X.Y");
    const runs = ofType(events, "tool_run.started").filter((e) => e.data.capability === "decide.ask");
    assert.deepEqual(runs.map((r) => [r.data.implementation, r.actor]), [["jev", "line:M4"]]);
    const [call] = ofType(events, "model_call.finished");
    assert.deepEqual([call?.data.site, call?.data.usd, call?.data.model], ["prove.search.order", 0.00013, "PROVIDER/jev-X.Y"]);
    const made = ofType(events, "decision.made")[0];
    assert.deepEqual([made?.data.backend, made?.data.toolRunId, made?.data.costUsd], ["jev", runs[0]?.data.toolRunId, 0.00013]);
    const sessions = ofType(events, "attempt.finished").reduce((sum, a) => sum + a.data.usd, 0);
    assert.ok(Math.abs((result.problems[0]?.usd ?? 0) - sessions - 0.00013) < 1e-9);
    const sent = JSON.stringify(server.seen[0]?.body);
    assert.ok(sent.includes("n + 0 = n"), "the state is what goes to the third party");
  });

  it("falls back to the run's model when the key is missing, journals it, and does not fail the run", async () => {
    const got: Array<Decision | Error> = [];
    const server = fakeJev();
    const { result, events } = await demoRun({
      lines: { M4: asking(got) },
      config: { lines: ["M4"], decide: { backend: "jev" } },
      registry: withDecide(server.fetch, { JEV_MODEL: "PROVIDER/jev-X.Y" }),
      responses: [verdict("simp"), check("exact trivial_proof")],
    });
    const d = got[0] as Decision;
    assert.deepEqual([d.backend, d.requested, d.answer], ["llm", "jev", "simp"]);
    assert.match(d.fallback ?? "", /JEV_API_KEY/);
    assert.equal(server.seen.length, 0, "nothing was sent");
    assert.equal(result.problems[0]?.outcome, "candidate");
    const made = ofType(events, "decision.made")[0];
    assert.match(made?.data.fallback ?? "", /JEV_API_KEY/);
  });

  it("falls back when the host is down, per site, and keeps the other sites on the run's model", async () => {
    const got: Array<Decision | Error> = [];
    const down: Fetch = async () => Promise.reject(new TypeError("fetch failed"));
    const { events } = await demoRun({
      lines: { M4: asking(got) },
      config: { lines: ["M4"], decide: { sites: { "prove.search.order": "jev" } } },
      registry: withDecide(down, ENV),
      responses: [verdict("omega"), check("exact trivial_proof")],
    });
    assert.deepEqual([(got[0] as Decision).backend, (got[0] as Decision).requested], ["llm", "jev"]);
    assert.match((got[0] as Decision).fallback ?? "", /fetch failed/);
    assert.equal(ofType(events, "tool_run.finished").filter((e) => e.data.outcome === "error").length, 1, "the failed call is a tool run too");
  });

  it("refuses the forbidden sites whatever the configuration, and the configuration that names one", async () => {
    const got: Array<Decision | Error> = [];
    const { events } = await demoRun({
      lines: { M4: asking(got, { ...ORDER, site: "fidelity.review" }) },
      config: { lines: ["M4"], decide: { backend: "faux" } },
      registry: withDecide(fakeJev().fetch, ENV),
      responses: [check("exact trivial_proof")],
    });
    assert.match((got[0] as Error).message, /forbidden at fidelity.review/);
    assert.equal(ofType(events, "decision.made").length, 0);
    assert.equal(ofType(events, "tool_run.started").filter((e) => e.data.capability === "decide.ask").length, 0);
    const problems = checkConfig({ ...DEFAULT_CONFIG, selection: {}, model: "p/m", decide: { sites: { "fidelity.review": "jev", "claim.status": "off" }, backend: "gpt" as never, votes: 12 } });
    assert.deepEqual(problems.length, 4);
    assert.match(problems.join("\n"), /decide.sites.fidelity.review: decide is forbidden at fidelity.review/);
    assert.match(problems.join("\n"), /decide.votes must be a whole number from 1 to 9/);
  });

  it("answers a question again from the journal after a resume, without asking or paying twice", async () => {
    const got: Array<Decision | Error> = [];
    const whole = await demoRun({
      lines: { M4: asking(got) },
      config: { lines: ["M4"] },
      responses: [verdict("omega"), check("exact trivial_proof")],
    });
    const cut = whole.events.findIndex((e) => e.type === "decision.made") + 1;
    const again: Array<Decision | Error> = [];
    const resumed = await demoResume({
      dir: killedAt(whole.dir, cut),
      bench: whole.bench,
      lines: { M4: asking(again) },
      // Only the prover's answer: a second decision would have no response and fail.
      responses: [check("exact trivial_proof")],
    });
    const d = again[0] as Decision;
    assert.deepEqual([d.replayed, d.answer, d.costUsd, d.decisionId], [true, "omega", 0, (got[0] as Decision).decisionId]);
    assert.equal(ofType(resumed.events, "decision.made").length, 1);
    assert.equal(ofType(resumed.events, "model_call.finished").length, 1, "the decision was paid once");
    assert.equal(resumed.result.problems[0]?.outcome, "candidate");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { createM12Line } from "@seshat/scheduler";
import { buildReport, describeSet, RunSetupError, renderRunReport } from "../src/index.ts";
import { checkRoles, describeRoles, PlannerEscalation, RoleBook } from "../src/roles.ts";
import { BP_AUX, BP_PROOF, blueprintAnswer, LEFT_STUB } from "./blueprint-helpers.ts";
import { call, check, DemoLean, demoRun, ofType, pricedRegistry, say } from "./m0-helpers.ts";
import { sessionPromptOf } from "./resume-helpers.ts";

const PLANNER = "faux/planner";
const HOLE = "faux/hole";
const ADVISOR = "faux/advisor";
const OPTIONS = { blueprints: true, refine: true, holeSessions: 1, rounds: 1, ageRatio: 1, weightRatio: 0, maxInnerTasks: 0 };
const planned = (events: readonly HarnessEvent[]) => ofType(events, "model_call.finished").filter((m) => m.data.site === "scheduler.planner");
const answer = (aux: string, proof: string) => say(JSON.stringify({ aux, proof }));

/** What a faux model was sent: the model it was, and the sampling options of the request. */
interface Seen {
  model: string;
  temperature: number | undefined;
  samplingParams: unknown;
  prompt: string;
}
type Context = Parameters<typeof sessionPromptOf>[0];
/** A response that records what it was sent, and answers with `response`. */
const watching = (seen: Seen[], response: ReturnType<typeof say>) => (context: Context, options: { temperature?: number; samplingParams?: unknown } | undefined, _state: unknown, model: { id: string }) => {
  seen.push({ model: model.id, temperature: options?.temperature, samplingParams: options?.samplingParams, prompt: sessionPromptOf(context) });
  return response;
};

/** The case a of the refinement tests: a blueprint Lean refused, so that the planner is asked once. */
async function planner(roles: Record<string, unknown> | undefined, extra: { seen?: Seen[]; registry?: Parameters<typeof demoRun>[0]["registry"]; extraPrices?: Record<string, number>; config?: Record<string, unknown> } = {}) {
  const seen = extra.seen ?? [];
  return await demoRun({
    lines: { M12: createM12Line() },
    config: { lines: ["M12"], provers: 1, sessions: 1, lineOptions: { M12: OPTIONS }, ...(roles !== undefined ? { roles } : {}), ...extra.config } as never,
    lean: new DemoLean(blueprintAnswer),
    extraModels: ["planner", "hole", "advisor"],
    ...(extra.extraPrices !== undefined ? { extraPrices: extra.extraPrices } : {}),
    ...(extra.registry !== undefined ? { registry: extra.registry } : {}),
    responses: [check("exact main_ok", BP_AUX), say("Done."), watching(seen, answer(BP_AUX, BP_PROOF)) as never],
  });
}

const dollars = (event: { data: { inputTokens: number; outputTokens: number } }, perMillion: number) => (event.data.inputTokens * perMillion + event.data.outputTokens * perMillion * 5) / 1e6;

describe("roles (CA15, CA23)", () => {
  it("a planner role's model receives the planner's call and is charged at its price", { timeout: 60000 }, async () => {
    const seen: Seen[] = [];
    const { events, faux, result } = await planner({ planner: { model: PLANNER } }, { seen, extraPrices: { planner: 30 } });
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.deepEqual(seen.map((s) => s.model), ["planner"], "the planner's request went to the planner's model");
    const [one, ...more] = planned(events);
    assert.equal(more.length, 0);
    assert.equal(one?.data.model, PLANNER);
    assert.equal(one?.data.role, "planner");
    assert.equal(one?.data.settings, undefined, "a role with no settings records none");
    assert.ok(Math.abs((one?.data.usd ?? 0) - dollars(one as never, 30)) < 1e-9, `charged at the planner's price: ${one?.data.usd}`);
    // The same ledgers: the problem's cost holds it.
    const attempts = ofType(events, "attempt.finished").reduce((sum, a) => sum + a.data.usd, 0);
    assert.ok(Math.abs(result.report.usd - (attempts + (one?.data.usd ?? 0))) < 1e-9);
    // The prover still ran on the run's model.
    assert.ok(ofType(events, "attempt.started").every((a) => a.data.model === "faux/prover"));
  });

  it("sends the settings with the request and records them; one the model's family ignores is not sent and is recorded as ignored", { timeout: 60000 }, async () => {
    const sent: Seen[] = [];
    const first = await planner({ planner: { model: PLANNER, settings: { temperature: 0.2, topP: 0.9 } } }, { seen: sent });
    assert.equal(sent[0]?.temperature, 0.2);
    assert.deepEqual(sent[0]?.samplingParams, { top_p: 0.9 });
    assert.deepEqual(planned(first.events)[0]?.data.settings, { temperature: 0.2, topP: 0.9 });
    const ignored: Seen[] = [];
    const second = await planner(
      { planner: { model: PLANNER, settings: { temperature: 0.2, topP: 0.9 } } },
      { seen: ignored, registry: pricedRegistry({ "faux/planner": { ignores: { always: ["temperature"] } } }) },
    );
    assert.equal(ignored[0]?.temperature, undefined, "the ignored setting was not sent");
    assert.deepEqual(ignored[0]?.samplingParams, { top_p: 0.9 });
    assert.deepEqual(planned(second.events)[0]?.data.settings, { topP: 0.9, ignored: ["temperature"] });
  });

  it("a thinking level of the role replaces the run's for its calls", { timeout: 60000 }, async () => {
    const { events } = await planner({ planner: { settings: { thinking: "low" } } });
    assert.deepEqual(planned(events)[0]?.data.settings, { thinking: "low" });
    assert.equal(planned(events)[0]?.data.model, "faux/prover", "no model named: the run's");
  });

  it("an unknown model name fails at the start, naming the role, with nothing journaled", async () => {
    await assert.rejects(
      planner({ hole: { model: "faux/nonesuch" } }),
      (error: unknown) => error instanceof RunSetupError && /roles\.hole\.model "faux\/nonesuch"/.test(error.message),
    );
    await assert.rejects(planner({ planner: { model: "nonesuch" } }), (error: unknown) => error instanceof RunSetupError && /roles\.planner\.model/.test(error.message));
    await assert.rejects(planner({ planner: { settings: { temperature: 7 } } }), (error: unknown) => error instanceof RunSetupError && /temperature must be a number from 0 to 2/.test(error.message));
    await assert.rejects(planner({ escalation: { model: PLANNER } }), (error: unknown) => error instanceof RunSetupError && /goes with roles\.planner/.test(error.message));
  });

  it("without roles the requests are the ones they always were, and no event has a role", { timeout: 60000 }, async () => {
    const a: Seen[] = [];
    const b: Seen[] = [];
    const without = await planner(undefined, { seen: a });
    const empty = await planner({}, { seen: b });
    assert.deepEqual(a, b, "an empty setting sends what none does");
    assert.deepEqual(a[0]?.samplingParams, undefined);
    assert.equal(a[0]?.temperature, undefined);
    for (const events of [without.events, empty.events]) {
      assert.ok(planned(events).every((m) => m.data.role === undefined && m.data.settings === undefined && m.data.escalation === undefined));
      assert.ok(ofType(events, "attempt.started").every((m) => m.data.settings === undefined));
    }
    assert.equal(without.result.report.roles, undefined);
    // Roles for other places leave the planner's call as it was.
    const other = await planner({ hole: { model: HOLE } });
    assert.equal(planned(other.events)[0]?.data.role, undefined);
    assert.equal(planned(other.events)[0]?.data.model, "faux/prover");
  });

  it("the prover role gives the outer sessions their model and settings, and records them on the attempt", async () => {
    const seen: Seen[] = [];
    const { events, faux } = await demoRun({
      responses: [watching(seen, check("exact trivial_proof")) as never],
      extraModels: ["advisor"],
      extraPrices: { advisor: 30 },
      config: { sessions: 1, roles: { prover: { model: ADVISOR, settings: { temperature: 0.4, topP: 0.8 } } } },
    });
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(seen[0]?.model, "advisor");
    assert.equal(seen[0]?.temperature, 0.4);
    assert.deepEqual(seen[0]?.samplingParams, { top_p: 0.8 });
    const [attempt] = ofType(events, "attempt.started");
    assert.equal(attempt?.data.model, ADVISOR);
    assert.deepEqual(attempt?.data.settings, { temperature: 0.4, topP: 0.8 });
    const [done] = ofType(events, "attempt.finished");
    assert.ok(Math.abs((done?.data.usd ?? 0) - dollars(done as never, 30)) < 1e-9, "charged at the advisor's price");
  });

  it("the consult role's model is another way to name the consult tool's model, and consult.model wins", async () => {
    const run = (config: Record<string, unknown>) =>
      demoRun({
        responses: [call("consult", { question: "q" }), say("Use Nat.add_zero."), check("exact trivial_proof")],
        extraModels: ["advisor", "planner"],
        config: { sessions: 1, ...config } as never,
      });
    const viaRole = await run({ roles: { consult: { model: ADVISOR, settings: { temperature: 0.1 } } } });
    const consulted = ofType(viaRole.events, "model_call.finished").filter((m) => m.data.site === "consult");
    assert.equal(consulted.length, 1);
    assert.equal(consulted[0]?.data.model, ADVISOR);
    assert.equal(consulted[0]?.data.role, "consult");
    assert.deepEqual(consulted[0]?.data.settings, { temperature: 0.1 });
    const both = await run({ consult: { model: PLANNER }, roles: { consult: { model: ADVISOR } } });
    assert.equal(ofType(both.events, "model_call.finished").find((m) => m.data.site === "consult")?.data.model, PLANNER);
  });

  it("the hole role gives the hole sessions their model, and the report has a line for each role named", { timeout: 60000 }, async () => {
    const seen: Seen[] = [];
    const roles = { hole: { model: HOLE, settings: { temperature: 0.3 } }, planner: { model: PLANNER } };
    const { events, result, faux } = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 3, lineOptions: { M12: { blueprints: true, ageRatio: 1, weightRatio: 0 } }, roles } as never,
      lean: new DemoLean(blueprintAnswer),
      extraModels: ["planner", "hole"],
      responses: [check(BP_PROOF, BP_AUX), say("Three lemmas are left."), watching(seen, check("exact dep_ok", LEFT_STUB)) as never, watching(seen, check("exact hole_ok")) as never],
    });
    assert.equal(faux.getPendingResponseCount(), 0);
    const holes = ofType(events, "model_call.finished").filter((m) => m.data.site === "scheduler.hole");
    assert.ok(holes.length >= 2);
    assert.ok(holes.every((m) => m.data.model === HOLE && m.data.role === "hole" && JSON.stringify(m.data.settings) === JSON.stringify({ temperature: 0.3 })));
    assert.ok(seen.every((s) => s.model === "hole" && s.temperature === 0.3));
    const report = buildReport(events);
    assert.deepEqual(report.roles?.map((r) => r.role), ["planner", "hole"].sort((a, b) => ["prover", "planner", "hole"].indexOf(a) - ["prover", "planner", "hole"].indexOf(b)));
    const hole = report.roles?.find((r) => r.role === "hole");
    assert.equal(hole?.calls, holes.length);
    assert.ok(Math.abs((hole?.usd ?? 0) - holes.reduce((sum, m) => sum + m.data.usd, 0)) < 1e-9);
    assert.deepEqual(hole?.models, [HOLE]);
    assert.equal(report.roles?.find((r) => r.role === "planner")?.calls, 0);
    assert.match(renderRunReport(result.report), /Role hole: faux\/hole, \d+ call\(s\), \$/);
  });

  it("is checked, described and found in no defaults set", () => {
    assert.deepEqual(checkRoles({ planner: { model: PLANNER, settings: { temperature: 0.2 } }, escalation: { model: ADVISOR, maxShare: 0.5 } }), []);
    assert.match(checkRoles({ bogus: {} } as never).join(";"), /roles\.bogus: unknown role/);
    assert.match(checkRoles({ hole: { settings: { topP: 0 } } }).join(";"), /topP must be a number above 0/);
    assert.match(checkRoles({ planner: { settings: { thinking: "deep" as never } } }).join(";"), /thinking must be one of/);
    const roles = { planner: { model: PLANNER, settings: { temperature: 0.2 } }, escalation: { model: ADVISOR } };
    assert.equal(describeRoles(roles), "planner on faux/planner (temperature 0.2); escalation to faux/advisor");
    assert.match(describeSet("v2", undefined, { roles }).join(";"), /roles \(asked for with --role\): planner on faux\/planner/);
    for (const name of ["v1", "v2"] as const) assert.doesNotMatch(describeSet(name).join(";"), /roles/);
    const book = new RoleBook(roles, { model: "faux/prover", thinkingLevel: "medium" });
    assert.equal(book.use("hole").model, "faux/prover");
    assert.equal(book.use("planner").record?.temperature, 0.2);
  });
});

/** A chain of refinements: each round replaces the hole that ended too hard by one that refines it, so that Lean never sees progress. */
const link = (k: number): string => `-- refines: aux_a${k - 1}
lemma aux_a${k} (n : ℕ) : n + ${k + 2} = ${k + 2} + n := by
  sorry`;
const FIRST = `lemma aux_a0 (n : ℕ) : n + 2 = 2 + n := by
  sorry`;

describe("the planner's escalation (CA15)", () => {
  const stuck = async (rounds: number, escalation: Record<string, unknown>, extra: { price?: number } = {}) => {
    const seen: Seen[] = [];
    const run = await demoRun({
      lines: { M12: createM12Line() },
      config: {
        lines: ["M12"], provers: 1, sessions: 1, lineOptions: { M12: { ...OPTIONS, maxInnerTasks: 1, maxRefinements: rounds } },
        roles: { planner: { model: PLANNER }, escalation },
      } as never,
      lean: new DemoLean(blueprintAnswer),
      extraModels: ["planner", "advisor"],
      extraPrices: { planner: 6, advisor: extra.price ?? 30 },
      responses: [
        check("exact main_ok aux_a0", FIRST),
        say("One lemma is left."),
        say("too hard"),
        ...Array.from({ length: rounds }, (_, k) => [watching(seen, answer(link(k + 1), `exact main_ok aux_a${k + 1}`)) as never, say("too hard")]).flat(),
      ],
    });
    return { ...run, seen };
  };

  it("two rounds in a row without Lean progress send the planner's next call to the escalation model, recorded on the call", { timeout: 60000 }, async () => {
    const { events, seen } = await stuck(3, { model: ADVISOR });
    assert.deepEqual(seen.map((s) => s.model), ["planner", "planner", "advisor"]);
    const calls = planned(events);
    assert.deepEqual(calls.map((c) => c.data.model), [PLANNER, PLANNER, ADVISOR]);
    assert.ok(calls.every((c) => c.data.site === "scheduler.planner" && c.data.role === "planner"), "the site stays the planner's");
    assert.deepEqual(calls.map((c) => c.data.escalation), [undefined, undefined, { from: PLANNER, rounds: 2 }]);
    assert.ok(Math.abs((calls[2]?.data.usd ?? 0) - dollars(calls[2] as never, 30)) < 1e-9, "charged at the escalation model's price");
    assert.ok(Math.abs((calls[1]?.data.usd ?? 0) - dollars(calls[1] as never, 6)) < 1e-9);
  });

  it("goes back to the planner's own model once the escalated calls have cost their share of the allowance", { timeout: 60000 }, async () => {
    // The allowance is $5 (the default): a share of 0.0001 is $0.0005, which one escalated call passes.
    const { events, seen } = await stuck(4, { model: ADVISOR, maxShare: 0.0001 });
    assert.deepEqual(seen.map((s) => s.model), ["planner", "planner", "advisor", "planner"]);
    assert.deepEqual(planned(events).map((c) => c.data.escalation?.rounds), [undefined, undefined, 2, undefined]);
    // With the default share ($1.25) every later call stays escalated.
    const roomy = await stuck(4, { model: ADVISOR });
    assert.deepEqual(roomy.seen.map((s) => s.model), ["planner", "planner", "advisor", "advisor"]);
    assert.deepEqual(planned(roomy.events).map((c) => c.data.escalation?.rounds), [undefined, undefined, 2, 3]);
  });

  it("never escalates without the escalation setting", { timeout: 60000 }, async () => {
    const run = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 1, lineOptions: { M12: { ...OPTIONS, maxInnerTasks: 1, maxRefinements: 3 } }, roles: { planner: { model: PLANNER } } } as never,
      lean: new DemoLean(blueprintAnswer),
      extraModels: ["planner"],
      responses: [check("exact main_ok aux_a0", FIRST), say("One lemma is left."), say("too hard"), ...[1, 2, 3].flatMap((k) => [answer(link(k), `exact main_ok aux_a${k}`), say("too hard")])],
    });
    assert.deepEqual(planned(run.events).map((c) => [c.data.model, c.data.escalation]), [[PLANNER, undefined], [PLANNER, undefined], [PLANNER, undefined]]);
  });
});

describe("PlannerEscalation", () => {
  const book = new RoleBook({ planner: { model: PLANNER }, escalation: { model: ADVISOR, maxShare: 0.25 } }, { model: "faux/prover", thinkingLevel: "off" });
  /** A script of the problem's state: the rounds made and the Lean progress at each call. */
  const script = (states: Array<{ rounds: number; proved?: number; holes?: number | undefined }>, spent: () => number = () => 0, allowance: number | null = 10) => {
    let at = 0;
    const escalation = new PlannerEscalation(book, {
      rounds: () => states[at]?.rounds ?? 0,
      progress: () => ({ proved: states[at]?.proved ?? 0, holes: states[at]?.holes }),
      allowanceUsd: () => allowance ?? undefined,
      spentOn: () => spent(),
    });
    return () => {
      const choice = escalation.choose();
      at += 1;
      return choice.use.model;
    };
  };

  it("counts rounds without progress, escalates at two and resets on a round with progress", () => {
    const next = script([
      { rounds: 0, holes: 2 },
      { rounds: 1, holes: 2 }, // round 1 made no progress: one
      { rounds: 2, holes: 2 }, // round 2 made none: two, so this call escalates
      { rounds: 3, holes: 1 }, // round 3 made progress: back to the planner's own, count 0
      { rounds: 4, holes: 1 }, // none: one
      { rounds: 5, holes: 1 }, // none: two: escalates again
    ]);
    assert.deepEqual([next(), next(), next(), next(), next(), next()], [PLANNER, PLANNER, ADVISOR, PLANNER, PLANNER, ADVISOR]);
  });

  it("a proved subclaim is progress, and a second call in the same round is no new round", () => {
    const next = script([
      { rounds: 0, proved: 0, holes: 3 },
      { rounds: 1, proved: 0, holes: 3 },
      { rounds: 1, proved: 0, holes: 3 }, // a JSON retry of round 2's call: the same round
      { rounds: 2, proved: 1, holes: 3 }, // progress: reset
      { rounds: 3, proved: 1, holes: 3 },
    ]);
    assert.deepEqual([next(), next(), next(), next(), next()], [PLANNER, PLANNER, PLANNER, PLANNER, PLANNER]);
  });

  it("stays on the planner's model with no allowance, and past the share", () => {
    const stuck = (n: number) => Array.from({ length: n }, (_, k) => ({ rounds: k, holes: 2 }));
    assert.deepEqual(Array.from({ length: 4 }, script(stuck(4), () => 0, null)), [PLANNER, PLANNER, PLANNER, PLANNER]);
    // The share is 0.25 of 10: $2.50 spent on the escalation model ends it.
    let spent = 0;
    const next = script(stuck(5), () => spent, 10);
    assert.deepEqual([next(), next(), next()], [PLANNER, PLANNER, ADVISOR]);
    spent = 2.4;
    assert.equal(next(), ADVISOR);
    spent = 2.5;
    assert.equal(next(), PLANNER);
  });
});

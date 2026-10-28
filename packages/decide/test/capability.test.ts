import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CapabilityError, type HostProfile, loadCatalog, Registry, runContract } from "@seshat/registry";
import { DECISION_SITES } from "@seshat/core";
import { DECIDE_ASK, FauxDecider, fauxFactory, jevFactory } from "../src/index.ts";
import { fakeJev } from "./fake-jev.ts";
import { ORDER } from "./helpers.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const catalog = loadCatalog(`${root}capabilities`);
const shipped = JSON.parse(readFileSync(`${root}config/hosts/local.json`, "utf8")) as HostProfile;

function registry(use: string[], env: Record<string, string>, fetch = fakeJev().fetch, faux = new FauxDecider()): Registry {
  const binding = shipped.capabilities[DECIDE_ASK];
  assert.ok(binding, "the local profile lists decide.ask");
  const host: HostProfile = { host: "test", capabilities: { [DECIDE_ASK]: { ...binding, use } } };
  return new Registry({ catalog, host, factories: { jev: jevFactory(fetch), "decide-faux": fauxFactory(faux) }, env });
}

const ENV = { JEV_API_KEY: "sk-test", JEV_MODEL: "PROVIDER/jev-X.Y" };

describe("the capability decide.ask", () => {
  it("has the three sites of the plan as its input's sites, the same as the journal's", () => {
    const manifest = catalog.capabilities.get(DECIDE_ASK)?.manifest;
    const site = (manifest?.input as { properties: { site: { enum: string[] } } }).properties.site.enum;
    assert.deepEqual([...site].sort(), Object.keys(DECISION_SITES).sort());
    assert.equal(manifest?.exposure, "auto");
    assert.deepEqual(manifest?.produces, [], "no decision justifies a status");
  });

  it("passes its contract with the jev implementation against a fake server", async () => {
    const report = await runContract(registry(["jev"], ENV), DECIDE_ASK, { implementation: "jev" });
    assert.deepEqual(report.cases.filter((c) => !c.passed).map((c) => [c.name, c.failures]), []);
    assert.equal(report.cases.length, 3);
  });

  it("passes its contract with the faux implementation", async () => {
    const report = await runContract(registry(["faux"], ENV), DECIDE_ASK, { implementation: "faux" });
    assert.deepEqual(report.cases.filter((c) => !c.passed).map((c) => [c.name, c.failures]), []);
  });

  it("refuses the forbidden sites at the schema, before any implementation", async () => {
    const r = registry(["jev"], ENV);
    for (const site of ["fidelity.review", "claim.status", "lean.progress", "prover.session"]) {
      await assert.rejects(r.invoke(DECIDE_ASK, { ...ORDER, site }), (error) => error instanceof CapabilityError && error.code === "invalid_input", site);
    }
    await assert.rejects(r.invoke(DECIDE_ASK, { ...ORDER, use: "threshold" }), (error) => error instanceof CapabilityError && error.code === "invalid_input");
  });

  it("is unavailable, naming the variable, without the key or the pinned model", async () => {
    for (const missing of ["JEV_API_KEY", "JEV_MODEL"]) {
      const env: Record<string, string> = { ...ENV };
      delete env[missing];
      const r = registry(["jev"], env);
      await assert.rejects(r.invoke(DECIDE_ASK, ORDER), (error) => error instanceof CapabilityError && error.code === "unavailable" && error.message.includes(missing), missing);
      assert.equal((await r.usable(DECIDE_ASK)).ok, false);
    }
  });

  it("is unavailable when the profile's host list does not allow the address", async () => {
    const r = registry(["jev"], { ...ENV, JEV_BASE_URL: "https://elsewhere.example/api" });
    await assert.rejects(r.invoke(DECIDE_ASK, ORDER), /host elsewhere.example is not among the allowed hosts/);
  });

  it("records each call as a tool run of decide.ask", async () => {
    const calls: string[] = [];
    const sink = { emit: (type: string) => void calls.push(type) };
    const r = new Registry({ catalog, host: { host: "test", capabilities: { [DECIDE_ASK]: { use: ["faux"] } } }, factories: { "decide-faux": fauxFactory() }, journal: sink as never });
    const out = await r.invoke(DECIDE_ASK, ORDER, { actor: "line:M10" });
    assert.equal(out.implementation, "faux");
    assert.deepEqual(calls, ["tool_run.started", "tool_run.finished"]);
  });

  it("scripts the faux backend by site, in order, and refuses the forbidden list too", async () => {
    const faux = new FauxDecider([{ site: "conjecture.relevance", answer: "high" }, { answer: "rfl", probabilities: { rfl: 3, simp: 1 }, costUsd: 0.5 }]);
    const r = registry(["faux"], ENV, undefined, faux);
    const order = (await r.invoke(DECIDE_ASK, ORDER)).output as { answer: string; probabilities: Record<string, number>; costUsd: number };
    assert.deepEqual([order.answer, order.probabilities.rfl, order.costUsd], ["rfl", 0.75, 0.5]);
    assert.equal(faux.calls.length, 1);
    assert.throws(() => faux.decide({ ...ORDER, site: "fidelity.review" }), /forbidden/);
  });
});

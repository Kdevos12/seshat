import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readSettingsFile, RUN_PARAMETERS, setConfig, settingsFileKeys, solveDefaultsOf, studentLines } from "@seshat/orchestrator";
import { started, type Started } from "./helpers.ts";

const open: Started[] = [];
async function server(): Promise<Started> {
  const s = await started();
  open.push(s);
  return s;
}
after(async () => {
  for (const s of open) await s.server.close();
});

describe("the catalogue the settings menu reads (GET /api/parameters)", () => {
  it("lists the entries a person sees, with their group, type, default, summary and status, and leaves out a hidden or internal one", async () => {
    const s = await server();
    const r = await s.call("GET", "/api/parameters");
    assert.equal(r.status, 200);
    const { groups, parameters } = r.json() as { groups: Array<{ id: string; summary: string }>; parameters: Array<Record<string, any>> };
    const keys = parameters.map((p) => p.key);
    const triage = parameters.find((p) => p.key === "triage");
    assert.deepEqual([triage?.group, triage?.kind, triage?.status, triage?.ui], [RUN_PARAMETERS.triage.group, "boolean", "experimental", "advanced"]);
    assert.equal(triage?.default, RUN_PARAMETERS.triage.default);
    assert.equal(triage?.summary, RUN_PARAMETERS.triage.summary);
    assert.deepEqual(parameters.find((p) => p.key === "cacheRetention")?.choices, ["none", "short", "long"]);
    for (const hidden of ["packetMode", "selection", "prompts", "optionalTools", "defaults"]) assert.equal(keys.includes(hidden), false, `${hidden} is not offered`);
    assert.deepEqual([...keys].sort(), [...settingsFileKeys()].sort(), "exactly the keys a settings file accepts");
    assert.equal(parameters.find((p) => p.key === "budget")?.solveFlag, "--max-usd");
    assert.deepEqual(groups.map((g) => g.id), [...new Set(parameters.map((p) => p.group))].sort((a, b) => groups.findIndex((g) => g.id === a) - groups.findIndex((g) => g.id === b)));
    assert.ok(groups.every((g) => g.summary !== ""));
  });

  it("for a solve, gives each entry the value solve really applies, derived from setConfig and studentLines (plan change UX2)", async () => {
    const s = await server();
    type Entry = { key: string; default: string; solveDefault?: string; solveSet?: string };
    const get = async (query: string) => ((await s.call("GET", `/api/parameters${query}`)).json() as { parameters: Entry[] }).parameters;
    const v2 = await get("?command=solve&defaults=v2");
    const of = (list: Entry[], key: string) => list.find((p) => p.key === key);
    for (const [key, shown] of [["budgetRounds", "true"], ["editTool", "true"], ["firstCases", "true"], ["budgetShare", "2"], ["lines", "M1, M10, M6"]] as const) {
      assert.equal(of(v2, key)?.solveDefault, shown, `${key} under v2`);
      assert.equal(of(v2, key)?.solveSet, "v2");
    }
    for (const p of v2) assert.equal(p.solveDefault, solveDefaultsOf("v2")[p.key], `${p.key} is what setConfig gives, nothing else`);
    assert.equal(of(v2, "lines")?.solveDefault, studentLines("v2").join(", "));
    assert.deepEqual(solveDefaultsOf("v2").budgetShare, String(setConfig("v2").budgetShare));
    const v1 = await get("?command=solve&defaults=v1");
    assert.equal(of(v1, "budgetRounds")?.solveDefault, undefined, "v1 has no rounds");
    assert.equal(of(v1, "lines")?.solveDefault, "M1, M10");
    assert.equal(of(await get("?command=solve"), "budgetRounds")?.solveDefault, "true", "solve without a set is the default set, v2");
    for (const plain of [await get(""), await get("?command=run")]) assert.equal(plain.some((p) => p.solveDefault !== undefined), false, "run and no command keep the RunConfig default");
    assert.equal((await s.call("GET", "/api/parameters?command=solve&defaults=v9")).status, 400);
  });

  it("needs the session's token", async () => {
    const s = await server();
    const response = await fetch(`${s.server.origin}/api/parameters`);
    assert.equal(response.status, 401);
  });
});

describe("starting a solve with settings", () => {
  const inputs = (s: Started) => (existsSync(join(s.runsDir, "_inputs")) ? readdirSync(join(s.runsDir, "_inputs")) : []);

  it("writes the chosen values to a settings file beside the statement and passes --settings", async () => {
    const s = await server();
    const r = await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1, settings: { triage: true, budgetShare: 3 } });
    assert.equal(r.status, 201);
    const command = r.json().job.command as string[];
    const flag = command.find((a) => a.startsWith("--settings="));
    assert.ok(flag, "the command got --settings");
    const file = flag.slice("--settings=".length);
    assert.ok(file.startsWith(join(s.runsDir, "_inputs")) && file.endsWith(".settings.json"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { triage: true, budgetShare: 3 });
    assert.equal(command.some((a) => /triage|budgetShare/.test(a)), false, "the values are not on the command line");
    // The command reads it with the reader `--settings` uses.
    assert.deepEqual(readSettingsFile(file, "solve").values, { triage: true, budgetShare: 3 });
  });

  it("passes no flag and writes no file when nothing was chosen", async () => {
    const s = await server();
    for (const settings of [undefined, {}]) {
      const r = await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1, ...(settings !== undefined ? { settings } : {}) });
      assert.equal(r.status, 201);
      assert.equal((r.json().job.command as string[]).some((a) => a.startsWith("--settings")), false);
    }
    assert.equal(inputs(s).some((n) => n.endsWith(".settings.json")), false);
  });

  it("refuses an invalid value, an unknown key and a key solve takes from a flag, starts nothing and writes nothing", async () => {
    const s = await server();
    const before = inputs(s).length;
    for (const [settings, message] of [
      [{ budgetShare: 0 }, /budgetShare must be above 0/],
      [{ triage: "yes" }, /"triage" must be a boolean/],
      [{ triag: true }, /unknown setting "triag"/],
      [{ defaults: "v1" }, /"defaults"/],
      [{ budget: { problemUsd: 1 } }, /--max-usd/],
      ["triage", /object/],
    ] as const) {
      const r = await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1, settings });
      assert.equal(r.status, 400, JSON.stringify(settings));
      assert.match(r.json().error, message);
    }
    assert.equal(inputs(s).length, before, "no file for a refused request");
    assert.equal((await s.call("GET", "/api/jobs")).json().jobs.length, 0, "nothing started");
  });
});

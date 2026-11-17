import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG, mergeSettings, parseSettings, readSettingsFile, RunSetupError, settingsFileKeys, solveSettings, type RunConfig } from "../src/index.ts";
import { check, say, demoBench, demoResume, demoRun, killedAt, ofType, tempDir } from "./m0-helpers.ts";
import { nth } from "./resume-helpers.ts";

/** The settings file of `harness run` and `harness solve` (`--settings FILE`). No Lean, model or network. */
const exec = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const write = (value: unknown): string => {
  const path = join(tempDir("settings-"), "settings.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
};
const flagged: RunConfig = { ...DEFAULT_CONFIG, selection: { ids: [] }, model: "faux/m" };
const none = () => false;

describe("reading a settings file", () => {
  it("reads keys that have no flag and keeps the file's order", () => {
    const file = readSettingsFile(write({ triage: true, budgetShare: 3 }), "run");
    assert.deepEqual(file.values, { triage: true, budgetShare: 3 });
    assert.deepEqual(file.keys, ["triage", "budgetShare"]);
    const merged = mergeSettings(flagged, file, none);
    assert.equal(merged.config.triage, true);
    assert.equal(merged.config.budgetShare, 3);
    assert.deepEqual(merged.fromFile, ["triage", "budgetShare"]);
    assert.equal(merged.config.sessions, DEFAULT_CONFIG.sessions, "what the file does not name is the flags' own");
  });

  it("lets a flag win over the file, key by key", () => {
    const file = readSettingsFile(write({ sessions: 2, provers: 3, triage: true }), "run");
    // `--sessions` was given: its flag is in the catalogue's list for `sessions`.
    const merged = mergeSettings({ ...flagged, sessions: 6 }, file, (flag) => flag === "sessions");
    assert.equal(merged.config.sessions, 6);
    assert.equal(merged.config.provers, 3);
    assert.deepEqual(merged.overruled, ["sessions"]);
    assert.deepEqual(merged.fromFile, ["provers", "triage"]);
  });

  it("refuses an unknown key, an internal key and a hidden key, each by name, and a key the catalogue makes up", () => {
    assert.throws(() => readSettingsFile(write({ triag: true }), "run"), (e) => e instanceof RunSetupError && /unknown setting "triag"/.test(e.message));
    assert.throws(() => readSettingsFile(write({ defaults: "v2" }), "run"), (e) => e instanceof RunSetupError && /"defaults" is not a setting a person gives \(the harness sets it\)/.test(e.message));
    assert.throws(() => readSettingsFile(write({ selection: { all: true } }), "run"), /"selection"/);
    assert.throws(() => readSettingsFile(write({ packetMode: "append_only" }), "run"), /"packetMode" is not a setting a person gives \(it is hidden\)/);
    assert.throws(() => readSettingsFile(write({ __proto__: 1, ["constructor"]: 1 }), "run"), /unknown setting/);
    assert.throws(() => readSettingsFile(write("[1]"), "run"), /JSON object/);
    assert.throws(() => readSettingsFile(write("{"), "run"), /not valid JSON/);
    assert.throws(() => readSettingsFile(join(tempDir("settings-"), "absent.json"), "run"), /cannot be read/);
  });

  it("checks a value as the code that reads it does: the catalogue's type, then checkConfig", () => {
    assert.throws(() => parseSettings({ triage: "yes" }, "run", "t"), /"triage" must be a boolean/);
    assert.throws(() => parseSettings({ sessions: 2.5 }, "run", "t"), /"sessions" must be a whole number/);
    assert.throws(() => parseSettings({ cacheRetention: "forever" }, "run", "t"), /"cacheRetention" must be one of none, short, long/);
    assert.throws(() => parseSettings({ budgetShare: 0 }, "run", "t"), /budgetShare must be above 0/);
    assert.throws(() => parseSettings({ checkTimeoutSec: 0.5 }, "run", "t"), /checkTimeoutSec must be at least 1 second/);
    assert.throws(() => parseSettings({ cards: { max: 0 } }, "run", "t"), RunSetupError);
    assert.throws(() => parseSettings({ tools: ["a", "a"] }, "run", "t"), /tools lists a capability twice/);
    assert.deepEqual(parseSettings({ cacheRetention: "short", editTool: true }, "run", "t").values, { cacheRetention: "short", editTool: true });
  });

  it("accepts the keys a person sees and no other", () => {
    const keys = settingsFileKeys();
    assert.ok(keys.includes("triage") && keys.includes("budgetShare") && keys.includes("model"));
    for (const hidden of ["selection", "optionalTools", "defaults", "prompts", "packetMode"]) assert.equal(keys.includes(hidden as keyof RunConfig), false, hidden);
  });
});

describe("a settings file in solve", () => {
  it("refuses the keys solve takes from its own flags, naming the flag", () => {
    assert.throws(() => parseSettings({ budget: { problemUsd: 1 } }, "solve", "t"), /"budget" is set by --max-usd in solve/);
    assert.throws(() => parseSettings({ model: "a/b" }, "solve", "t"), /--model/);
    assert.throws(() => parseSettings({ tools: ["x"] }, "solve", "t"), /--tool/);
    assert.throws(() => parseSettings({ private: true }, "solve", "t"), /--private/);
  });

  it("puts the file under the flags, and changes nothing without a file", () => {
    assert.deepEqual(solveSettings({}, undefined), { base: {}, lines: undefined, offpeak: undefined, overruled: [], fromFile: [] });
    const file = parseSettings({ triage: true, budgetShare: 3, lines: ["M1"], consolidation: false, thinkingLevel: "low" }, "solve", "t");
    const s = solveSettings({ consolidation: true, lines: ["M1", "M10"] }, file);
    assert.deepEqual(s.base, { triage: true, budgetShare: 3, thinkingLevel: "low", consolidation: true });
    assert.deepEqual(s.lines, ["M1", "M10"]);
    assert.deepEqual(s.overruled, ["consolidation", "lines"]);
    assert.deepEqual(s.fromFile, ["triage", "budgetShare", "thinkingLevel"]);
    assert.deepEqual(solveSettings({}, file).lines, ["M1"]);
  });
});

describe("a settings file in a run", () => {
  it("reaches the RunConfig that run.started records, and a resume keeps it", async () => {
    const file = readSettingsFile(write({ triage: true, budgetShare: 3 }), "run");
    const config = mergeSettings({ ...flagged, sessions: 3 }, file, none).config;
    const whole = await demoRun({ config: { sessions: 3, ...(config.triage !== undefined ? { triage: config.triage } : {}), ...(config.budgetShare !== undefined ? { budgetShare: config.budgetShare } : {}) }, responses: [check("bad"), say("NOTES: bad is not a lemma."), check("exact trivial_proof")] });
    const started = ofType(whole.events, "run.started")[0];
    assert.deepEqual([(started?.data.config as unknown as RunConfig).triage, (started?.data.config as unknown as RunConfig).budgetShare], [true, 3]);
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    const resumed = await demoResume({ dir, bench: whole.bench, responses: [check("exact trivial_proof")] });
    const again = ofType(resumed.events, "run.started")[0];
    assert.deepEqual([(again?.data.config as unknown as RunConfig).triage, (again?.data.config as unknown as RunConfig).budgetShare], [true, 3], "the resumed run's journal still holds the file's values");
    assert.equal(resumed.result.problems.length, 1);
  });

  it("stops `harness run` and `harness solve` before anything is spent on an unknown key or an internal one", async () => {
    const { checkout } = demoBench();
    const env = { ...process.env, HARNESS_HOST: "local" };
    const args = (...more: string[]) => ["--disable-warning=ExperimentalWarning", CLI, ...more];
    const failure = async (more: string[]): Promise<{ code: number; stderr: string }> => {
      try {
        await exec(process.execPath, args(...more), { env });
        return { code: 0, stderr: "" };
      } catch (error) {
        const e = error as { code: number; stderr: string };
        return { code: e.code, stderr: e.stderr };
      }
    };
    const base = ["run", "--checkout", checkout, "--all", "--model", "nowhere/none"];
    const unknown = await failure([...base, "--settings", write({ triag: true })]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown setting "triag"/);
    const internal = await failure([...base, "--settings", write({ defaults: "v1" })]);
    assert.equal(internal.code, 2);
    assert.match(internal.stderr, /"defaults" is not a setting a person gives/);
    const solve = await failure(["solve", "(n : ℕ) : n = n", "--yes", "--no-check", "--model", "nowhere/none", "--out", join(tempDir("settings-"), "run"), "--settings", write({ budget: { problemUsd: 1 } })]);
    assert.equal(solve.code, 2);
    assert.match(solve.stderr, /"budget" is set by --max-usd in solve/);
    const resumed = await failure(["run", "--resume", join(tempDir("settings-"), "absent"), "--checkout", checkout, "--settings", write({})]);
    assert.match(resumed.stderr, /--settings cannot be given with it/);
  });
});

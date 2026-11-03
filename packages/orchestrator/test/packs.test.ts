import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { leanCheckImplementation, loadCatalog, loadInstalledPacks, loadPack, Registry, type HostProfile } from "@seshat/registry";
import { BUILTIN_TOOL_NAMES, checkTools, toolName, openRegistry, REPO_ROOT, RunSetupError, type RunOptions } from "../src/index.ts";
import { addCommand, packsCommand, removeCommand } from "../src/packs-command.ts";
import { check, demoRun, ofType, tempDir } from "./m0-helpers.ts";
import { packCapability, writePack } from "../../registry/test/pack-helpers.ts";

const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] } } };

const registryWith = (dir: string) => (lean: Parameters<typeof leanCheckImplementation>[0]): RunOptions["registry"] => {
  const packs = [loadPack(dir)];
  return (journal, blobs) => new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean) }, journal, blobs, packs });
};

describe("a pack's tool in a session", () => {
  it("has a model-facing name of its pack's namespace, which no tool of the harness has", () => {
    assert.equal(toolName("pack_adder.padd"), "pack_adder_padd");
    assert.ok(BUILTIN_TOOL_NAMES.every((n) => !n.startsWith("pack_")));
  });

  it("is not a level-1 tool: checkTools refuses it unless its pack asked for level 1", () => {
    const factories = { kimina: () => ({ invoke: async () => ({}) }) };
    const plain = new Registry({ catalog, host, factories, packs: [loadPack(writePack())] });
    assert.deepEqual(checkTools(plain, ["pack_adder.padd"]), ["pack_adder.padd is not a direct capability (its exposure is deferred)"]);
    const asked = new Registry({ catalog, host, factories, packs: [loadPack(writePack({ manifest: { level1: ["pack_adder.padd"] } }))] });
    assert.deepEqual(checkTools(asked, ["pack_adder.padd"]), [], "from the session after the install");
    // the declared set a registry without the pack builds is the one it always was
    assert.deepEqual(checkTools(new Registry({ catalog, host, factories }), ["pack_adder.padd"]), ["unknown capability pack_adder.padd"]);
  });
});

describe("a run and its packs", () => {
  it("records the packs by content hash in run.started, in config.json and in the report", async () => {
    const dir = writePack();
    const pack = loadPack(dir);
    const { events, result, dir: runDir } = await demoRun({ registry: registryWith(dir), responses: [check("exact trivial_proof")] });
    const config = ofType(events, "run.started")[0]?.data.config as { packs?: unknown; registry?: string };
    assert.deepEqual(config.packs, [{ name: "adder", version: "1.0.0", hash: pack.hash }]);
    assert.deepEqual(result.report.packs, [{ name: "adder", version: "1.0.0", hash: pack.hash }]);
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, "config.json"), "utf8")).packs, config.packs);
    assert.match(readFileSync(join(runDir, "report.md"), "utf8"), new RegExp(`Packs: adder 1\\.0\\.0 \\(${pack.hash.slice(0, 12)}\\)\\.`));
    // the same packs give the same registry hash; another content does not
    const again = await demoRun({ registry: registryWith(dir), responses: [check("exact trivial_proof")] });
    assert.equal((ofType(again.events, "run.started")[0]?.data.config as { registry?: string }).registry, config.registry);
    const changed = await demoRun({ registry: registryWith(writePack({ skills: { "adding.md": "other" } })), responses: [check("exact trivial_proof")] });
    assert.notEqual((ofType(changed.events, "run.started")[0]?.data.config as { registry?: string }).registry, config.registry);
  });

  it("records nothing of packs when none is installed", async () => {
    const { events, result } = await demoRun({ responses: [check("exact trivial_proof")] });
    assert.equal("packs" in (ofType(events, "run.started")[0]?.data.config as object), false);
    assert.equal(result.report.packs, undefined);
  });
});

describe("harness add, packs and remove", () => {
  const io = (lines: string[]) => ({ out: (l: string) => lines.push(l) });

  it("round-trips, and opens a registry that has the pack's tools at level 2", () => {
    const packsDir = tempDir();
    const source = writePack();
    const lines: string[] = [];
    assert.throws(() => addCommand(source, { dir: packsDir, ...io(lines) }), (e: Error) => e instanceof RunSetupError && /--allow-programs/.test(e.message));
    assert.equal(addCommand(source, { dir: packsDir, allowPrograms: true, ...io(lines) }), 0);
    assert.match(lines.join("\n"), /installed adder 1\.0\.0 \(trust computed, hash [0-9a-f]{12}\)/);
    assert.match(lines.join("\n"), /tools \(level 2, found through tool search\): pack_adder\.padd/);
    assert.match(lines.join("\n"), /none was run/);

    const listed: string[] = [];
    packsCommand({ dir: packsDir, ...io(listed) });
    assert.match(listed.join("\n"), /^adder 1\.0\.0 {2}trust computed {2}hash [0-9a-f]{12}$/m);
    assert.match(listed.join("\n"), /runs when called: /);

    const registry = openRegistry({ host: "local", packsDir });
    assert.equal(registry.capability("pack_adder.padd").manifest.exposure, "deferred");
    assert.deepEqual(registry.packRecords().map((p) => p.name), ["adder"]);
    assert.equal(openRegistry({ host: "local", packsDir: tempDir() }).packs.length, 0);

    const removed: string[] = [];
    assert.equal(removeCommand("adder", { dir: packsDir, ...io(removed) }), 0);
    assert.match(removed.join("\n"), /removed adder 1\.0\.0/);
    const empty: string[] = [];
    packsCommand({ dir: packsDir, ...io(empty) });
    assert.deepEqual(empty, ["No pack is installed."]);
    assert.throws(() => removeCommand("adder", { dir: packsDir, ...io([]) }), RunSetupError);
    assert.deepEqual(loadInstalledPacks(packsDir), []);
  });

  it("refuses a pack that takes a capability of the repository, or claims a status write", () => {
    const packsDir = tempDir();
    const clash = writePack({ capabilities: { "lean.check": packCapability({ id: "lean.check" }) } });
    assert.throws(() => addCommand(clash, { dir: packsDir, allowPrograms: true, ...io([]) }), /tool ids start with pack_adder\./);
    const writer = writePack({ manifest: { writesClaimStatus: true } });
    assert.throws(() => addCommand(writer, { dir: packsDir, allowPrograms: true, ...io([]) }), RunSetupError);
    assert.equal(existsSync(join(packsDir, "installed", "adder")), false);
  });
});

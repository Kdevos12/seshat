import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Journal, readEvents, type Json } from "@seshat/core";
import { CapabilityError, checkCapability, loadCatalog, Registry, type HostProfile, type ImplementationFactory } from "../src/index.ts";
import { addManifest, tempDir, writeCatalog } from "./helpers.ts";

const inproc = (id: string, factory: string) => ({ id, version: "1", kind: "inproc", factory });

/** `math.add` marked as sending its terms outside: every implementation sends, none can answer locally. */
const sending = (extra: Record<string, unknown> = {}) =>
  addManifest({ implementations: [inproc("net", "net"), inproc("offline", "offline")], thirdParty: { sends: "two numbers", ...extra } });

function setup(manifest: Record<string, unknown>, use = ["net", "offline"]) {
  const calls: Json[] = [];
  const catalog = loadCatalog(writeCatalog({ "math.add": { manifest } }));
  const host: HostProfile = { host: "test", capabilities: { "math.add": { use } } };
  const factory = (name: string): ImplementationFactory => () => ({
    async invoke(input) {
      calls.push({ by: name, input });
      return { sum: 0 };
    },
  });
  const dir = tempDir();
  const journal = Journal.open(dir, "run_test");
  const registry = new Registry({ catalog, host, factories: { net: factory("net"), offline: factory("offline") }, journal });
  return { registry, calls, dir, journal };
}

describe("the third-party policy of the registry", () => {
  it("leaves a capability without the field, and a run that is not restricted, as they were", async () => {
    const plain = setup(addManifest({ implementations: [inproc("net", "net")] }), ["net"]);
    plain.registry.restrictThirdParties({ private: true });
    await plain.registry.invoke("math.add", { a: 1, b: 2 });
    assert.equal(plain.calls.length, 1);
    assert.equal(plain.registry.thirdPartyRefusal("math.add"), undefined);
    const open = setup(sending(), ["net"]);
    await open.registry.invoke("math.add", { a: 1, b: 2 });
    assert.equal(open.calls.length, 1);
    plain.journal.close();
    open.journal.close();
  });

  it("refuses a private call that cannot be made locally, before the implementation, with an error that names --private, and journals it", async () => {
    const { registry, calls, dir, journal } = setup(sending(), ["net"]);
    registry.restrictThirdParties({ private: true });
    assert.match(registry.thirdPartyRefusal("math.add") ?? "", /--private/);
    await assert.rejects(
      () => registry.invoke("math.add", { a: 1, b: 2 }, { attemptId: "att_1" }),
      (error: unknown) => error instanceof CapabilityError && error.code === "private" && /--private/.test(error.message) && error.toolRunId !== undefined,
    );
    assert.equal(calls.length, 0);
    journal.close();
    const events = readEvents(join(dir, "journal.jsonl")).filter((e) => e.type.startsWith("tool_run."));
    assert.deepEqual(events.map((e) => e.type), ["tool_run.started", "tool_run.finished"]);
    assert.equal((events[1]?.data as { outcome: string }).outcome, "error");
  });

  it("keeps to the implementations that do not send when the manifest names the ones that do", async () => {
    const { registry, calls, journal } = setup(sending({ implementations: ["net"] }));
    registry.restrictThirdParties({ private: true });
    await registry.invoke("math.add", { a: 1, b: 2 });
    assert.deepEqual(calls.map((c) => (c as { by: string }).by), ["offline"]);
    assert.equal(registry.thirdPartyRefusal("math.add"), undefined);
    journal.close();
  });

  it("forces the private form of the input, whatever the caller gave", async () => {
    const manifest = addManifest({
      input: { type: "object", required: ["a"], properties: { a: { type: "number" }, local: { type: "boolean" } }, additionalProperties: false },
      implementations: [inproc("net", "net")],
      examples: [],
      thirdParty: { sends: "a number", privateInput: { local: true } },
    });
    const { registry, calls, journal } = setup(manifest, ["net"]);
    registry.restrictThirdParties({ private: true });
    await registry.invoke("math.add", { a: 1 });
    await registry.invoke("math.add", { a: 1, local: false });
    assert.deepEqual(calls.map((c) => (c as { input: Json }).input), [{ a: 1, local: true }, { a: 1, local: true }]);
    journal.close();
  });

  it("restricts only the capabilities it is told to when a person did not agree", async () => {
    const { registry, calls, journal } = setup(sending(), ["net"]);
    registry.restrictThirdParties({ local: ["other.tool"] });
    await registry.invoke("math.add", { a: 1, b: 2 });
    assert.equal(calls.length, 1);
    registry.restrictThirdParties({ local: ["math.add"] });
    await assert.rejects(() => registry.invoke("math.add", { a: 1, b: 2 }), (e: unknown) => e instanceof CapabilityError && e.code === "private");
    assert.equal(calls.length, 1);
    journal.close();
  });

  it("checks the field when a manifest is loaded", () => {
    const bad = (thirdParty: unknown) => checkCapability("math.add", addManifest({ thirdParty }), { capability: "math.add", cases: [] });
    assert.deepEqual(bad({ sends: "x" }), []);
    assert.match(bad({}).join("\n"), /sends/);
    assert.match(bad({ sends: "x", implementations: ["nope"] }).join("\n"), /not an implementation/);
    assert.match(bad({ sends: "x", privateInput: { zzz: true } }).join("\n"), /not a field of the input/);
    assert.match(bad({ sends: "x", privateInput: { a: "text" } }).join("\n"), /thirdParty\.privateInput\.a/);
  });
});

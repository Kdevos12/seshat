import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, readEvents, type Json } from "@seshat/core";
import {
  CapabilityError,
  CatalogError,
  checkCapability,
  loadCatalog,
  Registry,
  TOOL_TIMEOUT_MARGIN_MS,
  UnavailableError,
  type HostProfile,
  type ImplementationFactory,
} from "../src/index.ts";
import { addManifest, tempDir, writeCatalog } from "./helpers.ts";

const catalog = loadCatalog(writeCatalog({ "math.add": { manifest: addManifest() } }));

const host = (use: string[], extra: Partial<HostProfile["capabilities"][string]> = {}): HostProfile => ({
  host: "test",
  capabilities: { "math.add": { use, ...extra } },
});

const add: ImplementationFactory = ({ settings }) => ({
  async invoke(input) {
    const { a, b } = input as { a: number; b: number };
    return { sum: a + b + Number(settings.offset ?? 0) };
  },
});

function withJournal<T>(fn: (journal: Journal, dir: string) => Promise<T>): Promise<T> {
  const dir = tempDir();
  const journal = Journal.open(dir, "run_test");
  return fn(journal, dir).finally(() => journal.close());
}

function toolRunEvents(dir: string) {
  return readEvents(join(dir, "journal.jsonl")).filter((e) => e.type.startsWith("tool_run."));
}

describe("Registry.invoke", () => {
  it("calls the host's implementation and records the tool run", async () => {
    await withJournal(async (journal, dir) => {
      const registry = new Registry({ catalog, host: host(["js"]), factories: { "js-add": add }, journal });
      const result = await registry.invoke("math.add", { a: 2, b: 3 }, { attemptId: "att_1" });
      assert.deepEqual(result.output, { sum: 5 });
      assert.equal(result.implementation, "js");
      assert.equal(result.version, "1");
      const [started, finished] = toolRunEvents(dir);
      assert.equal(started?.type, "tool_run.started");
      assert.deepEqual(
        { ...(started?.data as Record<string, Json>), inputHash: "" },
        { toolRunId: result.toolRunId, capability: "math.add", implementation: "js", version: "1", inputHash: "", timeoutMs: 2000, attemptId: "att_1" },
      );
      assert.equal(started?.actor, "math.add");
      assert.equal(finished?.type, "tool_run.finished");
      const data = finished?.data as Record<string, Json>;
      assert.equal(data.outcome, "ok");
      assert.deepEqual(data.summary, { sum: 5 });
      assert.match(String(data.outputHash), /^[0-9a-f]{64}$/);
      assert.equal(journal.projection.toolRuns("att_1")[0]?.outcome, "ok");
    });
  });

  it("keeps the input and output of each tool run under the hashes it records", async () => {
    await withJournal(async (journal, dir) => {
      const blobs = new BlobStore(join(dir, "blobs"));
      const registry = new Registry({ catalog, host: host(["js"]), factories: { "js-add": add }, journal, blobs });
      await registry.invoke("math.add", { b: 3, a: 2 });
      const [started, finished] = toolRunEvents(dir).map((e) => e.data as Record<string, Json>);
      assert.deepEqual(blobs.getJson(String(started?.inputHash)), { a: 2, b: 3 });
      assert.deepEqual(blobs.getJson(String(finished?.outputHash)), { sum: 5 });
    });
  });

  it("refuses an invalid input before any tool runs", async () => {
    await withJournal(async (journal, dir) => {
      const registry = new Registry({ catalog, host: host(["js"]), factories: { "js-add": add }, journal });
      await assert.rejects(
        registry.invoke("math.add", { a: 2 }),
        (error: unknown) => error instanceof CapabilityError && error.code === "invalid_input" && /missing property "b"/.test(error.message),
      );
      await assert.rejects(registry.invoke("math.sub", {}), (error: unknown) => error instanceof CapabilityError && error.code === "unknown_capability");
      assert.equal(toolRunEvents(dir).length, 0);
    });
  });

  it("records an output that breaks the manifest's schema as an error", async () => {
    await withJournal(async (journal, dir) => {
      const bad: ImplementationFactory = () => ({ invoke: async () => ({ total: 5 }) });
      const registry = new Registry({ catalog, host: host(["js"]), factories: { "js-add": bad }, journal });
      await assert.rejects(registry.invoke("math.add", { a: 2, b: 3 }), (error: unknown) => error instanceof CapabilityError && error.code === "invalid_output");
      const finished = toolRunEvents(dir)[1]?.data as Record<string, Json>;
      assert.equal(finished.outcome, "error");
      assert.equal((finished.summary as Record<string, Json>).error, "invalid_output");
    });
  });

  it("stops a call at its time limit, even when the implementation ignores the signal", async () => {
    await withJournal(async (journal, dir) => {
      let aborted = false;
      const hang: ImplementationFactory = () => ({
        invoke: (_input, { signal }) => {
          signal.addEventListener("abort", () => (aborted = true));
          return new Promise<Json>(() => {});
        },
      });
      const registry = new Registry({ catalog, host: host(["js"], { timeoutMs: 30 }), factories: { "js-add": hang }, journal });
      await assert.rejects(registry.invoke("math.add", { a: 1, b: 1 }), (error: unknown) => error instanceof CapabilityError && error.code === "timeout");
      assert.ok(aborted);
      const [started, finished] = toolRunEvents(dir);
      assert.equal((started?.data as Record<string, Json>).timeoutMs, 30);
      assert.equal((finished?.data as Record<string, Json>).outcome, "timeout");
    });
  });

  it("gives a call the time limit its input sets for the tool, plus a margin", async () => {
    const timed = loadCatalog(
      writeCatalog({
        "math.add": {
          manifest: addManifest({
            input: {
              type: "object",
              required: ["a", "b"],
              properties: { a: { type: "number" }, b: { type: "number" }, seconds: { type: "number", minimum: 0.001, maximum: 60 } },
              additionalProperties: false,
            },
            timeoutField: "seconds",
          }),
        },
      }),
    );
    const limits: number[] = [];
    const spy: ImplementationFactory = () => ({
      async invoke(_input, context) {
        limits.push(context.timeoutMs);
        return { sum: 0 };
      },
    });
    const registry = new Registry({ catalog: timed, host: host(["js"], { timeoutMs: 700 }), factories: { "js-add": spy } });
    await registry.invoke("math.add", { a: 0, b: 0 });
    await registry.invoke("math.add", { a: 0, b: 0, seconds: 2.5 });
    await registry.invoke("math.add", { a: 0, b: 0, seconds: 2.5 }, { timeoutMs: 40 });
    assert.deepEqual(limits, [700, 2500 + TOOL_TIMEOUT_MARGIN_MS, 40], "the host's limit, the tool's plus the margin, the caller's");
    assert.deepEqual(
      checkCapability("math.add", addManifest({ timeoutField: "a" }), { capability: "math.add", cases: [] }),
      ["math.add: timeoutField a must be a number field of the input, with a positive minimum and a maximum"],
    );
  });

  it("keeps what a failing implementation said, without the registry's prefix", async () => {
    const failing: ImplementationFactory = () => ({
      invoke: async () => {
        throw new Error("division by zero");
      },
    });
    const registry = new Registry({ catalog, host: host(["js"]), factories: { "js-add": failing } });
    await assert.rejects(
      registry.invoke("math.add", { a: 1, b: 0 }),
      (error: unknown) =>
        error instanceof CapabilityError &&
        error.message === "math.add/js failed: division by zero" &&
        error.details.length === 1 &&
        error.details[0] === "division by zero",
    );
  });

  it("records a call its caller abandons as aborted", async () => {
    await withJournal(async (journal, dir) => {
      const hang: ImplementationFactory = () => ({ invoke: () => new Promise<Json>(() => {}) });
      const registry = new Registry({ catalog, host: host(["js"]), factories: { "js-add": hang }, journal });
      const controller = new AbortController();
      const call = registry.invoke("math.add", { a: 1, b: 1 }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      await assert.rejects(call, (error: unknown) => error instanceof CapabilityError && error.code === "aborted");
      assert.equal((toolRunEvents(dir)[1]?.data as Record<string, Json>).outcome, "aborted");
    });
  });

  it("moves to the next implementation only when one cannot be reached", async () => {
    await withJournal(async (journal, dir) => {
      const down: ImplementationFactory = () => ({
        invoke: async () => {
          throw new UnavailableError("connection refused");
        },
      });
      const registry = new Registry({
        catalog,
        host: host(["js", "backup"], { settings: { backup: { offset: 100 } } }),
        factories: { "js-add": down, "js-add-backup": add },
        journal,
      });
      const result = await registry.invoke("math.add", { a: 1, b: 1 });
      assert.equal(result.implementation, "backup");
      assert.deepEqual(result.output, { sum: 102 });
      const finished = toolRunEvents(dir)
        .filter((e) => e.type === "tool_run.finished")
        .map((e) => (e.data as Record<string, Json>).outcome);
      assert.deepEqual(finished, ["error", "ok"]);

      const broken: ImplementationFactory = () => ({
        invoke: async () => {
          throw new Error("segmentation fault");
        },
      });
      const strict = new Registry({ catalog, host: host(["js", "backup"]), factories: { "js-add": broken, "js-add-backup": add } });
      await assert.rejects(
        strict.invoke("math.add", { a: 1, b: 1 }),
        (error: unknown) => error instanceof CapabilityError && error.code === "failed" && /segmentation fault/.test(error.message),
      );
    });
  });

  it("reports a capability as unavailable when no implementation answers", async () => {
    const failing: ImplementationFactory = () => {
      throw new Error("missing binary");
    };
    const registry = new Registry({ catalog, host: host(["js"]), factories: { "js-add": failing } });
    await assert.rejects(
      registry.invoke("math.add", { a: 1, b: 1 }),
      (error: unknown) => error instanceof CapabilityError && error.code === "unavailable" && /js: missing binary/.test(error.message),
    );
    const none = new Registry({ catalog, host: { host: "bare", capabilities: {} } });
    await assert.rejects(none.invoke("math.add", { a: 1, b: 1 }), /not offered on host bare/);
    assert.equal(none.offers("math.add"), false);
  });

  it("substitutes variables in settings when it builds an implementation", async () => {
    let seen: Json | undefined;
    const spy: ImplementationFactory = ({ settings }) => {
      seen = settings;
      return { invoke: async () => ({ sum: 0 }) };
    };
    const registry = new Registry({
      catalog,
      host: host(["backup"], { settings: { backup: { key: "${env:ADD_KEY}", url: "${env:ADD_URL:-http://localhost:1}" } } }),
      factories: { "js-add": spy, "js-add-backup": spy },
      env: { ADD_KEY: "k" },
    });
    await registry.invoke("math.add", { a: 0, b: 0 });
    assert.deepEqual(seen, { offset: 0, key: "k", url: "http://localhost:1" });

    const missing = new Registry({ catalog, host: host(["backup"], { settings: { backup: { key: "${env:ADD_KEY}" } } }), factories: { "js-add-backup": spy }, env: {} });
    await assert.rejects(missing.invoke("math.add", { a: 0, b: 0 }), /environment variable ADD_KEY not set/);
  });

  it("refuses a host that needs a factory nobody registered", () => {
    assert.throws(
      () => new Registry({ catalog, host: host(["js"]) }),
      (error: unknown) => error instanceof CatalogError && /needs the factory js-add, which is not registered/.test(error.message),
    );
  });

  it("checks the health of every implementation the host lists", async () => {
    const healthy: ImplementationFactory = () => ({ invoke: async () => ({ sum: 0 }), health: async () => ({ ok: true, detail: "fine" }) });
    const registry = new Registry({
      catalog,
      host: host(["js", "backup"]),
      factories: {
        "js-add": healthy,
        "js-add-backup": () => {
          throw new Error("no such host");
        },
      },
    });
    const entries = (await registry.health()).map(({ durationMs: _, ...rest }) => rest);
    assert.deepEqual(entries, [
      { capability: "math.add", implementation: "js", version: "1", ok: true, detail: "fine" },
      { capability: "math.add", implementation: "backup", version: "2", ok: false, detail: "no such host" },
    ]);
  });

  it("marks the entries of a capability that the host calls optional, and only those", async () => {
    const healthy: ImplementationFactory = () => ({ invoke: async () => ({ sum: 0 }), health: async () => ({ ok: true, detail: "fine" }) });
    const factories = {
      "js-add": healthy,
      "js-add-backup": () => {
        throw new Error("no such host");
      },
    };
    const optional = new Registry({ catalog, host: host(["js", "backup"], { optional: true }), factories });
    assert.deepEqual((await optional.health()).map(({ durationMs: _, ...rest }) => rest), [
      { capability: "math.add", implementation: "js", version: "1", ok: true, detail: "fine", optional: true },
      { capability: "math.add", implementation: "backup", version: "2", ok: false, detail: "no such host", optional: true },
    ]);
    // `optional: false` is the same as leaving it out: the entries carry no mark.
    const required = new Registry({ catalog, host: host(["js"], { optional: false }), factories });
    assert.deepEqual((await required.health()).map(({ durationMs: _, ...rest }) => rest), [{ capability: "math.add", implementation: "js", version: "1", ok: true, detail: "fine" }]);
  });

  it("closes what it opened", async () => {
    let closed = 0;
    const closable: ImplementationFactory = () => ({ invoke: async () => ({ sum: 0 }), close: async () => void closed++ });
    const registry = new Registry({ catalog, host: host(["js"]), factories: { "js-add": closable } });
    await registry.invoke("math.add", { a: 0, b: 0 });
    await registry.invoke("math.add", { a: 0, b: 0 });
    await registry.close();
    assert.equal(closed, 1);
  });

  it("pins the catalog and the host in its hash", () => {
    const a = new Registry({ catalog, host: host(["js"]), factories: { "js-add": add } });
    const b = new Registry({ catalog, host: host(["js"], { timeoutMs: 5 }), factories: { "js-add": add } });
    assert.notEqual(a.hash, b.hash);
  });
});

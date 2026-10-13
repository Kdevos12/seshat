import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { EventDataMap, EventType } from "@math-harness/core";
import { CapabilityError, checkCapability, loadCatalog, Registry, runContract, serverEnv, type McpTransportFactory } from "../src/index.ts";
import { attach, type Workspaces } from "./fixtures/fake-mcp-server.ts";
import { FAKE_SERVER, writeCatalog } from "./helpers.ts";

const stdio = { transport: "stdio", command: process.execPath, args: ["--disable-warning=ExperimentalWarning", FAKE_SERVER, "--version", "1.0.0"] };

/** A stateful toy capability: a value per key, kept in the scope's workspace. */
function memoManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "math.memo",
    version: 1,
    title: "Remember values",
    description: "Stores value under key when given, and returns the value stored under key.",
    when: ["keeping values between calls"],
    whenNot: ["anything else"],
    exposure: "direct",
    stateful: true,
    input: {
      type: "object",
      required: ["key"],
      properties: { key: { type: "string" }, value: { type: "number" } },
      additionalProperties: false,
    },
    output: { type: "object", required: ["value"], properties: { value: { type: ["number", "null"] } }, additionalProperties: false },
    timeoutMs: 2000,
    implementations: [
      {
        id: "fake",
        version: "1.0.0",
        kind: "mcp",
        tool: "store",
        server: stdio,
        scope: { argument: "session", release: { tool: "drop", argument: "name" } },
      },
    ],
    ...overrides,
  };
}

const host = { host: "test", capabilities: { "math.memo": { use: ["fake"] } } };

/** One in-memory server for every connection, so that a test can look at its workspaces. */
function oneServer(): { factory: McpTransportFactory; workspaces: Workspaces } {
  const workspaces: Workspaces = new Map();
  return {
    workspaces,
    factory: () => {
      const { client, server } = createInMemoryTransportPair();
      void attach(server, "1.0.0", workspaces);
      return client;
    },
  };
}

function registryWith(contract?: unknown) {
  const server = oneServer();
  const events: { type: EventType; data: unknown }[] = [];
  const journal = {
    emit<K extends EventType>(type: K, data: EventDataMap[K]) {
      events.push({ type, data });
    },
  };
  const catalog = loadCatalog(writeCatalog({ "math.memo": { manifest: memoManifest(), ...(contract !== undefined ? { contract } : {}) } }));
  const registry = new Registry({ catalog, host, journal, mcpTransport: server.factory });
  return { registry, workspaces: server.workspaces, events };
}

describe("stateful capabilities", () => {
  it("need a scope", async () => {
    const { registry } = registryWith();
    await assert.rejects(
      registry.invoke("math.memo", { key: "x" }),
      (error: unknown) => error instanceof CapabilityError && error.code === "invalid_input" && /needs a scope/.test(error.message),
    );
    await registry.close();
  });

  it("share state within a scope, and only there", async () => {
    const { registry, events } = registryWith();
    const value = async (input: { key: string; value?: number }, scope: string) => (await registry.invoke("math.memo", input, { scope })).output;
    assert.deepEqual(await value({ key: "x", value: 7 }, "s1"), { value: 7 });
    assert.deepEqual(await value({ key: "x" }, "s1"), { value: 7 });
    assert.deepEqual(await value({ key: "x" }, "s2"), { value: null });
    const scopes = events.flatMap((e) => (e.type === "tool_run.started" ? [(e.data as EventDataMap["tool_run.started"]).scope] : []));
    assert.deepEqual(scopes, ["s1", "s1", "s2"], "each tool run records its scope");
    await registry.close();
  });

  it("drop a scope's state when it is released, and only once", async () => {
    const { registry, workspaces } = registryWith();
    await registry.invoke("math.memo", { key: "x", value: 1 }, { scope: "s1" });
    await registry.invoke("math.memo", { key: "x", value: 2 }, { scope: "s2" });
    assert.deepEqual([...workspaces.keys()].sort(), ["s1", "s2"]);
    await registry.release("s1");
    assert.deepEqual([...workspaces.keys()], ["s2"]);
    // Released twice, or never used: nothing is called, so the server reports no error.
    await registry.release("s1");
    await registry.release("never");
    assert.deepEqual((await registry.invoke("math.memo", { key: "x" }, { scope: "s1" })).output, { value: null }, "a released scope starts afresh");
    await registry.close();
  });

  it("are checked when the catalog loads", () => {
    const problems = (manifest: Record<string, unknown>, contract: unknown = { capability: "math.memo", cases: [] }) =>
      checkCapability("math.memo", manifest, contract);
    const impl = (memoManifest().implementations as Record<string, unknown>[])[0] as Record<string, unknown>;
    const { scope: _scope, ...withoutScope } = impl;
    assert.deepEqual(problems(memoManifest({ implementations: [withoutScope] })), [
      "math.memo: implementation fake (mcp) of a stateful capability needs a scope",
    ]);
    assert.deepEqual(problems(memoManifest({ stateful: false })), ["math.memo: implementation fake has a scope, but the capability is not stateful"]);
    assert.deepEqual(problems(memoManifest({ implementations: [{ ...impl, scope: { argument: "key" } }] })), [
      "math.memo: implementation fake: the scope argument key is also a field of the input",
    ]);
    assert.deepEqual(
      problems(memoManifest({ stateful: false, implementations: [withoutScope] }), {
        capability: "math.memo",
        cases: [
          { name: "steps", before: [{ key: "x", value: 1 }], input: { key: "x" }, expect: [] },
          { name: "both", input: { key: "x" }, expect: [], fails: { code: "failed" } },
          { name: "neither", input: { key: "x" } },
          { name: "bad regexp", input: { key: "x" }, fails: { code: "failed", matches: "(" } },
        ],
      }),
      [
        'math.memo: contract case "steps": before needs a stateful capability',
        'math.memo: contract case "both": needs either expect or fails',
        'math.memo: contract case "neither": needs either expect or fails',
        'math.memo: contract case "bad regexp": fails.matches: Invalid regular expression: /(/u: Unterminated group',
      ],
    );
  });
});

describe("contracts of stateful capabilities", () => {
  it("run each case in a scope of its own, after its steps, and release it", async () => {
    const { registry, workspaces } = registryWith({
      capability: "math.memo",
      cases: [
        { name: "a value stored before", before: [{ key: "x", value: 3 }], input: { key: "x" }, expect: [{ path: "value", equals: 3 }] },
        { name: "a fresh scope", input: { key: "x" }, expect: [{ path: "value", equals: null }] },
        { name: "an error, as expected", input: { key: "error" }, fails: { code: "failed", matches: "is refused" } },
        { name: "another error", input: { key: "error" }, fails: { code: "timeout", matches: "^timed out" } },
        { name: "a failure expected in vain", input: { key: "x" }, fails: { code: "failed" } },
      ],
    });
    const report = await runContract(registry, "math.memo");
    assert.deepEqual(
      report.cases.map((c) => [c.name, c.passed, c.failures]),
      [
        ["a value stored before", true, []],
        ["a fresh scope", true, []],
        ["an error, as expected", true, []],
        [
          "another error",
          false,
          [
            "expected the error timeout, got failed: math.memo/fake failed: the tool reported an error: the key error is refused",
            'expected an error message matching /^timed out/, got "math.memo/fake failed: the tool reported an error: the key error is refused"',
          ],
        ],
        ["a failure expected in vain", false, ["expected the error failed, but the call succeeded"]],
      ],
    );
    assert.deepEqual([...workspaces.keys()], [], "every case's scope was released");
    await registry.close();
  });
});

describe("the environment of stdio servers", () => {
  it("holds what programs need to start, and the server's own variables, never the harness's secrets", () => {
    const env = serverEnv({ SAGE_TIMEOUT: "60", HOME: "/elsewhere" }, { PATH: "/bin", HOME: "/home/me", ANTHROPIC_API_KEY: "secret", LANG: "C" });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/elsewhere", LANG: "C", SAGE_TIMEOUT: "60" });
  });

  it("is what a spawned server sees", async () => {
    process.env.MH_TEST_SECRET = "do not pass";
    const catalog = loadCatalog(
      writeCatalog({
        "math.env": {
          manifest: {
            ...memoManifest({ id: "math.env", stateful: false }),
            input: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false },
            output: { type: "object", required: ["value"], properties: { value: { type: ["string", "null"] } } },
            implementations: [{ id: "fake", version: "1.0.0", kind: "mcp", tool: "env", server: { ...stdio, env: { MH_OWN: "${env:MH_TEST_SECRET}" } } }],
          },
        },
      }),
    );
    const registry = new Registry({ catalog, host: { host: "test", capabilities: { "math.env": { use: ["fake"] } } } });
    try {
      assert.deepEqual((await registry.invoke("math.env", { name: "MH_TEST_SECRET" })).output, { value: null });
      assert.deepEqual((await registry.invoke("math.env", { name: "MH_OWN" })).output, { value: "do not pass" }, "passed on purpose, by the spec");
      assert.notEqual((await registry.invoke("math.env", { name: "PATH" })).output, { value: null });
    } finally {
      delete process.env.MH_TEST_SECRET;
      await registry.close();
    }
  });
});

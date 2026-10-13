import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { CapabilityError, loadCatalog, Registry, type McpTransportFactory } from "../src/index.ts";
import { attach } from "./fixtures/fake-mcp-server.ts";
import { addManifest, FAKE_SERVER, writeCatalog } from "./helpers.ts";

const stdio = { transport: "stdio", command: "unused" };
const mcp = (id: string, tool: string, version = "1.0.0") => ({ id, version, kind: "mcp", tool, server: stdio });

const catalog = loadCatalog(
  writeCatalog({
    "math.add": {
      manifest: addManifest({
        implementations: [
          mcp("structured", "add"),
          mcp("text", "add_text"),
          mcp("fail", "fail"),
          mcp("slow", "slow"),
          mcp("crash", "crash"),
          mcp("newer", "add", "2.0.0"),
          mcp("missing", "multiply"),
        ],
      }),
    },
  }),
);

/** Every connection gets a fresh in-memory server; counts connections. */
function memoryServers(version = "1.0.0"): { factory: McpTransportFactory; connections: () => number } {
  let count = 0;
  return {
    factory: () => {
      count++;
      const { client, server } = createInMemoryTransportPair();
      void attach(server, version);
      return client;
    },
    connections: () => count,
  };
}

const offered = { host: "test", capabilities: { "math.add": { use: ["structured"] } } };

describe("MCP implementations", () => {
  it("reads structured content, or a JSON text block", async () => {
    const servers = memoryServers();
    const registry = new Registry({ catalog, host: offered, mcpTransport: servers.factory });
    assert.deepEqual((await registry.invoke("math.add", { a: 2, b: 5 })).output, { sum: 7 });
    assert.deepEqual((await registry.invoke("math.add", { a: 2, b: 5 }, { implementation: "text" })).output, { sum: 7 });
    await registry.invoke("math.add", { a: 1, b: 1 });
    assert.equal(servers.connections(), 2, "one connection per implementation, kept between calls");
    await registry.close();
  });

  it("treats a tool error as a failure on this input", async () => {
    const registry = new Registry({ catalog, host: offered, mcpTransport: memoryServers().factory });
    await assert.rejects(
      registry.invoke("math.add", { a: -1, b: 0 }, { implementation: "fail" }),
      (error: unknown) => error instanceof CapabilityError && error.code === "failed" && /a must be positive/.test(error.message),
    );
    await registry.close();
  });

  it("refuses a server that does not report the pinned version, or lacks the tool", async () => {
    const registry = new Registry({ catalog, host: offered, mcpTransport: memoryServers().factory });
    await assert.rejects(
      registry.invoke("math.add", { a: 1, b: 1 }, { implementation: "newer" }),
      (error: unknown) => error instanceof CapabilityError && error.code === "unavailable" && /reports version 1\.0\.0, the manifest pins 2\.0\.0/.test(error.message),
    );
    await assert.rejects(
      registry.invoke("math.add", { a: 1, b: 1 }, { implementation: "missing" }),
      /has no tool multiply \(it has add, add_text, fail, slow, crash\)/,
    );
    await registry.close();
  });

  it("cancels a call that runs past its time limit", async () => {
    const registry = new Registry({ catalog, host: offered, mcpTransport: memoryServers().factory });
    await assert.rejects(
      registry.invoke("math.add", { a: 1, b: 1 }, { implementation: "slow", timeoutMs: 50 }),
      (error: unknown) => error instanceof CapabilityError && error.code === "timeout",
    );
    await registry.close();
  });

  it("connects again after the server went away", async () => {
    const servers = memoryServers();
    const host = { host: "test", capabilities: { "math.add": { use: ["crash"] } } };
    const registry = new Registry({ catalog, host, mcpTransport: servers.factory });
    await assert.rejects(registry.invoke("math.add", { a: 1, b: 1 }), (error: unknown) => error instanceof CapabilityError && error.code === "failed");
    await assert.rejects(registry.invoke("math.add", { a: 1, b: 1 }), (error: unknown) => error instanceof CapabilityError && error.code === "failed");
    assert.equal(servers.connections(), 2);
    await registry.close();
  });
});

describe("MCP over stdio", () => {
  const stdioCatalog = loadCatalog(writeCatalog({ "math.add": { manifest: addManifest() } }));
  const registries: Registry[] = [];
  after(async () => {
    for (const registry of registries) await registry.close();
  });

  it("spawns the server, calls its tool and reports its health", async () => {
    const registry = new Registry({ catalog: stdioCatalog, host: { host: "test", capabilities: { "math.add": { use: ["fake-mcp"] } } } });
    registries.push(registry);
    const result = await registry.invoke("math.add", { a: 20, b: 22 });
    assert.deepEqual(result.output, { sum: 42 });
    assert.equal(result.version, "1.0.0");
    const [health] = await registry.health();
    assert.equal(health?.ok, true);
    assert.equal(health?.detail, "fake-math 1.0.0");
  });

  it("reports a server that fails to start, with its stderr", async () => {
    const host = {
      host: "test",
      capabilities: {
        "math.add": {
          use: ["fake-mcp"],
          settings: { "fake-mcp": { args: ["--disable-warning=ExperimentalWarning", FAKE_SERVER, "--fail-start"] } },
        },
      },
    };
    const registry = new Registry({ catalog: stdioCatalog, host });
    registries.push(registry);
    await assert.rejects(
      registry.invoke("math.add", { a: 1, b: 1 }),
      (error: unknown) => error instanceof CapabilityError && error.code === "unavailable" && /cannot load the solver/.test(error.message),
    );
  });
});

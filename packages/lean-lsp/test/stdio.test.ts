import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { Json } from "@seshat/core";
import { UnavailableError } from "@seshat/registry";
import { DISABLED_TOOLS, leanLspFactory, type LeanLspImplementation } from "../src/index.ts";
import { capability, invoke, onSketch, spec, tempProject } from "./helpers.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-lean-lsp-mcp.ts", import.meta.url));

/** The factory over the stand-in server as a child process on stdio, the way it would start the real one. */
function child(settings: Record<string, Json> = {}): { impl: LeanLspImplementation; project: string } {
  const project = tempProject();
  const impl = leanLspFactory()({
    capability: capability.manifest,
    spec,
    settings: {
      ...(spec.settings ?? {}),
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", FAKE],
      projectDir: project,
      ...settings,
    },
  }) as LeanLspImplementation;
  return { impl, project };
}

/** What the child sees of a variable: the stand-in answers a Loogle query `env:NAME` with its value. */
async function seen(impl: LeanLspImplementation, name: string): Promise<string> {
  const answer = (await invoke(impl, { op: "loogle", query: `env:${name}` })) as { results: Array<{ name: string }> };
  return answer.results[0]?.name ?? "";
}

describe("lean.lsp over a server process on stdio", () => {
  it("starts the server on the project, with the other 14 tools switched off, and finds the eight it uses", async () => {
    const { impl, project } = child();
    try {
      const health = await impl.health({ signal: new AbortController().signal });
      assert.equal(health.ok, true, health.detail);
      assert.match(health.detail ?? "", /^Lean LSP 0\.31\.0, 8 tools used; project /);
      assert.doesNotMatch(health.detail ?? "", /never calls/, "the server lists no tool the harness does not use");
      assert.equal(await seen(impl, "LEAN_PROJECT_PATH"), project);
      assert.equal(await seen(impl, "LEAN_MCP_DISABLED_TOOLS"), DISABLED_TOOLS.join(","));
    } finally {
      await impl.close();
    }
  });

  it("answers a file operation from the file that it wrote in the project", async () => {
    const { impl } = child();
    try {
      const answer = (await invoke(impl, onSketch({ op: "goal", line: 1 }))) as { goalsBefore: string[]; goalsAfter: string[]; lineText: string };
      assert.deepEqual([answer.lineText, answer.goalsBefore.length, answer.goalsAfter.length], ["  sorry", 1, 0]);
    } finally {
      await impl.close();
    }
  });

  it("gives the server the sites a host names, and none of the harness's own environment", async () => {
    process.env.SESHAT_TEST_SECRET = "do-not-pass";
    process.env.HTTPS_PROXY = "http://proxy.invalid:3128";
    const { impl } = child({ loogleUrl: "http://127.0.0.1:8088", hammerUrl: "http://127.0.0.1:8090", leanFinderUrl: "http://127.0.0.1:8089", maxOpenFiles: 9 });
    try {
      assert.equal(await seen(impl, "LOOGLE_URL"), "http://127.0.0.1:8088");
      assert.equal(await seen(impl, "LEAN_HAMMER_URL"), "http://127.0.0.1:8090");
      assert.equal(await seen(impl, "LEAN_FINDER_URL"), "http://127.0.0.1:8089");
      assert.equal(await seen(impl, "LEAN_LSP_MAX_OPEN_FILES"), "9");
      assert.equal(await seen(impl, "SESHAT_TEST_SECRET"), "(unset)");
      assert.equal(await seen(impl, "HTTPS_PROXY"), "(unset)", "a proxy is the host's to name, in the env setting");
    } finally {
      await impl.close();
      delete process.env.SESHAT_TEST_SECRET;
      delete process.env.HTTPS_PROXY;
    }
  });

  it("passes the host's own variables, such as a proxy, but not the ones the harness sets", async () => {
    const { impl } = child({ env: { HTTPS_PROXY: "http://proxy.invalid:3128" } });
    try {
      assert.equal(await seen(impl, "HTTPS_PROXY"), "http://proxy.invalid:3128");
    } finally {
      await impl.close();
    }
    assert.throws(
      () => child({ env: { LEAN_MCP_DISABLED_TOOLS: "lean_build" } }),
      /the host cannot set LEAN_MCP_DISABLED_TOOLS: the harness sets them/,
    );
    assert.throws(() => child({ env: { LEAN_PROJECT_PATH: "/" } }), /the host cannot set LEAN_PROJECT_PATH/);
  });

  it("takes an empty variable of the host for no variable, and the harness's value stands", async () => {
    const { impl } = child({ env: { LEAN_MCP_DISABLED_TOOLS: "" } });
    try {
      assert.equal(await seen(impl, "LEAN_MCP_DISABLED_TOOLS"), DISABLED_TOOLS.join(","));
    } finally {
      await impl.close();
    }
  });

  it("is not healthy when the server it starts is not the pinned release", async () => {
    const { impl } = child({ env: { FAKE_LEAN_LSP_VERSION: "0.30.2" } });
    try {
      const health = await impl.health({ signal: new AbortController().signal });
      assert.equal(health.ok, false);
      assert.match(health.detail ?? "", /reports version 0\.30\.2, the manifest pins 0\.31\.0/);
    } finally {
      await impl.close();
    }
  });

  it("tells a prover that a server which died is unavailable, without the project's path, which its own words may hold", async () => {
    const script = "console.error('cannot open ' + process.env.LEAN_PROJECT_PATH + '/Main.lean'); process.exit(1)";
    const { impl, project } = child({ command: process.execPath, args: ["-e", script] });
    try {
      await assert.rejects(invoke(impl, onSketch({ op: "goal", line: 1 })), (error: unknown) => {
        assert.ok(error instanceof UnavailableError);
        assert.match(error.message, /^cannot start the Lean language server: .*\(stderr: cannot open <project>\/Main\.lean\)$/);
        assert.ok(!error.message.includes(project));
        return true;
      });
      // The operator's health check keeps the whole text.
      const health = await impl.health({ signal: new AbortController().signal });
      assert.equal(health.ok, false);
      assert.ok((health.detail ?? "").includes(`cannot open ${project}/Main.lean`), health.detail);
    } finally {
      await impl.close();
    }
  });

  it("reports a server that is not there as unavailable, with what the system said", async () => {
    const { impl } = child({ command: "/nowhere/lean-lsp-mcp", args: [] });
    try {
      const health = await impl.health({ signal: new AbortController().signal });
      assert.equal(health.ok, false);
      assert.match(health.detail ?? "", /ENOENT|not found|spawn/i);
    } finally {
      await impl.close();
    }
  });
});

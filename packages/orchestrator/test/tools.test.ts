import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { loadCatalog, Registry, type HostProfile } from "@seshat/registry";
import { capabilityTool, checkTools, PROMPT_VERSION, REPO_ROOT, renderOutput, RunSetupError, systemPrompt, toolDescription, toolName } from "../src/index.ts";
import { fakeSage, refusal } from "./fixtures/fake-sage.ts";
import { call, check, demoRegistry, demoRun, ofType, say, sageRegistry, tempDir } from "./m0-helpers.ts";

const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));

describe("tools besides lean_check", () => {
  it("are named after their capability, and must be direct and offered", () => {
    assert.equal(toolName("compute.sage"), "compute_sage");
    const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] } } };
    const registry = new Registry({ catalog, host, factories: { kimina: () => ({ invoke: async () => ({}) }) } });
    assert.deepEqual(checkTools(registry, ["compute.sage", "lean.check", "nope.tool"]), [
      "host test does not offer compute.sage",
      "lean.check is always given, as lean_check",
      "unknown capability nope.tool",
    ]);
  });

  it("show outputs one field per line, without the empty ones", () => {
    assert.equal(
      renderOutput({ result_type: "expression", result: "[  -2    1]\n[ 3/2 -1/2]", latex: null, stdout: "3 5\n", elapsed_ms: 11.13988 }),
      "result_type: expression\nresult:\n  [  -2    1]\n  [ 3/2 -1/2]\nstdout: 3 5\nelapsed_ms: 11.14",
    );
    assert.equal(renderOutput({ latex: null, stdout: "" }), "(no output)");
    assert.equal(renderOutput([1, 2]), "[1,2]");
  });

  it("describe their capability to the model, with examples as it will read them", () => {
    const text = toolDescription(catalog.capabilities.get("compute.sage")?.manifest as never);
    assert.match(text, /^Compute with SageMath\. Runs SageMath code/);
    assert.match(text, /\nUse it for:\n- testing a statement on small cases/);
    assert.match(text, /\nDo not use it for:\n- proving the theorem/);
    assert.match(text, /\n- a factorization: \{"code":"factor\(2\^64 \+ 1\)"\} returns\n {2}result_type: expression\n {2}result: 274177 \* 67280421310721\n/);
  });

  it("are named in the system prompt, which is unchanged without them", () => {
    assert.equal(PROMPT_VERSION, "m0-2.1");
    assert.doesNotMatch(systemPrompt(4000), /# Other tools/);
    assert.match(systemPrompt(4000, ["compute_sage"]), /\n# Other tools\nBesides lean_check you have: compute_sage\. .* only lean_check decides\./);
  });

  it("stop trying a capability that cannot be reached, for the rest of the session", async () => {
    let connections = 0;
    const host: HostProfile = { host: "test", capabilities: { "compute.sage": { use: ["local"] } } };
    const registry = new Registry({
      catalog,
      host,
      mcpTransport: () => {
        connections++;
        return fakeSage("0.9.4").transport();
      },
    });
    const tool = capabilityTool("compute.sage", { registry, attemptId: "att_1", actor: "prover:p1" });
    const first = await tool.execute("c1", { code: "1 + 1" } as never);
    const second = await tool.execute("c2", { code: "1 + 1" } as never);
    assert.equal(first.isError, true);
    assert.match((first.content[0] as { text: string }).text, /^Error: compute_sage cannot be reached \(.*reports version 0\.9\.4, the manifest pins 0\.9\.5.*\)\. Go on without it/);
    assert.match((second.content[0] as { text: string }).text, /^Error: compute_sage is unavailable in this session/);
    assert.equal(connections, 1);
    await registry.close();
  });
});

describe("M0 with compute.sage", () => {
  it("gives each attempt its own SageMath session, ended with the attempt, and reports the calls", async () => {
    const sage = fakeSage();
    const { result, events, dir } = await demoRun({
      registry: sageRegistry(sage),
      config: { tools: ["compute.sage"], sessions: 2 },
      responses: [
        call("compute_sage", { code: "graph = petersen" }),
        call("compute_sage", { code: "graph" }),
        say("graph is the Petersen graph; next, prove it by trivial_proof."),
        call("compute_sage", { code: "graph" }),
        call("compute_sage", { code: "fail" }),
        check("exact trivial_proof"),
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const attempts = ofType(events, "attempt.started").map((e) => e.data.attemptId);
    assert.equal(attempts.length, 2);
    const [a1, a2] = attempts as [string, string];
    assert.deepEqual(
      sage.calls.map((c) => [c.tool, c.args.session ?? c.args.name, c.args.code ?? null]),
      [
        ["evaluate_sage", a1, "graph = petersen"],
        ["evaluate_sage", a1, "graph"],
        ["stop_sage_session", a1, null],
        ["evaluate_sage", a2, "graph"],
        ["evaluate_sage", a2, "fail"],
        ["stop_sage_session", a2, null],
      ],
    );
    assert.equal(sage.workspaces.size, 0, "every attempt's workspace was ended");

    const seen = (attemptId: string) =>
      (JSON.parse(readFileSync(join(dir, "transcripts", `${attemptId}.json`), "utf8")) as AgentMessage[]).flatMap((m) =>
        m.role === "toolResult" && m.toolName === "compute_sage" ? [[(m.content[0] as { text: string }).text, m.isError]] : [],
      );
    assert.deepEqual(seen(a1), [
      ["result_type: statement\nelapsed_ms: 1.5", false],
      ["result_type: expression\nresult: petersen\nelapsed_ms: 1.5", false],
    ]);
    assert.deepEqual(seen(a2), [
      [`Error: ${refusal("graph")}`, true],
      ["Error: (no message)", true],
    ]);

    const runs = ofType(events, "tool_run.started").filter((e) => e.data.capability === "compute.sage");
    assert.deepEqual(
      runs.map((e) => [e.data.attemptId, e.data.scope, e.data.implementation, e.data.version]),
      [[a1, a1, "local", "0.9.5"], [a1, a1, "local", "0.9.5"], [a2, a2, "local", "0.9.5"], [a2, a2, "local", "0.9.5"]],
    );
    const started = ofType(events, "run.started")[0]?.data.config as { tools: unknown[]; prompt: { version: string } };
    assert.deepEqual(started.tools, [{ capability: "compute.sage", implementation: "local", version: "0.9.5" }]);
    assert.equal(started.prompt.version, "m0-2.1");
    assert.deepEqual(result.report.tools, { "compute.sage": { calls: 4, outcomes: { ok: 2, error: 2 }, attempts: 2, proofs: 1 } });
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), /tools: lean_check, compute\.sage \(local 0\.9\.5\)\.[\s\S]*\ncompute\.sage: 4 call\(s\) \(2 ok, 2 error\) in 2 attempt\(s\), 1 of which found a proof\./);
  });

  it("pins each tool to the first implementation that answers, for the whole run", async () => {
    const sage = fakeSage();
    const logged: string[] = [];
    const { result, events } = await demoRun({
      registry: sageRegistry(sage, ["docker", "local"], { docker: fakeSage("0.9.4") }),
      config: { tools: ["compute.sage"] },
      log: (line) => logged.push(line),
      responses: [call("compute_sage", { code: "1 + 1" }), call("compute_sage", { code: "2 + 2" }), check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const started = ofType(events, "run.started")[0]?.data.config as { tools: unknown[] };
    assert.deepEqual(started.tools, [{ capability: "compute.sage", implementation: "local", version: "0.9.5" }]);
    const runs = ofType(events, "tool_run.started").filter((e) => e.data.capability === "compute.sage");
    assert.deepEqual(runs.map((e) => e.data.implementation), ["local", "local"], "no call went to docker first");
    assert.deepEqual(result.report.tools["compute.sage"]?.outcomes, { ok: 2 });
    assert.ok(logged.includes("compute.sage uses local, because docker: the MCP server reports version 0.9.4, the manifest pins 0.9.5"), logged.join("\n"));
  });

  it("refuses to start with tools it cannot give", async () => {
    const attempt = async (tools: string[], registry?: Parameters<typeof demoRun>[0]["registry"]): Promise<string> => {
      try {
        await demoRun({ responses: [], config: { tools }, ...(registry !== undefined ? { registry } : {}) });
      } catch (error) {
        assert.ok(error instanceof RunSetupError);
        return error.message;
      }
      return assert.fail("the run started");
    };
    assert.match(await attempt(["compute.sage"], demoRegistry), /^the tools of the run: host test does not offer compute\.sage$/);
    assert.match(await attempt(["lean.check"]), /lean\.check is always given/);
    assert.match(
      await attempt(["compute.sage"], sageRegistry(fakeSage("0.9.4"))),
      /^compute\.sage cannot be reached on host test \(local: the MCP server reports version 0\.9\.4, the manifest pins 0\.9\.5\)$/,
    );
    assert.match(
      await attempt(["compute.sage"], sageRegistry(fakeSage("0.9.4"), ["docker", "local"])),
      /^compute\.sage cannot be reached on host test \(docker: the MCP server reports version 0\.9\.4.*; local: the MCP server reports version 0\.9\.4.*\)$/,
    );
    assert.match(await attempt(["compute.sage", "compute.sage"]), /tools lists a capability twice/);
  });

  it("leaves no run directory behind when the tools are refused", async () => {
    const dir = join(tempDir(), "run");
    await assert.rejects(demoRun({ responses: [], config: { tools: ["nope.tool"] }, dir }), /unknown capability nope\.tool/);
    assert.equal(existsSync(dir), false);
  });
});

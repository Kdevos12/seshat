import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, readEvents, type Json } from "@seshat/core";
import { CapabilityError, loadHostProfile, Registry, type HostProfile, type McpServerSpec } from "@seshat/registry";
import { leanLspFactory, LEAN_LSP_MCP_VERSION } from "../src/index.ts";
import { FakeLeanLspMcp } from "./fixtures/fake-lean-lsp-mcp.ts";
import { catalog, onSketch, REPO, standIns, tempDir, tempProject } from "./helpers.ts";

interface Over {
  registry: Registry;
  fake: FakeLeanLspMcp;
  project: string;
  dir: string;
  journal: Journal;
  blobs: BlobStore;
  /** The stdio servers the factory was asked to start. */
  started: Array<Extract<McpServerSpec, { transport: "stdio" }>>;
}

/** The catalog's `lean.lsp` over a fake server, on a host that lists it alone, with a journal. */
async function over(run: (o: Over) => Promise<void>, settings: Record<string, Json> = {}, fake = new FakeLeanLspMcp()): Promise<void> {
  const project = tempProject();
  fake.projectDir = project;
  const dir = tempDir();
  const journal = Journal.open(dir, "run_lsp");
  const blobs = new BlobStore(join(dir, "blobs"));
  const started: Over["started"] = [];
  const host: HostProfile = { host: "test", capabilities: { "lean.lsp": { use: ["lean-lsp-mcp"], settings: { "lean-lsp-mcp": { projectDir: project, ...settings } } } } };
  const registry = new Registry({
    catalog,
    host,
    factories: {
      "lean-lsp": leanLspFactory({
        transport: (server) => {
          started.push(server);
          return fake.transport();
        },
      }),
    },
    journal,
    blobs,
  });
  try {
    await run({ registry, fake, project, dir, journal, blobs, started });
  } finally {
    await registry.close();
    journal.close();
  }
}

const events = (dir: string) => readEvents(join(dir, "journal.jsonl")).filter((e) => e.type.startsWith("tool_run."));
const att = { attemptId: "att_1", scope: "att_1", actor: "prover:p1" };

/** One valid call of each operation, on the contract's sketch (`seshat_contract`, the proof `sorry` on its line 1). */
const CALLS: Record<string, Record<string, Json>> = {
  goal: onSketch({ op: "goal", line: 1 }) as Record<string, Json>,
  term_goal: onSketch({ op: "term_goal", line: 1 }) as Record<string, Json>,
  diagnostics: onSketch({ op: "diagnostics" }) as Record<string, Json>,
  multi_attempt: onSketch({ op: "multi_attempt", line: 1, tactics: ["omega", "simp"] }) as Record<string, Json>,
  loogle: { op: "loogle", query: "|- _ + 0 = _" },
  leansearch: { op: "leansearch", query: "adding zero" },
  state_search: onSketch({ op: "state_search", line: 1 }) as Record<string, Json>,
  hammer_premise: onSketch({ op: "hammer_premise", line: 1 }) as Record<string, Json>,
};

describe("lean.lsp through the registry", () => {
  it("answers each of its eight operations in the manifest's output schema, and records each call as a tool run", async () => {
    await over(async ({ registry, dir, journal }) => {
      assert.deepEqual(Object.keys(CALLS), catalog.capabilities.get("lean.lsp")?.manifest.input.properties?.op?.enum);
      for (const [op, input] of Object.entries(CALLS)) {
        const result = await registry.invoke("lean.lsp", input, att);
        assert.equal((result.output as { op: string }).op, op);
        assert.equal(result.implementation, "lean-lsp-mcp");
        assert.equal(result.version, LEAN_LSP_MCP_VERSION);
      }
      const runs = events(dir);
      assert.equal(runs.length, 16, "a start and an end for each call");
      const started = runs.filter((e) => e.type === "tool_run.started").map((e) => e.data as Record<string, Json>);
      assert.deepEqual(
        started.map((d) => [d.capability, d.implementation, d.version, d.attemptId, d.timeoutMs]),
        Object.keys(CALLS).map(() => ["lean.lsp", "lean-lsp-mcp", "0.31.0", "att_1", 180_000]),
      );
      assert.ok(runs.filter((e) => e.type === "tool_run.started").every((e) => e.actor === "prover:p1"));
      const finished = runs.filter((e) => e.type === "tool_run.finished").map((e) => e.data as Record<string, Json>);
      assert.ok(finished.every((d) => d.outcome === "ok"));
      assert.deepEqual(
        finished.map((d) => (d.summary as Record<string, Json>).op),
        Object.keys(CALLS),
        "the summary names the operation",
      );
      assert.equal(journal.projection.toolRuns("att_1").length, 8);
    });
  });

  it("keeps the input and the output of a call as blobs, and puts nothing of Lean's judgment in the journal", async () => {
    await over(async ({ registry, dir, blobs, journal }) => {
      const input = CALLS.goal as Record<string, Json>;
      await registry.invoke("lean.lsp", input, att);
      const [started, finished] = events(dir).map((e) => e.data as Record<string, Json>);
      assert.deepEqual(blobs.getJson(String(started?.inputHash)), input);
      const output = blobs.getJson(String(finished?.outputHash)) as Record<string, Json>;
      assert.equal(output.op, "goal");
      // The registry's events are tool runs: a diagnostic of the language server is not a validation or a status.
      const types = new Set(readEvents(join(dir, "journal.jsonl")).map((e) => e.type));
      assert.ok(![...types].some((t) => t.startsWith("validation.") || t.startsWith("claim.")), [...types].join(", "));
      assert.equal(journal.projection.toolRuns("att_1")[0]?.outcome, "ok");
    });
  });

  it("refuses an input that names a path or an operation beyond the eight, before the server hears of it", async () => {
    await over(async ({ registry, fake, dir }) => {
      const bad: Array<[Record<string, Json>, RegExp]> = [
        [{ op: "goal", line: 1, file_path: "/etc/passwd" }, /unexpected property "file_path"/],
        [{ op: "goal", line: 1, path: "Mathlib/Order/Basic.lean" }, /unexpected property "path"/],
        [{ op: "goal", line: 1, filePath: "x.lean" }, /unexpected property "filePath"/],
        [{ op: "build" }, /op: /],
        [{ op: "run_code", code: "#eval 1" }, /op: /],
        [{ op: "file_contents", file: "Main.lean" }, /op: /],
        [{ op: "declaration_file", name: "Nat.add" }, /op: /],
        [{ op: "goal", line: 0 }, /line/],
        [{ op: "multi_attempt", line: 1, tactics: [] }, /tactics/],
        [{ op: "multi_attempt", line: 1, tactics: Array(9).fill("simp") }, /tactics/],
        [{ op: "loogle", query: "" }, /query/],
        [{ op: "loogle", query: "x".repeat(501) }, /query/],
        [{ op: "loogle", query: "x", limit: 31 }, /limit/],
        [{ op: "goal", line: 1, timeoutSec: 301 }, /timeoutSec/],
        [{ op: "goal", line: 1, region: "fixed" }, /region/],
        [{ op: "goal", line: 1, sketch: { fullName: "x" } }, /sketch/],
        [{ line: 1 }, /op/],
      ];
      for (const [input, pattern] of bad) {
        await assert.rejects(
          registry.invoke("lean.lsp", input, att),
          (error: unknown) => error instanceof CapabilityError && error.code === "invalid_input" && pattern.test(error.message),
          JSON.stringify(input).slice(0, 80),
        );
      }
      assert.equal(fake.connections, 0, "no server was started");
      assert.equal(events(dir).length, 0, "an invalid input is no tool run");
    });
  });

  it("keeps a file for each scope, so a call needs a scope, and ends the file with the scope", async () => {
    await over(async ({ registry, project }) => {
      await assert.rejects(
        registry.invoke("lean.lsp", CALLS.goal as Record<string, Json>, { attemptId: "att_1" }),
        (error: unknown) => error instanceof CapabilityError && error.code === "invalid_input" && /needs a scope/.test(error.message),
      );
      await registry.invoke("lean.lsp", CALLS.goal as Record<string, Json>, { attemptId: "att_1", scope: "att_1" });
      await registry.invoke("lean.lsp", CALLS.goal as Record<string, Json>, { attemptId: "att_2", scope: "att_2" });
      const scratch = join(project, ".seshat-lsp");
      assert.equal(readdirSync(scratch).filter((f) => f.endsWith(".lean")).length, 2);
      await registry.release("att_1");
      assert.equal(readdirSync(scratch).filter((f) => f.endsWith(".lean")).length, 1);
      await registry.release("att_2");
      assert.deepEqual(readdirSync(scratch).filter((f) => f.endsWith(".lean")), []);
    });
  });

  it("leaves the project as it was, but for its scratch directory", async () => {
    await over(async ({ registry, project }) => {
      await registry.invoke("lean.lsp", CALLS.goal as Record<string, Json>, att);
      await registry.release("att_1");
      assert.deepEqual(readdirSync(project).sort(), [".seshat-lsp", "lakefile.toml", "lean-toolchain"]);
    });
  });

  it("is unavailable, not failed, when there is no project, so that a host can go on without it", async () => {
    await over(
      async ({ registry, dir }) => {
        await assert.rejects(
          registry.invoke("lean.lsp", CALLS.goal as Record<string, Json>, att),
          (error: unknown) => error instanceof CapabilityError && error.code === "unavailable" && /needs the Lean project/.test(error.message),
        );
        assert.equal(events(dir).length, 0, "no implementation was there to make a tool run");
        const [health] = await registry.health("lean.lsp");
        assert.equal(health?.ok, false);
        assert.match(health?.detail ?? "", /LEAN_PROJECT_DIR/);
      },
      { projectDir: "" },
    );
  });

  it("is unavailable when the server dies in a call, and answers again once a new one starts", async () => {
    await over(async ({ registry, fake, dir }) => {
      fake.on("lean_goal", (_args, f) => {
        f.crash();
        return { structured: {} };
      });
      await assert.rejects(
        registry.invoke("lean.lsp", CALLS.goal as Record<string, Json>, att),
        (error: unknown) => error instanceof CapabilityError && error.code === "unavailable" && /Lean language server stopped/.test(error.message),
      );
      const lost = events(dir).map((e) => e.data as Record<string, Json>).find((d) => "outcome" in d);
      assert.deepEqual([lost?.outcome, (lost?.summary as Record<string, Json>).error], ["error", "unavailable"]);
      fake.on("lean_goal", (args, f) => {
        const lines = f.lines(String(args.file_path));
        return { structured: { line_context: lines[Number(args.line) - 1], goals: null, goals_before: ["n : ℕ\n⊢ n + 0 = n"], goals_after: [], status: null } };
      });
      const again = await registry.invoke("lean.lsp", CALLS.goal as Record<string, Json>, att);
      assert.deepEqual((again.output as { goalsAfter?: string[] }).goalsAfter ?? [], []);
      assert.equal(fake.connections, 2);
    });
  });

  it("reports its health: the pinned version, and the eight tools it uses", async () => {
    await over(async ({ registry, project }) => {
      const [ok] = await registry.health("lean.lsp");
      assert.equal(ok?.ok, true, ok?.detail);
      assert.equal(ok?.version, "0.31.0");
      assert.match(ok?.detail ?? "", /^Lean LSP 0\.31\.0, 8 tools used; project /);
      assert.ok((ok?.detail ?? "").endsWith(project));
    });
    await over(
      async ({ registry }) => {
        const [old] = await registry.health("lean.lsp");
        assert.equal(old?.ok, false);
        assert.match(old?.detail ?? "", /reports version 0\.30\.0, the manifest pins 0\.31\.0/);
      },
      {},
      new FakeLeanLspMcp({ version: "0.30.0" }),
    );
    await over(
      async ({ registry }) => {
        const [partial] = await registry.health("lean.lsp");
        assert.equal(partial?.ok, false);
        assert.match(partial?.detail ?? "", /lean_goal/);
      },
      {},
      new FakeLeanLspMcp({ tools: ["lean_loogle"] }),
    );
  });

  it("starts the pinned release with uvx unless the host names another command, and sets what the server needs", async () => {
    await over(async ({ registry, started, project }) => {
      await registry.health("lean.lsp");
      const [server] = started;
      assert.equal(server?.command, "uvx");
      assert.deepEqual(server?.args, ["--from", "lean-lsp-mcp==0.31.0", "--with", "leanclient==0.13.2", "lean-lsp-mcp"]);
      assert.equal(server?.env?.LEAN_PROJECT_PATH, project);
      assert.equal(server?.env?.LEAN_MCP_DISABLED_TOOLS?.split(",").length, 14);
    });
    await over(
      async ({ registry, started }) => {
        await registry.health("lean.lsp");
        const [server] = started;
        assert.equal(server?.command, "/opt/lsp/lean-lsp-mcp");
        assert.deepEqual(server?.args, []);
        assert.equal(server?.env?.LOOGLE_URL, "http://localhost:8088");
        assert.equal(server?.env?.LEAN_LSP_MAX_OPEN_FILES, "12");
      },
      { command: "/opt/lsp/lean-lsp-mcp", loogleUrl: "http://localhost:8088", maxOpenFiles: 12 },
    );
  });

  it("passes the host's args as given: they are the operator's, and the page says what a flag can change", async () => {
    // Not refused, unlike the variables of `env` that change what the server may do: the decision is
    // that `args` is trusted (documentation/lean-lsp.md, "Settings").
    await over(
      async ({ registry, started }) => {
        const [health] = await registry.health("lean.lsp");
        assert.equal(health?.ok, true);
        const [server] = started;
        assert.deepEqual(server?.args, ["--repl", "--loogle-local", "--lean-project-path", "/elsewhere"]);
        assert.equal(server?.env?.LEAN_MCP_DISABLED_TOOLS?.split(",").length, 14, "the harness still sets its own variables");
      },
      { command: "/opt/lsp/lean-lsp-mcp", args: ["--repl", "--loogle-local", "--lean-project-path", "/elsewhere"] },
    );
  });
});

describe("the host profiles of the repository", () => {
  it("offer lean.lsp on a Lean project named by LEAN_PROJECT_DIR, with the sites left at their public addresses", async () => {
    for (const host of ["local", "server"]) {
      const project = tempProject();
      const fake = new FakeLeanLspMcp({ projectDir: project });
      const started: Over["started"] = [];
      const registry = new Registry({
        catalog,
        host: loadHostProfile(join(REPO, "config", "hosts", `${host}.json`)),
        factories: standIns({
          "lean-lsp": leanLspFactory({
            transport: (server) => {
              started.push(server);
              return fake.transport();
            },
          }),
        }),
        env: { LEAN_PROJECT_DIR: project, LEAN_LSP_MCP_COMMAND: "lsp-server" },
      });
      try {
        assert.equal(registry.offers("lean.lsp"), true, host);
        const entry = (await registry.health("lean.lsp"))[0];
        assert.equal(entry?.ok, true, `${host}: ${entry?.detail}`);
        const [server] = started;
        assert.equal(server?.command, "lsp-server");
        assert.equal(server?.env?.LOOGLE_URL, undefined, "no variable: the server's own public addresses stand");
        assert.equal(server?.env?.LEAN_FINDER_URL, undefined);
        assert.equal(server?.env?.LEAN_HAMMER_URL, undefined);
        assert.ok(existsSync(project));
      } finally {
        await registry.close();
      }
    }
  });

  it("make the sites the host's own when it names them", async () => {
    const project = tempProject();
    const fake = new FakeLeanLspMcp({ projectDir: project });
    const started: Over["started"] = [];
    const registry = new Registry({
      catalog,
      host: loadHostProfile(join(REPO, "config", "hosts", "local.json")),
      factories: standIns({ "lean-lsp": leanLspFactory({ transport: (server) => (started.push(server), fake.transport()) }) }),
      env: { LEAN_PROJECT_DIR: project, LOOGLE_URL: "http://127.0.0.1:8088", LEAN_FINDER_URL: "http://127.0.0.1:8089", LEAN_HAMMER_URL: "http://127.0.0.1:8090" },
    });
    try {
      await registry.health("lean.lsp");
      const env = started[0]?.env ?? {};
      assert.deepEqual([env.LOOGLE_URL, env.LEAN_FINDER_URL, env.LEAN_HAMMER_URL], ["http://127.0.0.1:8088", "http://127.0.0.1:8089", "http://127.0.0.1:8090"]);
    } finally {
      await registry.close();
    }
  });
});

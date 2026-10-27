import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { check, demoBench, demoRun, killedAt, tempDir } from "./m0-helpers.ts";

const run = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/** Runs the CLI; an `undefined` in `env` removes that variable. */
async function harness(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const merged: Record<string, string | undefined> = { ...process.env, HARNESS_HOST: "", ...env };
  for (const [name, value] of Object.entries(merged)) if (value === undefined) delete merged[name];
  try {
    const { stdout, stderr } = await run(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env: merged });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

/** Removes the Anthropic credentials, so that pi-ai finds none. */
const WITHOUT_ANTHROPIC_KEYS: Record<string, undefined> = Object.fromEntries(
  Object.keys(process.env).filter((name) => name.startsWith("ANTHROPIC_")).map((name) => [name, undefined]),
);

/** A Kimina Lean Server that answers `#eval Lean.versionString` like Lean v4.27.0. */
function fakeKimina(): Server {
  return createServer((request, response) => {
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { snippets } = JSON.parse(body) as { snippets: Array<{ id: string; code: string }> };
      const results = snippets.map(({ id }) => ({
        id,
        time: 0.2,
        response: { messages: [{ severity: "info", pos: { line: 1, column: 0 }, endPos: null, data: '"4.27.0"' }] },
      }));
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ results }));
    });
  });
}

describe("harness CLI", () => {
  let server: Server;
  let url = "";
  before(async () => {
    server = fakeKimina();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("lists the capabilities and where the host gets them", async () => {
    const { code, stdout } = await harness(["capabilities", "--host", "local"]);
    assert.equal(code, 0);
    assert.match(stdout, /^lean\.check v1 \(auto\): Check Lean files \[local: kimina\]$/m);
  });

  it("describes a capability for a model", async () => {
    const { code, stdout } = await harness(["describe", "lean.check"]);
    assert.equal(code, 0);
    assert.match(stdout, /^lean\.check: Check Lean files\n\nElaborates whole Lean files/);
    assert.equal((await harness(["describe", "lean.nothing"])).code, 2);
  });

  it("checks the health of the host's implementations", async () => {
    const up = await harness(["health", "lean.check"], { LEAN_SERVER_API_URL: url });
    assert.equal(up.code, 0, up.stdout + up.stderr);
    assert.match(up.stdout, /^ok {3}lean\.check\/kimina fb2393de\+lean-v4\.27\.0\+fc-bench-v1 \(\d+ ms\): kimina-lean-server fb2393de/m);
    const down = await harness(["health", "lean.check"], { LEAN_SERVER_API_URL: "http://127.0.0.1:9" });
    assert.equal(down.code, 1);
    assert.match(down.stdout, /^FAIL lean\.check\/kimina/m);
    // Every implementation the host lists, in order: SageMath's, which is required and which nothing
    // serves; the sites', which are optional and which nothing serves; and the certifier's, which has no
    // Lean project to run in and no sandbox to run it in.
    const nowhere = "http://127.0.0.1:9";
    const all = await harness(["health"], {
      LEAN_SERVER_API_URL: url,
      LEAN_PROJECT_DIR: undefined,
      PATH: "/nowhere",
      SAGEMATH_MCP_COMMAND: "/nowhere/sagemath-mcp",
      OEIS_URL: nowhere,
      LMFDB_URL: nowhere,
      FINDSTAT_URL: nowhere,
    });
    // The command fails because of SageMath and the certifier; the sites only warn.
    assert.equal(all.code, 1);
    assert.match(
      all.stdout,
      /^FAIL compute\.sage\/docker 0\.9\.5 .*\nFAIL compute\.sage\/local 0\.9\.5 .*ENOENT.*\nwarn findstat\.identify\/site \S+ .*\nFAIL lean\.certify\/lake 0\.1\.0\+lean-v4\.27\.0\+fc-bench-v1 .*set LEAN_PROJECT_DIR; lean\.certify refuses to run the candidate's code without a sandbox.*\nok {3}lean\.check\/kimina/m,
    );
    assert.match(all.stdout, /^warn lmfdb\.query\/site \S+ /m);
    assert.match(all.stdout, /^warn oeis\.search\/site \S+ /m);
    assert.doesNotMatch(all.stdout, /^FAIL (findstat|lmfdb|oeis)/m);
    // With the project set, the default profile's certifier is still down: it has no sandbox, and does not opt in to running without.
    const set = await harness(["health", "lean.certify"], { LEAN_PROJECT_DIR: tmpdir() });
    assert.equal(set.code, 1);
    assert.match(set.stdout, /^FAIL lean\.certify\/lake .*refuses to run the candidate's code without a sandbox/m);
    assert.doesNotMatch(set.stdout, /LEAN_PROJECT_DIR/);
  });

  it("does not fail the health of a host whose public sites cannot be reached", async () => {
    // The three sites are optional in the repository's profiles: a host without outbound access still passes.
    const nowhere = { OEIS_URL: "http://127.0.0.1:9", LMFDB_URL: "http://127.0.0.1:9", FINDSTAT_URL: "http://127.0.0.1:9" };
    for (const id of ["oeis.search", "lmfdb.query", "findstat.identify"]) {
      const { code, stdout, stderr } = await harness(["health", id], nowhere);
      assert.equal(code, 0, stdout + stderr);
      assert.match(stdout, new RegExp(`^warn ${id.replace(".", "\\.")}/site \\S+ \\(\\d+ ms\\): `, "m"));
    }
    // The server profile too.
    const server = await harness(["health", "oeis.search", "--host", "server"], nowhere);
    assert.equal(server.code, 0, server.stdout + server.stderr);
    assert.match(server.stdout, /^warn oeis\.search\/site /m);
  });

  it("runs contract cases and fails when one does not hold", async () => {
    const one = await harness(["contract", "lean.check", "--case", "lean version"], { LEAN_SERVER_API_URL: url });
    assert.equal(one.code, 0, one.stdout + one.stderr);
    assert.match(one.stdout, /^pass {2}lean version \(\d+ ms\)$/m);
    assert.match(one.stdout, /lean\.check on local with kimina: 1 passed, 0 failed/);
    const two = await harness(["contract", "lean.check", "--case", "lean version", "--case", "no axioms"], { LEAN_SERVER_API_URL: url });
    assert.equal(two.code, 1);
    assert.match(two.stdout, /^FAIL {2}no axioms/m);
  });

  it("refuses a host without a profile", async () => {
    const { code, stderr } = await harness(["capabilities", "--host", "nowhere"]);
    assert.equal(code, 2);
    assert.match(stderr, /nowhere\.json/);
  });
});

describe("harness run", () => {
  const { checkout } = demoBench();
  const out = join(tempDir(), "run");
  const anthropic = builtinModels().getModels("anthropic")[0]?.id;

  it("refuses missing, contradictory and malformed options, with the usage", async () => {
    const options: Array<[string[], RegExp]> = [
      [["--model", "a/b", "--all"], /^run needs --checkout/],
      [["--checkout", checkout, "--all"], /^run needs --model PROVIDER\/ID/],
      [["--checkout", checkout, "--model", "a/b"], /^choose the problems with exactly one of --sample, --problem and --all/],
      [["--checkout", checkout, "--model", "a/b", "--all", "--sample", "2"], /^choose the problems with exactly one of/],
      [["--checkout", checkout, "--model", "a/b", "--all", "--seed", "s"], /^--seed goes with --sample/],
      [["--checkout", checkout, "--model", "a/b", "--sample", "0"], /^--sample must be a positive integer, got 0/],
      [["--checkout", checkout, "--model", "a/b", "--problem", "nope"], /^not in fc-bench-v1-discrete: nope/],
      [["--checkout", checkout, "--model", "a/b", "--all", "--turns", "many"], /^--turns must be a number, got "many"/],
      [["--checkout", checkout, "--model", "a/b", "--all", "--thinking", "deep"], /^--thinking must be one of off, minimal, low/],
      [["--checkout", checkout, "--model", "a/b", "--all", "--cache-retention", "forever"], /^--cache-retention must be one of none, short, long/],
      [["somewhere", "--checkout", checkout, "--model", "a/b", "--all"], /^run takes no positional argument, got somewhere/],
    ];
    const results = await Promise.all(options.map(([args]) => harness(["run", ...args])));
    options.forEach(([args, message], k) => {
      const { code, stderr } = results[k] as Awaited<ReturnType<typeof harness>>;
      assert.equal(code, 2, args.join(" "));
      assert.match(stderr.replace(/^warning: .*\n/, ""), message);
      assert.match(stderr, /\n\nusage:\n/);
    });
  });

  it("stops before writing anything when the checkout, the configuration or the model is wrong", async () => {
    assert.ok(anthropic !== undefined, "pi-ai lists Anthropic models");
    const options: Array<[string[], RegExp]> = [
      [["--checkout", join(checkout, "missing"), "--model", "a/b"], /^no directory .*missing$/m],
      [["--checkout", checkout, "--model", "a/b", "--provers", "0"], /^invalid run configuration: provers must be an integer of at least 1, got 0$/m],
      [["--checkout", checkout, "--model", "anthropic"], /^model "anthropic": expected provider\/id, as harness models lists them$/m],
      [["--checkout", checkout, "--model", "nowhere/x"], /^unknown provider nowhere$/m],
      [["--checkout", checkout, "--model", "anthropic/no-such-model"], /^unknown model no-such-model of anthropic; known: /m],
      [["--checkout", checkout, "--model", `anthropic/${anthropic}`], /^no credentials for anthropic: set its API key/m],
      [["--checkout", checkout, "--model", `anthropic/${anthropic}`, "--host", "nowhere"], /^the registry of the run: invalid capability catalog:\n- .*nowhere\.json: ENOENT/m],
    ];
    // The last case gets past the model check with a key, and fails on the host.
    const env = (args: string[]) => (args.includes("--host") ? { ...WITHOUT_ANTHROPIC_KEYS, ANTHROPIC_API_KEY: "test" } : WITHOUT_ANTHROPIC_KEYS);
    const results = await Promise.all(options.map(([args]) => harness(["run", ...args, "--sample", "1", "--out", out], env(args))));
    options.forEach(([args, message], k) => {
      const { code, stdout, stderr } = results[k] as Awaited<ReturnType<typeof harness>>;
      assert.equal(code, 2, `${args.join(" ")}: ${stderr}`);
      assert.match(stderr, message);
      assert.doesNotMatch(stderr, /usage:/);
      assert.equal(stdout, "");
    });
    assert.equal(existsSync(out), false);
  });
});

describe("harness run --lines", () => {
  const { checkout } = demoBench();
  const out = join(tempDir(), "run");

  it("refuses contradictory and malformed line options, with the usage", async () => {
    const options: Array<[string[], RegExp]> = [
      [["--lines", "M1", "--ablation", "M2"], /^choose the lines with --lines or --ablation, not both/],
      [["--ablation", "M15"], /^--ablation must be M0 or a line \(M1, M10, M2, .*\), got M15/],
      [["--line-option", "M1:k=1"], /^--line-option takes ID\.KEY=VALUE, got "M1:k=1"/],
    ];
    const results = await Promise.all(options.map(([args]) => harness(["run", "--checkout", checkout, "--model", "a/b", "--all", ...args])));
    options.forEach(([args, message], k) => {
      const { code, stderr } = results[k] as Awaited<ReturnType<typeof harness>>;
      assert.equal(code, 2, args.join(" "));
      assert.match(stderr.replace(/^warning: .*\n/, ""), message);
      assert.match(stderr, /\n\nusage:\n/);
    });
  });

  it("refuses unknown and planned lines before the model is looked up, and runs M0 for --ablation M0", async () => {
    const options: Array<[string[], RegExp]> = [
      [["--lines", "M10,M99"], /^the lines of the run: line M10 \(classical battery per subgoal before any model, domain router, ATP and SMT\) is planned, not implemented yet; unknown line "M99"/m],
      [["--ablation", "M2"], /^the lines of the run: line M10 .* is planned, not implemented yet$/m],
      [["--ablation", "M9"], /^the lines of the run: line M10 .* is planned, not implemented yet; .*line M9 \(reranking from our own labels, without training\) is suspended: it is not built, and no run enables it \(documentation\/lines.md\)$/m],
      [["--lines", "M10", "--line-option", "M10.k=2"], /^the lines of the run: line M10 .* is planned, not implemented yet$/m],
      // M1 is implemented, with one option.
      [["--lines", "M1", "--line-option", "M1.k=2"], /^the lines of the run: line M1 has no option k; its options are maxLines$/m],
      // No line: the run goes on to the model, which does not exist.
      [["--ablation", "M0"], /^unknown provider nowhere$/m],
    ];
    const results = await Promise.all(options.map(([args]) => harness(["run", "--checkout", checkout, "--model", "nowhere/x", "--sample", "1", "--out", out, ...args])));
    options.forEach(([args, message], k) => {
      const { code, stdout, stderr } = results[k] as Awaited<ReturnType<typeof harness>>;
      assert.equal(code, 2, `${args.join(" ")}: ${stderr}`);
      assert.match(stderr, message);
      assert.doesNotMatch(stderr, /usage:/);
      assert.equal(stdout, "");
    });
    assert.equal(existsSync(out), false);
  });
});

describe("harness run --resume", () => {
  it("refuses what makes no sense before writing anything: a run that is complete, a flag that describes a new run, a missing checkout or directory, a model this process does not know", async () => {
    const whole = await demoRun({ config: { sessions: 3 }, responses: [check("bad"), check("exact trivial_proof")] });
    const index = join(tempDir(), "bench.json");
    writeFileSync(index, JSON.stringify(whole.bench.index));
    const cut = killedAt(whole.dir, (event) => event.type === "attempt.finished");
    const journal = readFileSync(join(cut, "journal.jsonl"));
    const given = ["--checkout", whole.bench.checkout, "--bench", index];

    const options: Array<[string[], RegExp, boolean]> = [
      // [arguments, what stderr says, whether the usage follows]
      [["--resume", whole.dir, ...given], /^the run is complete: every problem has an outcome and the run finished, so there is nothing to resume in /m, false],
      [["--resume", cut, ...given, "--model", "a/b", "--sessions", "2"], /^--resume continues the run as it began, from its journal: --model, --sessions cannot be given with it$/m, true],
      [["--resume", cut, "--bench", index], /^--resume needs --checkout: a checkout of the bench's repository$/m, true],
      [["--resume", join(cut, "nowhere"), ...given], /^no directory .*nowhere$/m, false],
      [["--resume", cut, "--checkout", join(cut, "missing"), "--bench", index], /^no directory .*missing$/m, false],
      // The model of the run is the faux provider's, which the command line does not have.
      [["--resume", cut, ...given], /^unknown provider faux$/m, false],
    ];
    for (const [args, message, usage] of options) {
      const { code, stdout, stderr } = await harness(["run", ...args]);
      assert.equal(code, 2, `${args.join(" ")}: ${stderr}`);
      assert.match(stderr, message);
      assert.equal(/\n\nusage:\n/.test(stderr), usage, args.join(" "));
      assert.equal(stdout, "");
    }
    assert.deepEqual(readFileSync(join(cut, "journal.jsonl")), journal, "the journal of the run that was cut is as it was");
  });

  it("is in the usage text", async () => {
    const { code, stdout } = await harness(["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /^ {2}harness run --resume RUN_DIR --checkout DIR \[--bench FILE\] \[--host HOST\]$/m);
    assert.match(stdout, /^run --resume: continues a run whose process ended without finishing it/m);
  });
});

describe("harness report", () => {
  it("prints the report of a run directory, as written by the run, in Markdown or JSON", async () => {
    const { dir } = await demoRun({ responses: [check("exact trivial_proof")] });
    const markdown = await harness(["report", dir]);
    assert.equal(markdown.code, 0, markdown.stderr);
    assert.equal(markdown.stdout, readFileSync(join(dir, "report.md"), "utf8"));
    assert.match(markdown.stdout, /^\| Candidates \(fast check only\) \| 1 \|$/m);
    const json = await harness(["report", dir, "--json"]);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stdout, readFileSync(join(dir, "report.json"), "utf8"));
  });

  it("refuses a directory that holds no run", async () => {
    const empty = tempDir();
    const none = await harness(["report", empty]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /is not a run directory: it has no journal\.jsonl$/m);
    writeFileSync(join(empty, "journal.jsonl"), "");
    const unstarted = await harness(["report", empty]);
    assert.equal(unstarted.code, 2);
    assert.match(unstarted.stderr, /the run did not start, its journal is empty$/m);
    assert.equal((await harness(["report"])).code, 2);
  });
});

describe("harness models", () => {
  it("lists the providers, then the models of one", async () => {
    const providers = await harness(["models"], WITHOUT_ANTHROPIC_KEYS);
    assert.equal(providers.code, 0, providers.stderr);
    assert.match(providers.stdout, /^anthropic: \d+ model\(s\), no credentials$/m);
    const withKey = await harness(["models"], { ...WITHOUT_ANTHROPIC_KEYS, ANTHROPIC_API_KEY: "test" });
    assert.match(withKey.stdout, /^anthropic: \d+ model\(s\), credentials from ANTHROPIC_API_KEY$/m);
    const models = await harness(["models", "anthropic"]);
    assert.equal(models.code, 0, models.stderr);
    assert.match(models.stdout, /^anthropic\/\S+: context \d+ tokens, \$[\d.]+\/\$[\d.]+ per million input\/output tokens/m);
    const unknown = await harness(["models", "nowhere"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /^unknown provider nowhere$/m);
  });
});

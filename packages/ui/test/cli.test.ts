import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT, SIGNATURE_LINE, solveCommand } from "@seshat/orchestrator";
import { fauxModels, tempDir } from "../../orchestrator/test/m0-helpers.ts";
import { BARE_MACHINE } from "./helpers.ts";

describe("harness solve --ask-stdin", () => {
  it("prints the signature as one JSON line, reads the answer from a line, and runs nothing on a no", async () => {
    const { models, name } = fauxModels();
    const out: string[] = [];
    const err: string[] = [];
    const code = await solveCommand(
      "(n : ℕ) : n + 0 = n",
      { out: join(tempDir("ui-solve-"), "run"), askStdin: true, askNonce: "nonce-for-the-test", noCheck: true, model: name, max: 1, host: "local" },
      { out: (l) => out.push(l), err: (l) => err.push(l), models, system: BARE_MACHINE, readLine: async () => "no" },
    );
    assert.equal(code, 1);
    const line = out.find((l) => l.startsWith(`${SIGNATURE_LINE} nonce-for-the-test `));
    assert.ok(line, out.join("\n"));
    const signature = JSON.parse(line.slice(SIGNATURE_LINE.length + 1 + "nonce-for-the-test ".length));
    assert.equal(signature.source, "lean");
    assert.match(signature.theorem, /n \+ 0 = n/);
    assert.match(err.join("\n"), /Not signed/);
  });

  it("takes a yes only for the statement that was shown, and refuses to run without the caller's nonce", async () => {
    const { models, name } = fauxModels();
    const run = (askNonce: string | undefined, answer: string) =>
      solveCommand(
        "(n : ℕ) : n + 0 = n",
        { out: join(tempDir("ui-solve-"), "run"), askStdin: true, ...(askNonce !== undefined ? { askNonce } : {}), noCheck: true, model: name, max: 1, host: "local" },
        { out: () => {}, err: () => {}, models, system: BARE_MACHINE, readLine: async () => answer },
      );
    assert.equal(await run("n", "yes sid_some_other_statement"), 1, "a yes for another statement is a no");
    assert.equal(await run("n", "yes"), 1, "a bare yes is a no");
    assert.equal(await run("n", "y"), 1);
    assert.equal(await run(undefined, "yes sid"), 2, "without the nonce the command refuses");
  });
});

describe("harness ui", () => {
  it("prints an address with a token, serves the page on loopback, and stops on SIGINT", async () => {
    const runs = tempDir("ui-cli-runs-");
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(REPO_ROOT, "packages/orchestrator/src/cli.ts"), "ui", `--runs=${runs}`], {
      env: { ...process.env, SESHAT_KEYS_FILE: join(runs, "..", "keys-for-cli-test.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.on("data", (c) => (text += c));
    const ended = new Promise<number | null>((resolve) => child.once("close", resolve));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no address: ${text}`)), 15000);
        const look = setInterval(() => {
          const m = /(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)/.exec(text);
          if (m !== null) {
            clearTimeout(timer);
            clearInterval(look);
            resolve(m[1] as string);
          }
        }, 50);
      });
      const token = /#token=(\S+)/.exec(url)?.[1] ?? "";
      const origin = new URL(url).origin;
      assert.equal((await fetch(`${origin}/api/session`)).status, 401, "no token, no answer");
      assert.equal((await fetch(`${origin}/api/session`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
      const page = await fetch(`${origin}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>Seshat<\/title>/);
      assert.equal(page.headers.get("set-cookie"), null, "no cookie is ever set");
    } finally {
      child.kill("SIGINT");
    }
    assert.equal(await ended, 0, "it stops cleanly");
  });
});

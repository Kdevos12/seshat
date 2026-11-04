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
      { out: join(tempDir("ui-solve-"), "run"), askStdin: true, noCheck: true, model: name, max: 1, host: "local" },
      { out: (l) => out.push(l), err: (l) => err.push(l), models, system: BARE_MACHINE, readLine: async () => "no" },
    );
    assert.equal(code, 1);
    const line = out.find((l) => l.startsWith(`${SIGNATURE_LINE} `));
    assert.ok(line, out.join("\n"));
    const signature = JSON.parse(line.slice(SIGNATURE_LINE.length + 1));
    assert.equal(signature.source, "lean");
    assert.match(signature.theorem, /n \+ 0 = n/);
    assert.match(err.join("\n"), /Not signed/);
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
          const m = /(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(text);
          if (m !== null) {
            clearTimeout(timer);
            clearInterval(look);
            resolve(m[1] as string);
          }
        }, 50);
      });
      const first = await fetch(url, { redirect: "manual" });
      assert.equal(first.status, 303);
      const bare = await fetch(new URL("/", url));
      assert.equal(bare.status, 401);
      const page = await fetch(new URL("/", url), { headers: { cookie: (first.headers.get("set-cookie") ?? "").split(";")[0] as string } });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>Seshat<\/title>/);
    } finally {
      child.kill("SIGINT");
    }
    assert.equal(await ended, 0, "it stops cleanly");
  });
});

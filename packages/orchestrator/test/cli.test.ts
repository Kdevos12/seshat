import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

async function harness(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
      env: { ...process.env, HARNESS_HOST: "", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

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
    const up = await harness(["health"], { LEAN_SERVER_API_URL: url });
    assert.equal(up.code, 0, up.stdout + up.stderr);
    assert.match(up.stdout, /^ok {3}lean\.check\/kimina fb2393de\+lean-v4\.27\.0\+fc-bench-v1 \(\d+ ms\): kimina-lean-server fb2393de/m);
    const down = await harness(["health"], { LEAN_SERVER_API_URL: "http://127.0.0.1:9" });
    assert.equal(down.code, 1);
    assert.match(down.stdout, /^FAIL lean\.check\/kimina/m);
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

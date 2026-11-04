import { request } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../orchestrator/test/m0-helpers.ts";
import type { DoctorSystem } from "@seshat/orchestrator";
import { type RunningServer, type ServerOptions, startServer } from "../src/index.ts";

export const FAKE_HARNESS = fileURLToPath(new URL("./fixtures/fake-harness.ts", import.meta.url));

/** A machine with nothing on it: no command, no server, no network. */
export const BARE_MACHINE: DoctorSystem = {
  env: {},
  which: () => undefined,
  run: async () => ({ code: -1, stdout: "", stderr: "not found" }),
  http: async () => ({ error: "no network in a test" }),
  ids: () => undefined,
};

export interface Started {
  server: RunningServer;
  dir: string;
  runsDir: string;
  keyFile: string;
  logs: string[];
  /** A request with the session's token, as the page makes it. */
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; text: string; json: () => any; headers: Headers }>;
}

/** A server on a free loopback port, with a fake `harness`, a temporary runs directory and a key file in a temporary directory. */
export async function started(options: ServerOptions = {}): Promise<Started> {
  const dir = tempDir("ui-server-");
  const runsDir = join(dir, "runs");
  const staticDir = join(dir, "static");
  const keyFile = join(dir, "config", "keys.json");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>test</title><p>hello</p>");
  const logs: string[] = [];
  const server = await startServer({
    runsDir,
    staticDir,
    keyFile,
    graceMs: 2000,
    system: BARE_MACHINE,
    configDir: join(dir, "config-dir"),
    pollMs: 50,
    env: { PATH: process.env.PATH ?? "", HOME: dir },
    command: (argv) => ({ file: process.execPath, args: ["--disable-warning=ExperimentalWarning", FAKE_HARNESS, ...argv] }),
    log: (line) => logs.push(line),
    ...options,
  });
  const call: Started["call"] = async (method, path, body, headers = {}) => {
    const response = await fetch(`${server.origin}${path}`, {
      method,
      redirect: "manual",
      headers: {
        authorization: `Bearer ${server.token}`,
        ...(method !== "GET" ? { origin: server.origin, "x-seshat-request": "1" } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, text, json: () => JSON.parse(text), headers: response.headers };
  };
  return { server, dir, runsDir, keyFile, logs, call };
}

/** A raw request, so that the Host header can be anything. */
export function raw(port: number, path: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Waits until `check` is true, or fails after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

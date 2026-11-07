import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { Models } from "@earendil-works/pi-ai";
import { REPO_ROOT, type DoctorSystem } from "@seshat/orchestrator";
import { createApp } from "./app.ts";
import { type CommandFactory, ProcessManager } from "./jobs.ts";
import { defaultKeyFile, KeyStore } from "./keys.ts";
import { serverModels } from "./providers.ts";
import { newToken } from "./security.ts";

/** The address the server binds to. It is never configurable: a local interface is not a service. */
export const BIND_ADDRESS = "127.0.0.1";

/** The built front end, which sits beside this file's package. */
export const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static");

export interface ServerOptions {
  /** The port; 0 asks the system for a free one. Default 0. */
  port?: number;
  /** Where runs live. Default `runs` under the working directory. */
  runsDir?: string;
  /** The key file. Default `defaultKeyFile()`, outside the repository. */
  keyFile?: string;
  token?: string;
  staticDir?: string;
  /** How a command is started; default the real `harness`. */
  command?: CommandFactory;
  /** The providers; default pi-ai's own, with the credentials of `env` and the stored keys. */
  models?: Models;
  system?: DoctorSystem;
  configDir?: string;
  log?: (line: string) => void;
  /** The environment the commands start from, and whose credentials the providers count. Default the process's. */
  env?: Readonly<Record<string, string | undefined>>;
  graceMs?: number;
  pollMs?: number;
}

export interface RunningServer {
  /** The address to open. The token is in the fragment, which a browser never sends to any server; the page keeps it for the session and removes it from the address bar. */
  url: string;
  /** The same address without the token. */
  origin: string;
  port: number;
  token: string;
  manager: ProcessManager;
  keys: KeyStore;
  /** Stops the commands the server started (not the detached ones), then the server. */
  close(): Promise<void>;
}

/** Starts the local server on 127.0.0.1 and returns once it listens. */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const token = options.token ?? newToken();
  const runsDir = resolve(options.runsDir ?? "runs");
  const keys = new KeyStore(options.keyFile ?? defaultKeyFile(options.env ?? process.env), REPO_ROOT);
  const baseEnv = options.env ?? process.env;
  const manager = new ProcessManager({
    ...(options.command !== undefined ? { command: options.command } : {}),
    cwd: process.cwd(),
    // A command gets the stored key of the provider it is told to use, not every key the file holds.
    env: (scope) => ({ ...baseEnv, ...keys.env(scope.mode === "none" ? [] : scope.mode === "all" ? undefined : [scope.provider]) }),
    secrets: () => {
      try {
        return keys.secrets();
      } catch {
        return [];
      }
    },
    logDir: join(runsDir, "_inputs"),
    ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
  });
  let port = options.port ?? 0;
  const app = createApp({
    token,
    port: () => port,
    runsDir,
    staticDir: options.staticDir ?? STATIC_DIR,
    keys,
    manager,
    // The models see the credentials the commands get: the server's environment and the stored keys.
    models: options.models ?? serverModels(keys, baseEnv),
    ...(options.system !== undefined ? { system: options.system } : {}),
    ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
  });
  const server = await new Promise<Server>((resolveServer, reject) => {
    const s = serve({ fetch: app.fetch, port, hostname: BIND_ADDRESS }, () => resolveServer(s as unknown as Server)) as unknown as Server;
    s.once("error", reject);
  });
  port = (server.address() as AddressInfo).port;
  const origin = `http://${BIND_ADDRESS}:${port}`;
  let closing: Promise<void> | undefined;
  return {
    url: `${origin}/#token=${token}`,
    origin,
    port,
    token,
    manager,
    keys,
    close: () => {
      closing ??= (async () => {
        await manager.shutdown();
        server.closeAllConnections?.();
        await new Promise<void>((done) => server.close(() => done()));
      })();
      return closing;
    },
  };
}

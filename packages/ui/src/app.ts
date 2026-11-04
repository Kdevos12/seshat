import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { doctorReport, type DoctorSystem, realSystem } from "@seshat/orchestrator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { plan, RequestError } from "./commands.ts";
import { type ProcessManager } from "./jobs.ts";
import { KeyFileError, type KeyStore, redact, validKey } from "./keys.ts";
import { describeModels, describeProviders, serverModels, VariableFinder } from "./providers.ts";
import { JournalTail, listRuns, readRun, RunReadError, runDirectory } from "./reader.ts";
import { guard, securityHeaders } from "./security.ts";

/**
 * The routes of the local server (documentation/ui.md). Every route sits behind the guards of `security.ts`. A route that reads a run
 * calls the journal reader; a route that starts something plans a command (`commands.ts`) and gives it to the process manager. No route
 * writes a journal, and none can set a claim's status.
 */

export const UI_VERSION = 1;

export interface AppOptions {
  token: string;
  /** The port the server listens on (read at request time, since a port of 0 is only known after it listens). */
  port: () => number;
  runsDir: string;
  /** The built front end. */
  staticDir: string;
  keys: KeyStore;
  manager: ProcessManager;
  /** The providers; default pi-ai's own, with the stored keys as credentials. */
  models?: Models;
  system?: DoctorSystem;
  configDir?: string;
  /** What the server may say about itself; a key is never in it. */
  log?: (line: string) => void;
  /** Milliseconds between looks at a journal that is followed. */
  pollMs?: number;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const MAX_BODY = 1_000_000;

export function createApp(o: AppOptions): Hono {
  const app = new Hono();
  const finder = new VariableFinder();
  const models = o.models ?? serverModels(o.keys);
  const log = o.log ?? (() => {});
  const pollMs = o.pollMs ?? 500;

  app.use("*", securityHeaders);
  app.use("*", guard({ token: o.token, port: o.port }));

  app.onError((error, c) => {
    if (error instanceof RequestError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof KeyFileError) return c.json({ error: error.message }, 409);
    if (error instanceof RunReadError) return c.json({ error: error.message }, 404);
    // Anything else is a bug; its text is logged with every stored key hidden, and the browser is told no more than that.
    let secrets: string[] = [];
    try {
      secrets = o.keys.secrets();
    } catch {
      secrets = [];
    }
    log(`internal error: ${redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error), secrets)}`);
    return c.json({ error: "internal error" }, 500);
  });

  async function body(c: { req: { header(name: string): string | undefined; json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
    if (!/^application\/json(\s*;|$)/i.test(c.req.header("content-type") ?? "")) throw new RequestError("send JSON", 415);
    const length = Number(c.req.header("content-length") ?? "0");
    if (length > MAX_BODY) throw new RequestError("request too large", 413);
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      throw new RequestError("not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RequestError("send a JSON object");
    return parsed as Record<string, unknown>;
  }

  const dirOf = (id: string): string => {
    const dir = runDirectory(o.runsDir, id);
    if (dir === undefined) throw new RequestError("no such run", 404);
    return dir;
  };

  // ---- The session.
  app.get("/api/session", (c) => {
    let keyFile: { path: string; ok: boolean; problem?: string };
    try {
      o.keys.providers();
      keyFile = { path: o.keys.file, ok: true };
    } catch (error) {
      keyFile = { path: o.keys.file, ok: false, problem: error instanceof Error ? error.message : "unreadable" };
    }
    return c.json({ version: UI_VERSION, runsDir: o.runsDir, keyFile });
  });

  // ---- Providers and keys.
  app.get("/api/providers", async (c) => c.json({ providers: await describeProviders(models, finder, o.keys) }));

  app.get("/api/providers/:id/models", (c) => {
    const list = describeModels(models, c.req.param("id"));
    if (list === undefined) throw new RequestError("no such provider", 404);
    return c.json({ models: list });
  });

  app.put("/api/providers/:id/key", async (c) => {
    const id = c.req.param("id");
    if (models.getProvider(id) === undefined) throw new RequestError("no such provider", 404);
    const data = await body(c);
    if (!validKey(data.key)) throw new RequestError("a key is one line of 8 to 4096 printable characters, without spaces");
    const variable = await finder.variable(id);
    if (variable === null) throw new RequestError("this provider reads no API key from an environment variable (its credentials are ambient), so there is nothing to save", 400);
    o.keys.set(id, variable, data.key);
    // The answer says that a key is stored, never which.
    return c.json({ provider: id, stored: true });
  });

  app.delete("/api/providers/:id/key", (c) => {
    const id = c.req.param("id");
    if (models.getProvider(id) === undefined) throw new RequestError("no such provider", 404);
    return c.json({ provider: id, stored: false, removed: o.keys.remove(id) });
  });

  // ---- The machine.
  app.get("/api/doctor", async (c) => {
    const model = c.req.query("model");
    if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,200}$/.test(model)) throw new RequestError("the model is not in a form the interface accepts");
    const base = o.system ?? realSystem();
    let env: Record<string, string | undefined> = { ...base.env };
    try {
      env = { ...env, ...o.keys.env() };
    } catch {
      // A key file that cannot be read is said by the settings screen.
    }
    const report = await doctorReport({ noWrite: true, ...(model !== undefined ? { model } : {}) }, { models, system: { ...base, env }, ...(o.configDir !== undefined ? { configDir: o.configDir } : {}) });
    return c.json(report);
  });

  // ---- Runs.
  app.get("/api/runs", (c) => c.json({ runs: listRuns(o.runsDir).map((r) => ({ ...r, active: o.manager.activeOn(r.id)?.id ?? null })) }));

  app.get("/api/runs/:id", (c) => {
    const id = c.req.param("id");
    const view = readRun(dirOf(id));
    const job = o.manager.activeOn(id);
    return c.json({ run: view, activeJob: job === undefined ? null : job });
  });

  app.get("/api/runs/:id/result", (c) => c.text(readRun(dirOf(c.req.param("id"))).resultMd, 200, { "Content-Type": "text/plain; charset=utf-8" }));

  app.get("/api/runs/:id/events", (c) => {
    const dir = dirOf(c.req.param("id"));
    return streamSSE(c, async (stream) => {
      const tail = new JournalTail(join(dir, "journal.jsonl"));
      tail.poll(); // what is already there is read with the run; the stream tells what comes after
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      let quiet = 0;
      while (open) {
        const news = tail.poll();
        if (news.length > 0) {
          quiet = 0;
          await stream.writeSSE({ event: "journal", data: JSON.stringify(news.slice(-50)) });
        } else if (++quiet * pollMs >= 15_000) {
          quiet = 0;
          await stream.writeSSE({ event: "ping", data: "{}" });
        }
        await stream.sleep(pollMs);
      }
    });
  });

  // ---- Commands.
  app.post("/api/jobs", async (c) => {
    const data = await body(c);
    const kind = typeof data.kind === "string" ? data.kind : "";
    const planned = plan(kind, data, { runsDir: o.runsDir });
    const job = o.manager.start(planned, { detached: data.detached === true });
    return c.json({ job }, 201);
  });

  app.get("/api/jobs", (c) => c.json({ jobs: o.manager.list() }));

  app.get("/api/jobs/:id", (c) => {
    const job = o.manager.get(c.req.param("id"));
    if (job === undefined) throw new RequestError("no such command", 404);
    return c.json({ job });
  });

  app.post("/api/jobs/:id/stop", (c) => c.json({ job: o.manager.stop(c.req.param("id")) }));

  app.post("/api/jobs/:id/answer", async (c) => {
    const data = await body(c);
    if (typeof data.yes !== "boolean") throw new RequestError("answer yes or no");
    o.manager.answer(c.req.param("id"), data.yes);
    const job = o.manager.get(c.req.param("id"));
    return c.json({ job });
  });

  app.get("/api/jobs/:id/events", (c) => {
    const id = c.req.param("id");
    if (o.manager.get(id) === undefined) throw new RequestError("no such command", 404);
    return streamSSE(c, async (stream) => {
      let open = true;
      let wake: (() => void) | undefined;
      const pending: string[] = [];
      const after = Number(c.req.query("after") ?? "-1");
      const job = o.manager.get(id);
      if (job === undefined) return;
      for (const line of job.lines) if (line.n > after) pending.push(JSON.stringify({ line }));
      const off = o.manager.subscribe(id, (line, current) => {
        if (line !== undefined) pending.push(JSON.stringify({ line }));
        pending.push(JSON.stringify({ state: current.state, exitCode: current.exitCode ?? null, signature: current.signature ?? null }));
        wake?.();
      });
      stream.onAbort(() => {
        open = false;
        off?.();
        wake?.();
      });
      await stream.writeSSE({ event: "state", data: JSON.stringify({ state: job.state, exitCode: job.exitCode ?? null, signature: job.signature ?? null }) });
      while (open) {
        while (pending.length > 0) {
          const next = pending.shift() as string;
          await stream.writeSSE({ event: "job", data: next });
        }
        const done = job.state === "exited" || job.state === "failed" || job.state === "stopped";
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 15_000).unref();
        });
        wake = undefined;
      }
      off?.();
    });
  });

  // ---- The front end: static files, and nothing else.
  const root = resolve(o.staticDir);
  app.get("*", (c) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("Bad path.", 400);
    }
    if (path.includes("\0")) return c.text("Bad path.", 400);
    if (path.startsWith("/api/")) return c.json({ error: "no such route" }, 404);
    const wanted = path === "/" ? "/index.html" : path;
    const file = resolve(root, `.${normalize(wanted)}`);
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return c.text("Not found.", 404);
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    return c.body(readFileSync(file), 200, { "Content-Type": type });
  });

  return app;
}

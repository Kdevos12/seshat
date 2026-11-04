import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { REPO_ROOT } from "@seshat/orchestrator";
import { redact } from "./keys.ts";
import type { Planned } from "./commands.ts";
import { RequestError } from "./commands.ts";

/**
 * The process manager (documentation/ui.md, "Running commands"): it starts `harness` commands as subprocesses, keeps what they print,
 * relays the signature a `solve` asks for, stops them on request and stops them all when the server stops, unless the person started
 * one detached. It reads no journal and writes none; whatever a command does to a run, it does as the command.
 */

export type JobState = "running" | "awaiting_signature" | "exited" | "failed" | "stopped";

export interface OutputLine {
  /** Position in the job's output, from 0, for a client that reconnects. */
  n: number;
  stream: "out" | "err";
  text: string;
}

export interface Job {
  id: string;
  kind: string;
  /** The command line after `harness`, with every stored key hidden. */
  command: string[];
  runId: string | undefined;
  state: JobState;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** The signature a `solve` is waiting for the person to accept or refuse. */
  signature?: unknown;
  detached: boolean;
  /** The process id, so that a person can find a detached command. */
  pid?: number;
  /** A detached command writes to this file, which the interface does not follow. */
  logFile?: string;
  /** The last lines of output. */
  lines: OutputLine[];
}

/** How a command is started: the program and its arguments for the arguments after `harness`. */
export type CommandFactory = (argv: readonly string[]) => { file: string; args: string[] };

/** The real `harness`: this Node, the CLI of the orchestrator. */
export const realCommand: CommandFactory = (argv) => ({
  file: process.execPath,
  args: ["--disable-warning=ExperimentalWarning", join(REPO_ROOT, "packages", "orchestrator", "src", "cli.ts"), ...argv],
});

export interface ManagerOptions {
  command?: CommandFactory;
  cwd: string;
  /** The environment of a command: the process's, plus the stored keys. */
  env: () => Record<string, string | undefined>;
  /** The key values to hide from any line a command prints. */
  secrets: () => string[];
  /** Where the log of a detached command goes. */
  logDir: string;
  /** Lines of output kept per job. */
  keepLines?: number;
  /** Milliseconds a command is given to stop after the first signal, before a second, harder one. */
  graceMs?: number;
}

const SIGNATURE_MARKER = "SESHAT_SIGNATURE ";
const MAX_RUNNING = 4;

type Listener = (line: OutputLine | undefined, job: Job) => void;

interface Live {
  job: Job;
  child: ChildProcess;
  stopRequested: boolean;
  listeners: Set<Listener>;
  partial: { out: string; err: string };
  nextLine: number;
  timers: NodeJS.Timeout[];
}

export class ProcessManager {
  private readonly jobs = new Map<string, Live>();
  private readonly options: Required<Pick<ManagerOptions, "cwd" | "env" | "secrets" | "logDir">> & { command: CommandFactory; keepLines: number; graceMs: number };
  private shuttingDown = false;

  constructor(options: ManagerOptions) {
    this.options = { command: options.command ?? realCommand, cwd: options.cwd, env: options.env, secrets: options.secrets, logDir: options.logDir, keepLines: options.keepLines ?? 2000, graceMs: options.graceMs ?? 10_000 };
  }

  list(): Job[] {
    return [...this.jobs.values()].map((l) => l.job).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)?.job;
  }

  /** The job that is running on a run directory, if any. */
  activeOn(runId: string): Job | undefined {
    return this.list().find((j) => j.runId === runId && (j.state === "running" || j.state === "awaiting_signature"));
  }

  /** Starts a planned command. `detached` is honoured only where the plan allows it. */
  start(planned: Planned, o: { detached?: boolean } = {}): Job {
    if (this.shuttingDown) throw new RequestError("the server is stopping", 503);
    if (planned.runId !== undefined && this.activeOn(planned.runId) !== undefined) throw new RequestError("a command is already working on this run; stop it or wait for it", 409);
    if (this.list().filter((j) => j.state === "running" || j.state === "awaiting_signature").length >= MAX_RUNNING) throw new RequestError("too many commands are running", 429);
    const detached = o.detached === true;
    if (detached && !planned.mayDetach) throw new RequestError(`${planned.kind} cannot be started detached: it needs this page`, 400);
    const secrets = this.options.secrets();
    const { file, args } = this.options.command(planned.argv);
    const id = `job_${randomBytes(6).toString("hex")}`;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.options.env())) if (v !== undefined) env[k] = v;

    let logFile: string | undefined;
    let logFd: number | undefined;
    if (detached) {
      mkdirSync(this.options.logDir, { recursive: true, mode: 0o700 });
      logFile = join(this.options.logDir, `${id}.log`);
      logFd = openSync(logFile, "a", 0o600);
    }
    const child = spawn(file, args, {
      cwd: this.options.cwd,
      env,
      detached,
      stdio: detached ? ["ignore", logFd as number, logFd as number] : ["pipe", "pipe", "pipe"],
    });
    if (logFd !== undefined) closeSync(logFd);
    const job: Job = {
      id,
      kind: planned.kind,
      command: planned.argv.map((a) => redact(a, secrets)),
      runId: planned.runId,
      state: "running",
      startedAt: new Date().toISOString(),
      detached,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      ...(logFile !== undefined ? { logFile } : {}),
      lines: [],
    };
    const live: Live = { job, child, stopRequested: false, listeners: new Set(), partial: { out: "", err: "" }, nextLine: 0, timers: [] };
    this.jobs.set(id, live);

    const finish = (code: number | null, signal: NodeJS.Signals | null, failed?: string) => {
      if (job.state === "exited" || job.state === "failed" || job.state === "stopped") return;
      for (const t of live.timers) clearTimeout(t);
      for (const stream of ["out", "err"] as const) {
        if (live.partial[stream] !== "") this.push(live, stream, live.partial[stream]);
        live.partial[stream] = "";
      }
      if (failed !== undefined) this.push(live, "err", failed);
      job.endedAt = new Date().toISOString();
      job.exitCode = code;
      job.signal = signal;
      job.state = failed !== undefined ? "failed" : live.stopRequested ? "stopped" : "exited";
      delete job.signature;
      this.notify(live, undefined);
    };
    child.on("error", (error) => finish(null, null, `could not start: ${redact(error.message, secrets)}`));
    child.on("close", (code, signal) => finish(code, signal));
    if (!detached) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => this.collect(live, "out", chunk));
      child.stderr?.on("data", (chunk: string) => this.collect(live, "err", chunk));
      // A command that does not read its input must not make the server fail when the command exits first.
      child.stdin?.on("error", () => {});
    } else {
      child.unref();
    }
    return job;
  }

  private collect(live: Live, stream: "out" | "err", chunk: string): void {
    const text = live.partial[stream] + chunk;
    const parts = text.split("\n");
    live.partial[stream] = parts.pop() ?? "";
    for (const part of parts) this.push(live, stream, part.replace(/\r$/, ""));
    // A line with no end must not grow without bound.
    if (live.partial[stream].length > 100_000) {
      this.push(live, stream, live.partial[stream]);
      live.partial[stream] = "";
    }
  }

  private push(live: Live, stream: "out" | "err", raw: string): void {
    const { job } = live;
    if (stream === "out" && raw.startsWith(SIGNATURE_MARKER)) {
      try {
        job.signature = JSON.parse(raw.slice(SIGNATURE_MARKER.length));
        job.state = "awaiting_signature";
        const line = this.append(live, "out", "The statement is waiting for your signature.");
        this.notify(live, line);
        return;
      } catch {
        // Not a signature after all: it is shown as the text it is.
      }
    }
    const line = this.append(live, stream, redact(raw, this.options.secrets()));
    this.notify(live, line);
  }

  private append(live: Live, stream: "out" | "err", text: string): OutputLine {
    const line: OutputLine = { n: live.nextLine++, stream, text: text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text };
    live.job.lines.push(line);
    if (live.job.lines.length > this.options.keepLines) live.job.lines.splice(0, live.job.lines.length - this.options.keepLines);
    return line;
  }

  private notify(live: Live, line: OutputLine | undefined): void {
    for (const listener of live.listeners) {
      try {
        listener(line, live.job);
      } catch {
        // A listener that fails must not stop the others.
      }
    }
  }

  /** Follows a job: called for every new line, and once more with no line when the job ends. Returns the way to stop following. */
  subscribe(id: string, listener: Listener): (() => void) | undefined {
    const live = this.jobs.get(id);
    if (live === undefined) return undefined;
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }

  /** The person's answer to the signature a command waits for. */
  answer(id: string, yes: boolean): void {
    const live = this.jobs.get(id);
    if (live === undefined) throw new RequestError("no such command", 404);
    if (live.job.state !== "awaiting_signature") throw new RequestError("this command is not waiting for a signature", 409);
    live.job.state = "running";
    delete live.job.signature;
    const stdin = live.child.stdin;
    if (stdin === null || stdin === undefined || stdin.destroyed) throw new RequestError("this command cannot be answered", 409);
    stdin.write(yes ? "yes\n" : "no\n");
    stdin.end();
    this.notify(live, undefined);
  }

  /**
   * Stops a command the way Ctrl-C does: an interrupt first, so that the run ends its problems as aborted and writes its result; a
   * terminate after the grace time, and a kill a little later still. Answers at once; the job's state changes when the process ends.
   */
  stop(id: string): Job {
    const live = this.jobs.get(id);
    if (live === undefined) throw new RequestError("no such command", 404);
    const state = live.job.state;
    if (state === "exited" || state === "failed" || state === "stopped") return live.job;
    this.interrupt(live);
    return live.job;
  }

  private interrupt(live: Live): void {
    if (live.stopRequested) return;
    live.stopRequested = true;
    const pid = live.child.pid;
    if (pid === undefined) return;
    const send = (signal: NodeJS.Signals) => {
      try {
        // A detached command leads its own process group; a command of this server is stopped by itself.
        live.child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    send("SIGINT");
    live.timers.push(setTimeout(() => send("SIGTERM"), this.options.graceMs).unref());
    live.timers.push(setTimeout(() => send("SIGKILL"), this.options.graceMs * 2).unref());
  }

  /** Stops every command this server started, except those the person started detached, and waits for them to end. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const waiting: Promise<void>[] = [];
    for (const live of this.jobs.values()) {
      const { job } = live;
      if (job.detached || job.state === "exited" || job.state === "failed" || job.state === "stopped") continue;
      this.interrupt(live);
      waiting.push(
        new Promise<void>((resolve) => {
          if (live.child.exitCode !== null || live.child.signalCode !== null) return resolve();
          live.child.once("close", () => resolve());
        }),
      );
    }
    await Promise.all(waiting);
  }
}

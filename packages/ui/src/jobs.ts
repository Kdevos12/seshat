import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { REPO_ROOT } from "@seshat/orchestrator";
import { forms, redact } from "./keys.ts";
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
  /** A detached command writes to this file; once it has ended, the stored keys are taken out of it. */
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

/** Which stored keys a command may have in its environment. */
export type KeyScope = { mode: "none" } | { mode: "all" } | { mode: "provider"; provider: string };

export interface ManagerOptions {
  command?: CommandFactory;
  cwd: string;
  /** The environment of a command: the process's, plus the stored keys the scope allows. */
  env: (scope: KeyScope) => Record<string, string | undefined>;
  /** The key values to hide from any line a command prints. */
  secrets: () => string[];
  /** Where the log of a detached command goes. */
  logDir: string;
  /** Lines of output kept per job. */
  keepLines?: number;
  /** Milliseconds a command is given to stop after the first signal, before a second, harder one. */
  graceMs?: number;
  /** Milliseconds to go on reading what a command printed after it ended, before the pipes are closed on a process that holds them. */
  drainMs?: number;
  /** Finished jobs kept in the list. */
  keepJobs?: number;
}

/** The variable that carries a job's signature nonce to the command, which removes it from its own environment at once. */
export const NONCE_VARIABLE = "SESHAT_ASK_NONCE";

const SIGNATURE_MARKER = "SESHAT_SIGNATURE ";
const MAX_RUNNING = 4;
/** A key is at most this long (keys.ts), so this much of an unfinished line is held back when a very long line is cut. */
const HOLD = 4096;

type Listener = (line: OutputLine | undefined, job: Job) => void;

interface Live {
  job: Job;
  child: ChildProcess;
  nonce: string;
  signatureSeen: boolean;
  stopRequested: boolean;
  listeners: Set<Listener>;
  partial: { out: string; err: string };
  nextLine: number;
  timers: NodeJS.Timeout[];
  settled: Promise<void>;
  settle: () => void;
}

const FINAL = new Set<JobState>(["exited", "failed", "stopped"]);

export class ProcessManager {
  private readonly jobs = new Map<string, Live>();
  private readonly options: Required<Pick<ManagerOptions, "cwd" | "env" | "secrets" | "logDir">> & { command: CommandFactory; keepLines: number; graceMs: number; drainMs: number; keepJobs: number };
  private shuttingDown = false;

  constructor(options: ManagerOptions) {
    this.options = {
      command: options.command ?? realCommand,
      cwd: options.cwd,
      env: options.env,
      secrets: options.secrets,
      logDir: options.logDir,
      keepLines: options.keepLines ?? 2000,
      graceMs: options.graceMs ?? 10_000,
      drainMs: options.drainMs ?? 1500,
      keepJobs: options.keepJobs ?? 50,
    };
  }

  list(): Job[] {
    return [...this.jobs.values()].map((l) => l.job).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)?.job;
  }

  /** The job that is running on a run directory, if any. */
  activeOn(runId: string): Job | undefined {
    return this.list().find((j) => j.runId === runId && !FINAL.has(j.state));
  }

  /** Starts a planned command. `detached` is honoured only where the plan allows it. */
  start(planned: Planned, o: { detached?: boolean } = {}): Job {
    if (this.shuttingDown) throw new RequestError("the server is stopping", 503);
    if (planned.runId !== undefined && this.activeOn(planned.runId) !== undefined) throw new RequestError("a command is already working on this run; stop it or wait for it", 409);
    if (this.list().filter((j) => !FINAL.has(j.state)).length >= MAX_RUNNING) throw new RequestError("too many commands are running", 429);
    const detached = o.detached === true;
    if (detached && !planned.mayDetach) throw new RequestError(`${planned.kind} cannot be started detached: it needs this page`, 400);
    const secrets = this.options.secrets();
    const { file, args } = this.options.command(planned.argv);
    const id = `job_${randomBytes(6).toString("hex")}`;
    const nonce = randomBytes(24).toString("base64url");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.options.env(planned.keys))) if (v !== undefined) env[k] = v;
    // Only a solve asks for a signature, and it is told this job's nonce, which no other text can know.
    if (planned.kind === "solve") env[NONCE_VARIABLE] = nonce;

    // Everything that can refuse has refused: now the command's input file is written, and removed again if the command cannot start.
    planned.prepare?.();
    let logFile: string | undefined;
    let logFd: number | undefined;
    let child: ChildProcess;
    try {
      if (detached) {
        mkdirSync(this.options.logDir, { recursive: true, mode: 0o700 });
        logFile = join(this.options.logDir, `${id}.log`);
        logFd = openSync(logFile, "a", 0o600);
      }
      // Every command leads its own process group, so that a stop reaches what it started (the prover's programs) and nothing is orphaned.
      child = spawn(file, args, { cwd: this.options.cwd, env, detached: true, stdio: detached ? ["ignore", logFd as number, logFd as number] : ["pipe", "pipe", "pipe"] });
    } catch (error) {
      planned.cleanup?.();
      throw error;
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
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
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const live: Live = { job, child, nonce, signatureSeen: false, stopRequested: false, listeners: new Set(), partial: { out: "", err: "" }, nextLine: 0, timers: [], settled, settle };
    this.jobs.set(id, live);
    this.prune();

    const finish = (code: number | null, signal: NodeJS.Signals | null, failed?: string) => {
      if (FINAL.has(job.state)) return;
      for (const t of live.timers) clearTimeout(t);
      // Whatever still holds the pipes (a program the command started) is ended, and the pipes are closed.
      if (!detached) {
        this.signalGroup(live, "SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      for (const stream of ["out", "err"] as const) {
        if (live.partial[stream] !== "") this.push(live, stream, live.partial[stream]);
        live.partial[stream] = "";
      }
      if (failed !== undefined) {
        this.push(live, "err", failed);
        planned.cleanup?.();
      }
      job.endedAt = new Date().toISOString();
      job.exitCode = code;
      job.signal = signal;
      job.state = failed !== undefined ? "failed" : live.stopRequested ? "stopped" : "exited";
      delete job.signature;
      if (logFile !== undefined) this.scrubLog(logFile);
      this.notify(live, undefined);
      live.settle();
    };
    child.on("error", (error) => finish(null, null, `could not start: ${redact(error.message, secrets)}`));
    // The state follows the process, not its pipes: a program that holds a pipe open cannot keep the job running.
    child.on("exit", (code, signal) => {
      live.timers.push(setTimeout(() => finish(code, signal), this.options.drainMs));
    });
    child.on("close", (code, signal) => finish(code, signal));
    if (!detached) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => this.collect(live, "out", chunk));
      child.stderr?.on("data", (chunk: string) => this.collect(live, "err", chunk));
      // A command that does not read its input must not make the server fail when the command exits first.
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});
    } else {
      child.unref();
    }
    return job;
  }

  /** Keeps the list of finished jobs from growing without end. */
  private prune(): void {
    const done = [...this.jobs.values()].filter((l) => FINAL.has(l.job.state)).sort((a, b) => (a.job.endedAt ?? "").localeCompare(b.job.endedAt ?? ""));
    for (const l of done.slice(0, Math.max(0, done.length - this.options.keepJobs))) this.jobs.delete(l.job.id);
  }

  /** A detached command's log is written raw by the command itself; once it has ended, the keys are taken out of it. */
  private scrubLog(file: string): void {
    try {
      const text = readFileSync(file, "utf8");
      const clean = redact(text, this.options.secrets());
      if (clean !== text) writeFileSync(file, clean, { mode: 0o600 });
    } catch {
      // The log may not exist or may be unreadable; the file's mode still protects it.
    }
  }

  private collect(live: Live, stream: "out" | "err", chunk: string): void {
    const text = live.partial[stream] + chunk;
    const parts = text.split("\n");
    live.partial[stream] = parts.pop() ?? "";
    for (const part of parts) this.push(live, stream, part.replace(/\r$/, ""));
    // A line with no end must not grow without bound. It is cut where no key sits across the cut, and the last HOLD characters, in which a key
    // may still be arriving, are kept for the next chunk.
    const held = live.partial[stream];
    if (held.length > 100_000) {
      let cut = held.length - HOLD;
      for (const secret of this.options.secrets()) {
        for (const form of forms(secret)) {
          let at = held.indexOf(form);
          while (at >= 0) {
            if (at < cut && cut < at + form.length) cut = at;
            at = held.indexOf(form, at + 1);
          }
        }
      }
      this.push(live, stream, held.slice(0, cut));
      live.partial[stream] = held.slice(cut);
    }
  }

  private push(live: Live, stream: "out" | "err", raw: string): void {
    const { job } = live;
    const secrets = this.options.secrets();
    const prefix = `${SIGNATURE_MARKER}${live.nonce} `;
    // Only the first line with this job's nonce counts, from a solve that has not been answered: any other line is text.
    if (stream === "out" && job.kind === "solve" && !live.signatureSeen && raw.startsWith(prefix)) {
      try {
        const parsed = JSON.parse(redact(raw.slice(prefix.length), secrets)) as { statementId?: unknown };
        if (typeof parsed === "object" && parsed !== null && typeof parsed.statementId === "string") {
          live.signatureSeen = true;
          job.signature = parsed;
          job.state = "awaiting_signature";
          const line = this.append(live, "out", "The statement is waiting for your signature.");
          this.notify(live, line);
          return;
        }
      } catch {
        // Not a signature after all: it is shown as the text it is.
      }
    }
    // Any other line is shown as the text it is, with the nonce itself never shown.
    const line = this.append(live, stream, redact(raw.split(live.nonce).join("[nonce]"), secrets));
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

  /**
   * The person's answer to the signature a command waits for. A yes names the statement that was shown (`yes STATEMENT_ID`): the command
   * accepts only that one, so an answer cannot be taken for another statement.
   */
  answer(id: string, yes: boolean): void {
    const live = this.jobs.get(id);
    if (live === undefined) throw new RequestError("no such command", 404);
    if (live.job.state !== "awaiting_signature") throw new RequestError("this command is not waiting for a signature", 409);
    const stdin = live.child.stdin;
    if (stdin === null || stdin === undefined || stdin.destroyed) throw new RequestError("this command cannot be answered", 409);
    const statementId = (live.job.signature as { statementId: string }).statementId;
    live.job.state = "running";
    delete live.job.signature;
    stdin.write(yes ? `yes ${statementId}\n` : "no\n");
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
    if (!FINAL.has(live.job.state)) this.interrupt(live);
    return live.job;
  }

  private signalGroup(live: Live, signal: NodeJS.Signals): void {
    const pid = live.child.pid;
    if (pid === undefined) return;
    try {
      // The command leads its process group: the signal reaches the programs it started as well.
      process.kill(-pid, signal);
    } catch {
      try {
        live.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  private interrupt(live: Live): void {
    if (live.stopRequested) return;
    live.stopRequested = true;
    this.signalGroup(live, "SIGINT");
    live.timers.push(setTimeout(() => this.signalGroup(live, "SIGTERM"), this.options.graceMs).unref());
    live.timers.push(setTimeout(() => this.signalGroup(live, "SIGKILL"), this.options.graceMs * 2).unref());
  }

  /** Stops every command this server started, except those the person started detached, and waits for them to end. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const waiting: Promise<void>[] = [];
    for (const live of this.jobs.values()) {
      if (live.job.detached || FINAL.has(live.job.state)) continue;
      this.interrupt(live);
      waiting.push(live.settled);
    }
    await Promise.all(waiting);
  }
}

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical-json.ts";
import type { HarnessEvent } from "./events.ts";
import { readEvents, verifyChain } from "./log.ts";

/**
 * The earlier journal a run starts on (`run.started`'s `memoryFrom`): where it is, which run it is,
 * and the hash of its last event, which the new run pins. The projection replays that journal before
 * the new one, checked against the hash, and nothing writes it (documentation/memory.md, "Memory
 * across runs").
 */
export interface MemoryFrom {
  /** The absolute path of the earlier run's directory. */
  path: string;
  runId: string;
  /** The hash of the last event of the earlier journal. The run is refused on a journal that ends otherwise. */
  lastHash: string;
  /** The number of events the earlier journal had. */
  events: number;
}

/** The chain of journals cannot be read, or is not the one the run pinned. */
export class MemoryChainError extends Error {}

/** One journal of a chain. */
export interface ChainSegment {
  dir: string;
  runId: string;
  /** Its events, as written; the chain only reads them. */
  events: readonly HarnessEvent[];
  lastHash: string;
  /** The Lean environment the run recorded (`environmentOf`); undefined when it recorded none that can be compared. */
  environment: string | undefined;
  /**
   * True when its environment is the one of the run that reads the chain: the statuses of its claims and
   * edges, and its validations, carry over. Otherwise they count for nothing until a stored proof passes
   * `validate` again in the reading run.
   */
  carried: boolean;
  /** What the run was configured with, as `run.started` recorded it. */
  run: { model?: string; promptVersion?: string; mathlibRev?: string };
}

/** The journals a run starts on, oldest first, with the Lean environment the run reading them is in. */
export interface MemoryChain {
  segments: readonly ChainSegment[];
  /** The environment of the reading run; undefined: none that can be compared, so no status carries. */
  environment: string | undefined;
  /** A hash of what was read (each journal's end and length, and whether it carries): a projection built on another chain is rebuilt. */
  hash: string;
  /** The blob directories of the chain, the newest run's first. */
  blobDirs: readonly string[];
  /** The earlier run that the reading run names in `run.started`. */
  from: MemoryFrom;
}

/**
 * The Lean environment of a run, as a text that is equal for two runs exactly when verified facts may
 * carry from one to the other.
 *
 * A run that records the Lean environment it was pinned to (`run.started`'s `config.leanEnv`, Task 21:
 * `{name, hash}`) is identified by its hash alone: `env:<hash>`. A record whose hash is null (the
 * environment was not resolved) has none that can be compared, so it never equals anything, itself
 * included. A run that recorded no environment (an older journal, or a host that names none) is
 * identified by the bench's revision and the Lean toolchain (the bench's `source`), which never equals
 * a hash. A bench whose revision or toolchain is unknown has none that can be compared.
 */
export function environmentId(source: { rev?: unknown; lean?: unknown }, leanEnv?: { hash?: unknown } | null): string | undefined {
  if (leanEnv !== undefined && leanEnv !== null) {
    return typeof leanEnv.hash === "string" && leanEnv.hash !== "" ? `env:${leanEnv.hash}` : undefined;
  }
  const known = (v: unknown): v is string => typeof v === "string" && v !== "" && v !== "unknown";
  return known(source.rev) && known(source.lean) ? `bench:${source.rev}|lean:${source.lean}` : undefined;
}

/** The environment a run's recorded configuration (`run.started`'s `config`) is in. */
export function environmentOf(config: unknown): string | undefined {
  const c = config as { leanEnv?: unknown; bench?: { source?: { rev?: unknown; lean?: unknown } | null } | null } | null | undefined;
  const recorded = typeof c?.leanEnv === "object" && c.leanEnv !== null ? (c.leanEnv as { hash?: unknown }) : undefined;
  return environmentId(c?.bench?.source ?? {}, recorded);
}

/** The first event of a journal file, if it has a whole one: how a run finds what it was started on. */
export function firstEvent(path: string): HarnessEvent | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const end = text.indexOf("\n");
  const line = end < 0 ? text : text.slice(0, end);
  if (line === "") return undefined;
  try {
    return JSON.parse(line) as HarnessEvent;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readSegment(dir: string, expect: Pick<MemoryFrom, "lastHash" | "events" | "runId"> | undefined, environment: string | undefined): ChainSegment {
  const path = join(dir, "journal.jsonl");
  if (!existsSync(path)) throw new MemoryChainError(`${dir} holds no earlier run: it has no journal.jsonl`);
  // A run that is still being written has no last hash to pin: it would move.
  const lock = `${path}.lock`;
  if (existsSync(lock)) {
    const pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
    if (Number.isInteger(pid) && alive(pid)) throw new MemoryChainError(`the run in ${dir} is still being written (process ${pid}): start on its memory when it has ended`);
  }
  let events: HarnessEvent[];
  try {
    events = readEvents(path);
  } catch (error) {
    throw new MemoryChainError(`the journal of ${dir} cannot be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const check = verifyChain(events);
  if (!check.ok) throw new MemoryChainError(`the journal of ${dir} is corrupt at seq ${check.seq}: ${check.reason}`);
  const last = events.at(-1);
  const first = events[0];
  if (last === undefined || first === undefined || first.type !== "run.started") {
    throw new MemoryChainError(`${dir} holds no earlier run: its journal does not begin with run.started`);
  }
  if (expect !== undefined && (last.hash !== expect.lastHash || events.length !== expect.events)) {
    throw new MemoryChainError(
      `the journal of ${dir} is not the one this run was started on: it has ${events.length} event(s) and ends at ${last.hash.slice(0, 12)}, ` +
        `the run pinned ${expect.events} event(s) ending at ${expect.lastHash.slice(0, 12)} (was the earlier run resumed or changed?)`,
    );
  }
  if (expect?.runId !== undefined && first.data.runId !== expect.runId) {
    throw new MemoryChainError(`the journal of ${dir} is the run ${first.data.runId}, not ${expect.runId}`);
  }
  const config = first.data.config as { model?: unknown; prompt?: { version?: unknown } | null; bench?: { source?: { rev?: unknown } | null } | null } | null;
  const own = environmentOf(first.data.config);
  const rev = config?.bench?.source?.rev;
  return {
    dir,
    runId: first.data.runId,
    events,
    lastHash: last.hash,
    environment: own,
    carried: environment !== undefined && own === environment,
    run: {
      ...(typeof config?.model === "string" ? { model: config.model } : {}),
      ...(typeof config?.prompt?.version === "string" ? { promptVersion: config.prompt.version } : {}),
      ...(typeof rev === "string" ? { mathlibRev: rev } : {}),
    },
  };
}

/**
 * Reads the chain of journals a run starts on: the journal in `path`, and the ones it was started on
 * in turn, each checked (its hash chain, the hash and length its successor pinned, that no process is
 * writing it). Throws `MemoryChainError` for anything else. `environment` is the reading run's Lean
 * environment (`environmentOf`); a journal recorded under another has its statuses reset.
 */
export function loadMemoryChain(path: string, environment: string | undefined, expect?: Pick<MemoryFrom, "lastHash" | "events" | "runId">): MemoryChain {
  const newestFirst: ChainSegment[] = [];
  const seen = new Set<string>();
  let next: { dir: string; expect: typeof expect } | undefined = { dir: resolve(path), expect };
  while (next !== undefined) {
    if (seen.has(next.dir)) throw new MemoryChainError(`the memory chain loops back to ${next.dir}`);
    seen.add(next.dir);
    const segment = readSegment(next.dir, next.expect, environment);
    newestFirst.push(segment);
    const started = segment.events[0];
    const earlier = started?.type === "run.started" ? started.data.memoryFrom : undefined;
    next = earlier === undefined ? undefined : { dir: resolve(earlier.path), expect: earlier };
  }
  const segments = newestFirst.reverse();
  const last = segments.at(-1) as ChainSegment;
  return {
    segments,
    environment,
    hash: sha256Hex(canonicalJson({ environment: environment ?? null, segments: segments.map((s) => ({ hash: s.lastHash, events: s.events.length, carried: s.carried })) })),
    blobDirs: [...segments].reverse().map((s) => join(s.dir, "blobs")),
    from: { path: last.dir, runId: last.runId, lastHash: last.lastHash, events: last.events.length },
  };
}

/** The chain a journal file was started on, from its `run.started`; undefined for a run that started on none. */
export function chainOfJournal(journalPath: string): MemoryChain | undefined {
  const first = firstEvent(journalPath);
  if (first?.type !== "run.started" || first.data.memoryFrom === undefined) return undefined;
  const from = first.data.memoryFrom;
  return loadMemoryChain(from.path, environmentOf(first.data.config), from);
}

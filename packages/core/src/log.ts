import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, unlinkSync, writeSync } from "node:fs";
import { canonicalJson, sha256Hex } from "./canonical-json.ts";
import { type EventDataMap, type EventType, type HarnessEvent, isEventType, type TornTail } from "./events.ts";
import { newId } from "./ids.ts";

export interface EventLogOptions {
  run: string;
  /** fsync after every append. Slower; use when a crash must not lose the last events. */
  durable?: boolean;
  now?: () => Date;
}

export type EventListener = (event: HarnessEvent) => void;

/**
 * Append-only JSONL journal with a hash chain. One process writes it at a time (a lock file next to
 * the journal enforces this); appends are synchronous so their order is the program order.
 */
export class EventLog {
  readonly path: string;
  readonly run: string;
  private fd: number;
  private lockPath: string;
  private nextSeq: number;
  private lastHash: string;
  private readonly durable: boolean;
  private readonly now: () => Date;
  private listeners: EventListener[] = [];
  /** What opening the journal did about a last line that a crash cut, if there was one. */
  readonly recovered: TornTail | undefined;

  private constructor(path: string, fd: number, lockPath: string, options: EventLogOptions, existing: HarnessEvent[], recovered?: TornTail) {
    this.path = path;
    this.recovered = recovered;
    this.fd = fd;
    this.lockPath = lockPath;
    this.run = options.run;
    this.durable = options.durable ?? false;
    this.now = options.now ?? (() => new Date());
    const last = existing.at(-1);
    this.nextSeq = existing.length;
    this.lastHash = last?.hash ?? "";
  }

  /**
   * Opens (or creates) a journal for appending. A last line that a crash cut is dealt with first
   * (`recovered` says how). Refuses a journal whose chain does not verify.
   */
  static open(path: string, options: EventLogOptions): EventLog {
    const lockPath = `${path}.lock`;
    acquireLock(lockPath);
    try {
      const recovered = existsSync(path) ? recoverTornTail(path) : undefined;
      const existing = existsSync(path) ? readEvents(path) : [];
      const check = verifyChain(existing);
      if (!check.ok) throw new Error(`journal ${path} is corrupt at seq ${check.seq}: ${check.reason}`);
      const fd = openSync(path, "a");
      return new EventLog(path, fd, lockPath, options, existing, recovered);
    } catch (error) {
      releaseLock(lockPath);
      throw error;
    }
  }

  get length(): number {
    return this.nextSeq;
  }

  onAppend(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  append<K extends EventType>(type: K, data: EventDataMap[K], actor: string): Extract<HarnessEvent, { type: K }> {
    if (this.fd < 0) throw new Error("journal is closed");
    const body = {
      v: 1 as const,
      seq: this.nextSeq,
      id: newId("evt"),
      ts: this.now().toISOString(),
      run: this.run,
      actor,
      type,
      data,
      prev: this.lastHash,
    };
    const hash = sha256Hex(canonicalJson(body));
    const event = { ...body, hash } as unknown as Extract<HarnessEvent, { type: K }>;
    writeSync(this.fd, `${canonicalJson(event)}\n`);
    if (this.durable) fsyncSync(this.fd);
    this.nextSeq++;
    this.lastHash = hash;
    for (const listener of this.listeners) listener(event);
    return event;
  }

  close(): void {
    if (this.fd < 0) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = -1;
    releaseLock(this.lockPath);
  }
}

export function readEvents(path: string): HarnessEvent[] {
  return parseEvents(readFileSync(path, "utf8"), path);
}

function parseEvents(text: string, path: string): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Only the last line can be torn (a crash during an append); anything else is corruption.
      if (i === lines.length - 1) break;
      throw new Error(`journal ${path}: invalid JSON on line ${i + 1}`);
    }
    if (!isEnvelope(parsed)) throw new Error(`journal ${path}: not an event on line ${i + 1}`);
    events.push(parsed);
  }
  return events;
}

export type ChainCheck = { ok: true } | { ok: false; seq: number; reason: string };

export function verifyChain(events: readonly HarnessEvent[]): ChainCheck {
  let prev = "";
  for (let i = 0; i < events.length; i++) {
    const event = events[i] as HarnessEvent;
    if (event.seq !== i) return { ok: false, seq: i, reason: `expected seq ${i}, found ${event.seq}` };
    if (event.prev !== prev) return { ok: false, seq: i, reason: "previous hash does not match" };
    const { hash, ...body } = event;
    if (sha256Hex(canonicalJson(body)) !== hash) return { ok: false, seq: i, reason: "hash does not match content" };
    prev = hash;
  }
  return { ok: true };
}

/**
 * Deals with a last line that has no newline, which only a crash during an append leaves, so that
 * the next append starts on a fresh line. A fragment is cut off (`dropped`): the events before it
 * are a prefix of the journal, and the hash chain still verifies. A line that is a whole event
 * whose hash and place in the chain verify, and lacks only its newline, is kept (`completed`):
 * dropping it would lose a fact the chain vouches for. What was found is returned, so that the run
 * that resumes can journal it (`run.resumed`).
 */
function recoverTornTail(path: string): TornTail | undefined {
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return undefined;
  const cut = bytes.lastIndexOf(0x0a) + 1;
  const rest = bytes.subarray(cut);
  const tail = rest.toString("utf8");
  // The digest is of the bytes on disk, not of their decoding: a fragment cut inside a multi-byte
  // character does not decode to the bytes that were there.
  const found = { bytes: rest.length, sha256: createHash("sha256").update(rest).digest("hex") };
  if (isWholeEvent(bytes.subarray(0, cut).toString("utf8"), tail, path)) {
    appendFileSync(path, "\n");
    return { action: "completed", ...found };
  }
  truncateSync(path, cut);
  return { action: "dropped", ...found };
}

/** Whether `tail` is an event that follows the events of `head` in the chain. */
function isWholeEvent(head: string, tail: string, path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(tail);
    if (!isEnvelope(parsed)) return false;
    return verifyChain([...parseEvents(head, path), parsed]).ok;
  } catch {
    return false;
  }
}

function isEnvelope(value: unknown): value is HarnessEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    e.v === 1 &&
    typeof e.seq === "number" &&
    typeof e.id === "string" &&
    typeof e.ts === "string" &&
    typeof e.run === "string" &&
    typeof e.actor === "string" &&
    isEventType(e.type) &&
    typeof e.data === "object" &&
    e.data !== null &&
    typeof e.prev === "string" &&
    typeof e.hash === "string"
  );
}

function acquireLock(lockPath: string): void {
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
    if (Number.isInteger(holder) && holder !== process.pid && isAlive(holder)) {
      throw new Error(`journal is locked by process ${holder} (${lockPath})`);
    }
    if (holder === process.pid) throw new Error(`journal is already open in this process (${lockPath})`);
    unlinkSync(lockPath);
    acquireLock(lockPath);
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

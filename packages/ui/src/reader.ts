import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { BlobStore, chainOfJournal, type HarnessEvent, type MemoryChain, Projection, readEvents } from "@seshat/core";
import {
  type Account,
  blobReader,
  buildAccount,
  buildResult,
  type PartialSketch,
  type ProblemStanding,
  type ProofFile,
  type RecordLine,
  renderResult,
  type Result,
  resumeCommand,
  turnRecords,
} from "@seshat/orchestrator";

/**
 * The journal reader of the local interface (Task 31, documentation/ui.md): the projection of a run directory as JSON, from its
 * journal and blobs alone. It adds no research logic: every number and status here is what `buildResult`, `buildAccount` and the
 * projection already say, and a claim's status is the projection's. Nothing in this file writes to a run directory.
 */

/** The statuses a claim can have, the journal's own words. */
export const CLAIM_STATUSES = ["open", "computed", "refuted", "proved", "proved_informal", "retracted"] as const;

/** How a person is told where a problem stands. Evidence and candidates are never `proved`. */
export type Level = "proved" | "refuted" | "candidate" | "leads" | "working" | "ended" | "nothing";

export interface PlainStatus {
  target: string;
  claimId: string;
  claimStatus: string;
  level: Level;
  /** One sentence for a person. */
  text: string;
}

export interface ClaimView {
  id: string;
  status: string;
  statement: string;
  kind: string;
  parent: string | null;
  /** True for the claim of a problem the run was asked to settle. */
  target: boolean;
}

export interface EdgeView {
  id: string;
  kind: string;
  from: string;
  to: string[];
  /** `lean_checked`, `human_signed`, `proposed`...: the journal's word. */
  status: string;
}

export interface TurnView {
  turn: number;
  limit: Record<string, number>;
  source: string;
  end: { reason: string; detail: string; minutes: number; spentTurnUsd: number; spentRunUsd: number } | null;
  /** The account of the turn (hints, problems, the questions asked of the team), when it can be built. */
  account: Account | null;
}

export interface ResumeInfo {
  checkout: string;
  bench?: string;
  host?: string;
}

export interface RunView {
  version: 1;
  /** The directory's name under the runs directory. */
  id: string;
  runId: string;
  state: Result["state"];
  stop: Result["stop"] | null;
  seconds: number;
  journal: Result["journal"];
  model: string | null;
  /** The plain-language status of each problem. */
  status: PlainStatus[];
  problems: ProblemStanding[];
  certifier: Result["certifier"];
  signature: Result["signature"] | null;
  claims: ClaimView[];
  claimsOmitted: number;
  claimCounts: Record<string, number>;
  edges: EdgeView[];
  edgesOmitted: number;
  /** Leads and evidence: marked, and never a claim's status. */
  leads: RecordLine[];
  evidence: RecordLine[];
  turns: TurnView[];
  spend: Result["spend"] & { leftUsd: number | null };
  proof: { certified: ProofFile[]; candidates: ProofFile[]; partial: PartialSketch[] };
  failed: Result["failed"];
  errors: string[];
  resume: string;
  resumeInfo: ResumeInfo | null;
  /** The text of RESULT.md as the journal would give it now. */
  resultMd: string;
}

const MAX_CLAIMS = 400;
const MAX_EDGES = 800;

/** What a person is told of one problem. */
export function plainStatus(p: ProblemStanding, hasEvidence: boolean, state: Result["state"]): PlainStatus {
  const base = { target: p.target, claimId: p.claimId, claimStatus: p.claimStatus };
  if (p.certified && p.claimStatus === "proved") return { ...base, level: "proved", text: "Proved. The Lean kernel checked a proof of this statement." };
  if (p.certified && p.claimStatus === "refuted") return { ...base, level: "refuted", text: "Refuted. The Lean kernel certified a proof that this statement is false." };
  if (p.claimStatus === "computed") return { ...base, level: "candidate", text: "A candidate proof passed the fast check. It is not certified: do not rely on it yet." };
  if (p.outcome !== undefined) {
    return { ...base, level: "ended", text: `Not solved. The problem ended as ${p.outcome}${p.reason !== undefined ? ` (${p.reason})` : ""}.${hasEvidence ? " Programs found leads, which are not proofs." : ""}` };
  }
  if (hasEvidence) return { ...base, level: "leads", text: "Not solved yet. Programs found leads or evidence, which are not proofs and change nothing about the statement." };
  return { ...base, level: state === "cut" ? "working" : "nothing", text: state === "cut" ? "Not solved yet. The run is working, or stopped without an end." : "Not solved yet. Nothing has been found." };
}

/** The journal of a run directory, or an error naming what is wrong with the directory. */
function journalOf(dir: string): string {
  const path = join(dir, "journal.jsonl");
  if (!existsSync(path)) throw new RunReadError(`${basename(dir)} is not a run directory: it has no journal.jsonl`);
  return path;
}

/** A run directory that cannot be read as a run. */
export class RunReadError extends Error {}

function chainOf(path: string): MemoryChain | { unreadable: string } | undefined {
  try {
    return chainOfJournal(path);
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
}

/** `resume.json`, which a run writes beside its journal: the checkout, bench and host it began with. */
export function readResumeInfo(dir: string): ResumeInfo | null {
  try {
    const saved = JSON.parse(readFileSync(join(dir, "resume.json"), "utf8")) as { checkout?: unknown; bench?: unknown; host?: unknown };
    if (typeof saved.checkout !== "string") return null;
    return { checkout: saved.checkout, ...(typeof saved.bench === "string" ? { bench: saved.bench } : {}), ...(typeof saved.host === "string" ? { host: saved.host } : {}) };
  } catch {
    return null;
  }
}

/** The view of a run directory. Throws `RunReadError` for a directory that is not a started run. */
export function readRun(dir: string): RunView {
  const path = journalOf(dir);
  const events = readEvents(path);
  if (!events.some((e) => e.type === "run.started")) throw new RunReadError(`${basename(dir)}: the run did not start, its journal is empty`);
  const blobs = new BlobStore(join(dir, "blobs"));
  const chain = chainOf(path);
  const first = buildResult(events, { blob: blobReader(blobs), ...(chain !== undefined ? { chain } : {}) });
  // The result knows the true state (a paused run is not cut); the command that continues the run is the one for that state.
  const result: Result = { ...first, resume: resumeCommand(dir, first.state) };
  const memory = chain !== undefined && !("unreadable" in chain) ? chain : undefined;

  const p = Projection.inMemory();
  try {
    if (memory !== undefined) p.attachChain(memory);
    for (const event of events) p.apply(event);
    const targets = new Set(result.problems.map((x) => x.claimId));
    const allClaims = p.claimsWhere();
    const claims: ClaimView[] = allClaims
      .slice(0, MAX_CLAIMS)
      .map((c) => ({ id: c.claim_id, status: c.status, statement: c.statement, kind: c.kind, parent: c.parent_id, target: targets.has(c.claim_id) }));
    const allEdges = p.edges();
    const edges: EdgeView[] = allEdges.slice(0, MAX_EDGES).map((e) => ({ id: e.edge_id, kind: e.kind, from: e.from_id, to: e.to, status: e.status }));

    const turns: TurnView[] = turnRecords(events).map((record) => {
      let account: Account | null = null;
      try {
        account = buildAccount(events, record.turn, { blob: blobReader(blobs), ...(memory !== undefined ? { chain: memory } : {}) });
      } catch {
        account = null;
      }
      return {
        turn: record.turn,
        limit: { ...record.limit },
        source: record.source,
        end:
          record.end === undefined
            ? null
            : { reason: record.end.reason, detail: record.end.detail, minutes: record.end.minutes, spentTurnUsd: record.end.spent.turn.usd, spentRunUsd: record.end.spent.run.usd },
        account,
      };
    });
    const lastAccount = [...turns].reverse().find((t) => t.account !== null)?.account ?? null;
    const budgetUsd = result.spend.budgetUsd;
    const leftUsd = lastAccount?.spend.leftUsd ?? (budgetUsd !== undefined ? Math.max(0, budgetUsd - result.spend.usd) : null);
    const hasEvidence = result.evidence.length > 0 || result.counterexamples.length > 0;
    return {
      version: 1,
      id: basename(dir),
      runId: result.runId,
      state: result.state,
      stop: result.stop ?? null,
      seconds: result.seconds,
      journal: result.journal,
      model: result.model ?? null,
      status: result.problems.map((x) => plainStatus(x, hasEvidence, result.state)),
      problems: result.problems,
      certifier: result.certifier,
      signature: result.signature ?? null,
      claims,
      claimsOmitted: Math.max(0, allClaims.length - claims.length),
      claimCounts: result.claims.byStatus,
      edges,
      edgesOmitted: Math.max(0, allEdges.length - edges.length),
      leads: result.counterexamples,
      evidence: result.evidence,
      turns,
      spend: { ...result.spend, leftUsd },
      proof: { certified: result.certified, candidates: result.candidates, partial: result.partial },
      failed: result.failed,
      errors: result.errors,
      resume: result.resume,
      resumeInfo: readResumeInfo(dir),
      resultMd: renderResult(result),
    };
  } finally {
    p.close();
  }
}

/** One entry of the list of runs. */
export interface RunListing {
  id: string;
  /** Milliseconds since the epoch of the journal's last write. */
  modified: number;
  bytes: number;
}

/** The run directories under `runsDir` (those that have a journal), the most recently written first. */
export function listRuns(runsDir: string): RunListing[] {
  if (!existsSync(runsDir)) return [];
  const out: RunListing[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const journal = join(runsDir, entry.name, "journal.jsonl");
    try {
      const s = statSync(journal);
      out.push({ id: entry.name, modified: s.mtimeMs, bytes: s.size });
    } catch {
      // A directory with no journal is not a run.
    }
  }
  return out.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
}

/** The directory of a run id under `runsDir`, or undefined when the id is not a single plain name that exists there. */
export function runDirectory(runsDir: string, id: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes("..")) return undefined;
  const root = resolve(runsDir);
  const dir = resolve(root, id);
  if (!dir.startsWith(root + sep)) return undefined;
  return existsSync(join(dir, "journal.jsonl")) ? dir : undefined;
}

/** What a journal tail says of an event: enough to know that the run moved, never the event's data. */
export interface TailEvent {
  seq: number;
  type: string;
  actor: string;
  ts: string;
}

/**
 * Follows a journal as it grows. It reads only the bytes after the last whole line it has seen, so a long journal costs nothing
 * to watch, and a half-written last line waits for its end.
 */
export class JournalTail {
  private offset = 0;
  private pending = "";
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The whole events written since the last call. */
  poll(): TailEvent[] {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        // The file was replaced by a shorter one: start again.
        this.offset = 0;
        this.pending = "";
      }
      if (size === this.offset) return [];
      const buffer = Buffer.alloc(size - this.offset);
      const n = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += n;
      this.pending += buffer.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    const out: TailEvent[] = [];
    for (const line of lines) {
      if (line === "") continue;
      try {
        const e = JSON.parse(line) as Partial<HarnessEvent>;
        if (typeof e.seq === "number" && typeof e.type === "string") out.push({ seq: e.seq, type: e.type, actor: typeof e.actor === "string" ? e.actor : "", ts: typeof e.ts === "string" ? e.ts : "" });
      } catch {
        // A line that is not an event is not announced; the reader reports a damaged journal.
      }
    }
    return out;
  }
}

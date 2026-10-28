import { checkEdge, linkFor, type EdgeCheck } from "@seshat/graph";
import { type LeanMeta, LeanMetaError } from "@seshat/lean-meta";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";

/**
 * Cheap tactic proofs of the link lemma of an `instance_of` edge, `(general) -> (special)`: the lemma is the
 * general statement applied to the special case's binders, so `apply h` closes it when the instance is a plain
 * one, and the others handle a conclusion that needs rewriting. Tried in order, one Lean check each.
 */
export const INSTANCE_CLOSERS: readonly string[] = [
  "intro h; exact h",
  "intro h; intros; apply h",
  "intro h; intros; simpa using h",
  "intro h; intros; exact h ‹_›",
  "aesop",
];

/** A subsumption found and checked: the special case follows from the general fact. */
export interface Subsumed {
  /** The special case, the claim an `instance_of` edge leaves. */
  instance: string;
  /** The general fact, the claim the edge reaches. */
  general: string;
  edgeId: string;
  /** Lean checked the edge's link lemma: only then can the edge propagate. */
  checked: boolean;
  tried: number;
}

export interface SubsumeOptions {
  meta: LeanMeta;
  memory: MemoryStore;
  validate: (request: ValidateRequest) => Promise<ValidateResult>;
  /** The header every claim compared is read under; claims under another header are not compared. */
  header: string;
  /** The most facts compared in one `lean.meta` call. */
  limit: number;
  signal?: AbortSignal;
  log?: (text: string) => void;
  /** Claims already compared with each other, `instance|general`: not asked again. */
  seen: Set<string>;
  /** Counts the calls `lean.meta` could not answer; after two the scheduler stops asking for the problem. */
  down?: { count: number };
}

const MAX_DOWN = 2;

const key = (instance: string, general: string) => `${instance}|${general}`;

/** Why `lean.meta` could not answer: said once, and the scheduler goes on without subsumption. */
function describe(error: unknown): string {
  return error instanceof LeanMetaError ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error);
}

/** Adds the `instance_of` edge (`from` the special case) and checks its link lemma with Lean. */
async function link(o: SubsumeOptions, instance: string, general: string): Promise<Subsumed | undefined> {
  const special = o.memory.claim(instance);
  const fact = o.memory.claim(general);
  if (special === undefined || fact === undefined) return undefined;
  const made = linkFor("instance_of", { id: instance, statement: special.statement }, [{ id: general, statement: fact.statement }]);
  if (made === undefined) return undefined;
  const existing = o.memory.edges({ from: instance, kinds: ["instance_of"] }).find((e) => e.to.length === 1 && e.to[0] === general);
  const edge = existing ?? o.memory.addEdge({ kind: "instance_of", from: instance, to: general, link: made, note: "found by lean.meta" });
  let check: EdgeCheck;
  try {
    check = await checkEdge({ memory: o.memory, validate: o.validate, header: o.header, closers: INSTANCE_CLOSERS, ...(o.log !== undefined ? { log: o.log } : {}) }, edge.edgeId);
  } catch (error) {
    if (o.signal?.aborted === true) throw error;
    o.log?.(`subsumption: the edge ${edge.edgeId} could not be checked: ${describe(error)}`);
    return { instance, general, edgeId: edge.edgeId, checked: false, tried: 0 };
  }
  return { instance, general, edgeId: edge.edgeId, checked: check.checked, tried: check.tried };
}

/** The claims the graph makes to check its edges (`checkEdge`) are lemmas about edges, not facts to compare statements with. */
export function isLinkLemma(claim: { gloss?: string | undefined }): boolean {
  return (claim.gloss ?? "").startsWith("link lemma of the ");
}

/** The known facts a claim is compared with: claims Lean accepted (`computed`, `proved`) under the same header, the latest first. */
export function knownFacts(memory: MemoryStore, header: string, exclude: readonly string[], limit: number): Array<{ claimId: string; statement: string }> {
  return memory
    .claims({ statuses: ["computed", "proved"], header, kind: "formal" })
    .filter((claim) => !exclude.includes(claim.claimId) && !isLinkLemma(claim))
    .slice(-limit)
    .reverse()
    .map((claim) => ({ claimId: claim.claimId, statement: claim.statement }));
}

/**
 * Forward subsumption: `claimId` is new; the known facts it is an instance of are found by `lean.meta`
 * (`instances`) and each gets an `instance_of` edge from the claim, checked by Lean. Nothing changes the claim's
 * status here: the graph derives it from a checked edge and a proved fact, and the composed proof goes through
 * `validate` (`realize`), so a claim is closed without a model, and by Lean.
 */
export async function forwardSubsume(o: SubsumeOptions, claimId: string): Promise<Subsumed[]> {
  const claim = o.memory.claim(claimId);
  if (claim === undefined || (o.down?.count ?? 0) >= MAX_DOWN) return [];
  const facts = knownFacts(o.memory, o.header, [claimId], o.limit).filter((f) => !o.seen.has(key(claimId, f.claimId)));
  if (facts.length === 0) return [];
  let found: string[];
  try {
    found = (await o.meta.instances(claim.statement, facts.map((f) => ({ name: f.claimId, statement: f.statement })), { header: o.header, ...(o.signal !== undefined ? { signal: o.signal } : {}) })).instanceOf;
  } catch (error) {
    if (o.signal?.aborted === true) throw error;
    if (o.down !== undefined) o.down.count += 1;
    o.log?.(`subsumption: lean.meta could not compare ${claimId}: ${describe(error)}`);
    return [];
  }
  for (const f of facts) o.seen.add(key(claimId, f.claimId));
  const out: Subsumed[] = [];
  for (const name of found) {
    if (!facts.some((f) => f.claimId === name)) continue;
    const done = await link(o, claimId, name);
    if (done !== undefined) out.push(done);
  }
  return out;
}

/**
 * Backward subsumption: `claimId` is a new fact; the open claims it covers (they are instances of it) are found by
 * `lean.meta` and each gets an `instance_of` edge to the fact, checked by Lean. A task on a claim that closes this
 * way ends `done` without a model.
 */
export async function backwardSubsume(o: SubsumeOptions, claimId: string, open: readonly string[]): Promise<Subsumed[]> {
  const fact = o.memory.claim(claimId);
  if (fact === undefined || (o.down?.count ?? 0) >= MAX_DOWN) return [];
  const candidates = open
    .filter((id) => id !== claimId && !o.seen.has(key(id, claimId)))
    .flatMap((id) => {
      const claim = o.memory.claim(id);
      return claim !== undefined && claim.header === o.header && claim.status === "open" ? [{ claimId: id, statement: claim.statement }] : [];
    })
    .slice(0, o.limit);
  if (candidates.length === 0) return [];
  let covers: string[];
  try {
    covers = (await o.meta.instances(fact.statement, candidates.map((c) => ({ name: c.claimId, statement: c.statement })), { header: o.header, ...(o.signal !== undefined ? { signal: o.signal } : {}) })).covers;
  } catch (error) {
    if (o.signal?.aborted === true) throw error;
    if (o.down !== undefined) o.down.count += 1;
    o.log?.(`subsumption: lean.meta could not compare ${claimId}: ${describe(error)}`);
    return [];
  }
  for (const c of candidates) o.seen.add(key(c.claimId, claimId));
  const out: Subsumed[] = [];
  for (const name of covers) {
    if (!candidates.some((c) => c.claimId === name)) continue;
    const done = await link(o, name, claimId);
    if (done !== undefined) out.push(done);
  }
  return out;
}

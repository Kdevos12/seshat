import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, hashJson, prepareSketch, sha256Hex, toPlainHeader } from "@seshat/core";
import { type BenchFilter, type BenchIndex, type BenchSource, describeCheckout, DISCRETE, select } from "./bench.ts";
import { type ProblemEntry, scanCheckout } from "./formal-conjectures.ts";

/**
 * The graded bench (plan change CA1): three grades of problems on which today's harness does not score zero, built from local
 * checkouts (nothing is vendored). A: exercises (the `textbook` and `test` theorems of formal-conjectures); B: competition problems
 * (a seeded sample of PutnamBench); C: research problems with a formal proof elsewhere (a seeded sample of the discrete bench).
 * Not the escalation ladder of line M12: that word means something else here.
 */
export const GRADES = ["A", "B", "C"] as const;
export type Grade = (typeof GRADES)[number];
export const GRADED_ID = "graded-v1" as const;

export type Admission = "admitted" | "unchecked";

export interface GradedSource extends BenchSource {
  /** The checkout's licence as far as its LICENSE file says; `unknown` when it is not recognised: read it before copying anything. */
  licence: string;
}

export interface GradedEntry extends ProblemEntry {
  grade: Grade;
  /** The key of `GradedBench.sources`. */
  source: string;
  sourceCommit: string;
  /** sha256 of the statement as written. */
  statementHash: string;
  licence: string;
  /** `admitted`: the statement compiled under the Lean environment; `unchecked`: no Lean was available when this was built. */
  admission: Admission;
}

export interface GradeInfo {
  description: string;
  source: string;
  /** Candidates that met the grade's rule; admitted and unchecked entries drawn; statements Lean could not read (left out). */
  candidates: number;
  entries: number;
  rejected: string[];
}

export interface GradedBench {
  v: 1;
  kind: "graded";
  benchId: typeof GRADED_ID;
  /** The seed of the samples of grades B and C: the same seed and checkouts give the same sample. */
  seed: string;
  sources: Record<string, GradedSource>;
  grades: Record<Grade, GradeInfo>;
  entries: GradedEntry[];
  hash: string;
}

/** Decides whether a statement compiles under the Lean environment; `snippet` is the file up to the theorem with its proof `sorry`. */
export type Admitter = (entry: ProblemEntry, snippet: string) => boolean;

export interface GradedOptions {
  /** A formal-conjectures checkout (grades A and C) and a PutnamBench checkout (grade B). */
  fc: string;
  putnam: string;
  seed: string;
  sizeB?: number;
  sizeC?: number;
  /** Where PutnamBench keeps its Lean files, relative to its checkout. */
  putnamDir?: string;
  /** Without it every entry is recorded as unchecked. */
  admit?: Admitter;
}

export function licenceOf(root: string): string {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "lean4/LICENSE"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").slice(0, 2000);
    if (/Apache License/i.test(text)) return "Apache-2.0";
    if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) return "MIT";
    return "unknown";
  }
  return "unknown";
}

/** The file of a problem up to its theorem, with the proof `sorry`: what Lean must be able to read for the problem to be admitted. */
export function admissionSnippet(root: string, entry: ProblemEntry): string {
  const sketch = prepareSketch(toPlainHeader(readFileSync(join(root, entry.path), "utf8")), entry.fullName);
  return `${sketch.prefix}${sketch.header} sorry\n`;
}

/** The Lean environment itself failed (a probe that does not compile, a timeout, a missing `lake`): not a verdict on any statement, so the build stops. */
export class AdmissionInfrastructureError extends Error {}

/** A statement that must compile in any working environment: run once before any candidate. */
const PROBE = "import Mathlib\n\ntheorem seshat_admission_probe : (1 : ℕ) + 1 = 2 := sorry\n";

/**
 * An admitter that runs `lake env lean` in the Lean project of an environment (`lean/env/base` once built): admitted when Lean
 * prints no error. A known-good probe statement is run first: when it does not compile, the project is not built or not the right
 * one, and the build stops with `AdmissionInfrastructureError` instead of rejecting every candidate. A timeout or a missing `lake`
 * is the same kind of failure, never a rejection: only a statement Lean answers with an error for is rejected.
 */
export function lakeAdmitter(project: string, options: { lake?: string; timeoutMs?: number } = {}): Admitter {
  const lake = options.lake ?? "lake";
  const run = (snippet: string): boolean => {
    const dir = mkdtempSync(join(tmpdir(), "seshat-admit-"));
    const file = join(dir, "Statement.lean");
    try {
      writeFileSync(file, snippet);
      execFileSync(lake, ["env", "lean", file], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: options.timeoutMs ?? 300_000 });
      return true;
    } catch (error) {
      const e = error as { code?: string; killed?: boolean; signal?: string | null };
      if (e.code === "ENOENT") throw new AdmissionInfrastructureError(`cannot admit statements: ${lake} is not installed`);
      if (e.code === "ETIMEDOUT" || e.killed === true || e.signal != null) throw new AdmissionInfrastructureError(`Lean did not answer in time (${options.timeoutMs ?? 300_000} ms): the build stops, no statement is rejected for it`);
      return false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  if (!run(PROBE)) throw new AdmissionInfrastructureError(`the probe statement does not compile in ${project} (is the Lean environment built, with Mathlib?): no statement was judged`);
  return (_entry, snippet) => run(snippet);
}

/** The candidates in the order of a seeded hash: the first `n` of it are `sample(candidates, n, seed)`. */
function seededOrder<T extends { id: string }>(candidates: readonly T[], seed: string): T[] {
  return [...candidates].map((p) => ({ p, key: sha256Hex(`${seed}\n${p.id}`) })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(({ p }) => p);
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Walks the candidates in seeded order and keeps those Lean admits until `limit` are kept (all of them without a limit); without an
 * admitter they are kept as unchecked. A statement Lean cannot read is never kept, so it is never an "unsolved" problem.
 */
function admitAll(root: string, candidates: readonly ProblemEntry[], seed: string, limit: number | undefined, admit: Admitter | undefined): { kept: Array<{ entry: ProblemEntry; admission: Admission }>; rejected: string[] } {
  const kept: Array<{ entry: ProblemEntry; admission: Admission }> = [];
  const rejected: string[] = [];
  for (const entry of seededOrder(candidates, seed)) {
    if (limit !== undefined && kept.length >= limit) break;
    if (admit === undefined) kept.push({ entry, admission: "unchecked" });
    else if (admit(entry, admissionSnippet(root, entry))) kept.push({ entry, admission: "admitted" });
    else rejected.push(entry.id);
  }
  return { kept: kept.sort((a, b) => byId(a.entry, b.entry)), rejected: rejected.sort() };
}

export function buildGraded(options: GradedOptions): GradedBench {
  const { fc, putnam, seed } = options;
  const fcSource: GradedSource = { ...describeCheckout(fc), licence: licenceOf(fc) };
  const putnamOwn = describeCheckout(putnam);
  // PutnamBench keeps its Lean toolchain and licence beside its Lean files.
  const putnamToolchain = join(putnam, "lean4", "lean-toolchain");
  const putSource: GradedSource = { ...putnamOwn, ...(putnamOwn.lean === "unknown" && existsSync(putnamToolchain) ? { lean: readFileSync(putnamToolchain, "utf8").trim() } : {}), licence: licenceOf(putnam) };
  const sources: Record<string, GradedSource> = { "formal-conjectures": fcSource, putnambench: putSource };
  const fcProblems = scanCheckout(fc).problems;
  const putProblems = scanCheckout(putnam, { dir: options.putnamDir ?? "lean4/src", fallbackCategory: "competition" }).problems;
  const usable = (p: ProblemEntry): boolean => !p.sorryInStatement && !p.proofInFile && p.unprovedBefore.length === 0;
  const candidates: Record<Grade, ProblemEntry[]> = {
    A: fcProblems.filter((p) => (p.category === "textbook" || p.category === "test") && p.ams.length > 0 && p.ams.every((c) => DISCRETE.ams.includes(c)) && usable(p)),
    B: putProblems.filter(usable),
    C: select(fcProblems, DISCRETE).filter((p) => p.formalProof !== undefined),
  };
  const plan: Record<Grade, { description: string; source: string; root: string; limit: number | undefined }> = {
    A: { description: "exercise level: the textbook and test theorems of formal-conjectures, discrete AMS codes", source: "formal-conjectures", root: fc, limit: undefined },
    B: { description: "competition level: a seeded sample of PutnamBench", source: "putnambench", root: putnam, limit: options.sizeB ?? 100 },
    C: { description: "research level: a seeded sample of fc-bench-v1-discrete, problems with a formal proof elsewhere", source: "formal-conjectures", root: fc, limit: options.sizeC ?? 70 },
  };
  const entries: GradedEntry[] = [];
  const grades = {} as Record<Grade, GradeInfo>;
  for (const grade of GRADES) {
    const { description, source, root, limit } = plan[grade];
    const { kept, rejected } = admitAll(root, candidates[grade], `${seed}\n${grade}`, limit, options.admit);
    const src = sources[source] as GradedSource;
    for (const { entry, admission } of kept) {
      entries.push({ ...entry, grade, source, sourceCommit: src.rev, statementHash: sha256Hex(entry.statement), licence: src.licence, admission });
    }
    if (kept.length === 0) throw new Error(`grade ${grade} has no ${options.admit === undefined ? "candidate" : "admitted entry"}: ${candidates[grade].length} candidate(s), ${rejected.length} rejected by Lean`);
    grades[grade] = { description, source, candidates: candidates[grade].length, entries: kept.length, rejected };
  }
  const body = { v: 1 as const, kind: "graded" as const, benchId: GRADED_ID, seed, sources, grades, entries };
  return { ...body, hash: hashJson(body) };
}

export function writeGraded(path: string, bench: GradedBench): void {
  writeFileSync(path, `${JSON.stringify(JSON.parse(canonicalJson(bench)), null, 1)}\n`);
}

export function isGraded(value: unknown): value is GradedBench {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "graded";
}

export function readGraded(path: string): GradedBench {
  const bench = JSON.parse(readFileSync(path, "utf8")) as GradedBench;
  const { hash, ...body } = bench;
  if (bench.v !== 1 || bench.kind !== "graded") throw new Error(`${path}: not a graded bench of version 1`);
  if (hashJson(body) !== hash) throw new Error(`${path}: hash does not match the content`);
  return bench;
}

/**
 * The index of one grade, in the shape a run reads. Refuses an empty grade and, unless `allowUnchecked`, entries no Lean admitted. Every
 * entry of a grade comes from one source, so one `--checkout` serves the run.
 */
export function gradedIndex(bench: GradedBench, grade: string, options: { allowUnchecked?: boolean } = {}): BenchIndex {
  if (!(GRADES as readonly string[]).includes(grade)) throw new Error(`the grade is one of ${GRADES.join(", ")}, got ${JSON.stringify(grade)}`);
  const entries = bench.entries.filter((e) => e.grade === grade);
  if (entries.length === 0) throw new Error(`${bench.benchId} has no problem of grade ${grade}`);
  const unchecked = entries.filter((e) => e.admission !== "admitted");
  if (unchecked.length > 0 && options.allowUnchecked !== true) {
    throw new Error(`${unchecked.length} of the ${entries.length} problems of grade ${grade} were never admitted by a Lean (the bench was built without one): rebuild it with a Lean environment, or pass --allow-unchecked`);
  }
  const info = bench.grades[grade as Grade];
  const { source: sourceKey } = info;
  const { licence: _licence, ...source } = bench.sources[sourceKey] as GradedSource;
  const filter: BenchFilter = { categories: [...new Set(entries.map((e) => e.category))].sort(), ams: [], includeProofInFile: false, excludeUnprovedBefore: true };
  const problems: ProblemEntry[] = entries.map(({ grade: _g, source: _s, sourceCommit: _c, statementHash: _h, licence: _l, admission: _a, ...entry }) => entry);
  const body = { v: 1 as const, benchId: `${bench.benchId}/${grade}`, source, filter, counts: { theorems: info.candidates, selected: problems.length, unreadable: 0 }, problems };
  return { ...body, hash: hashJson(body) };
}

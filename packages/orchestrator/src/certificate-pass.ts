import { readFileSync, writeFileSync } from "node:fs";
import {
  CERTIFICATE_METHODS,
  CERTIFICATE_NEEDS,
  type CertificateMethod,
  type CertificateNote,
  type ComputeTool,
  DEFAULT_CERTIFICATES,
  headerProblems,
  isCertificateMethod,
  leanTextProblems,
  primaryDomain,
  registryCompute,
  routeStatement,
  runCertificates,
  type TryRecord,
} from "@seshat/classical";
import type { LeanChecker } from "@seshat/core";
import { RegistryLeanChecker, type Registry } from "@seshat/registry";

/**
 * The real pass of plan change CX4 ($0): line M10's certificate stage alone on a small bench (`bench/cx4-certificates.json`),
 * every method on every problem, with no tactics, no model, no claim and no `validate`. It counts, per method, the certificates
 * that Lean accepted; it changes no status and writes no journal. Documented in documentation/classical.md.
 */
export interface CertificateBenchProblem {
  id: string;
  kind: "inequality" | "equation";
  /** In signature form, read after the bench's header. */
  statement: string;
  /** The methods the bench's author expects to close it. */
  expect: CertificateMethod[];
  note?: string;
}

export interface CertificateBench {
  benchId: string;
  header: string;
  problems: CertificateBenchProblem[];
}

export class CertificateBenchError extends Error {}

/**
 * Reads and checks a certificate bench file. Its header and statements reach Lean files, so they pass the screen of text that
 * reaches Lean first (`headerProblems`, `leanTextProblems`), as a bench's do anywhere else: a file that fails it is refused whole.
 */
export function readCertificateBench(path: string): CertificateBench {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CertificateBenchError(`cannot read the certificate bench ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const b = raw as Partial<CertificateBench>;
  if (typeof b !== "object" || b === null || typeof b.benchId !== "string" || typeof b.header !== "string" || !Array.isArray(b.problems)) {
    throw new CertificateBenchError(`${path} is not a certificate bench: it needs benchId, header and problems`);
  }
  const ids = new Set<string>();
  for (const p of b.problems as unknown[]) {
    const q = p as Partial<CertificateBenchProblem>;
    if (typeof q.id !== "string" || ids.has(q.id) || (q.kind !== "inequality" && q.kind !== "equation") || typeof q.statement !== "string" || !Array.isArray(q.expect) || !q.expect.every((m) => typeof m === "string" && isCertificateMethod(m))) {
      throw new CertificateBenchError(`${path}: problem ${JSON.stringify(q.id)} needs a new id, a kind (inequality or equation), a statement and the expected methods (${CERTIFICATE_METHODS.join(", ")})`);
    }
    ids.add(q.id);
  }
  const refused = [
    ...headerProblems(b.header).map((reason) => `its header: ${reason}`),
    ...(b.problems as CertificateBenchProblem[]).flatMap((p) => leanTextProblems(p.statement).map((reason) => `problem ${p.id}: ${reason}`)),
  ];
  if (refused.length > 0) throw new CertificateBenchError(`${path} is refused before Lean sees it: ${refused.join("; ")}`);
  return b as CertificateBench;
}

export interface CertificatePassRow {
  id: string;
  kind: CertificateBenchProblem["kind"];
  /** Whether the router tags the statement E6: only then does the battery run the stage. */
  e6: boolean;
  expect: CertificateMethod[];
  /** The methods whose certificate Lean accepted. */
  accepted: CertificateMethod[];
  tries: TryRecord[];
  notes: CertificateNote[];
  /** Lean and compute time, in milliseconds. */
  cpuMs: number;
}

export interface CertificatePassReport {
  benchId: string;
  /** The compute capability (b) and (c) used, or null when the host offers none. */
  compute: string | null;
  rows: CertificatePassRow[];
  /** Per method: the problems it was expected on, those where Lean accepted its certificate, and its Lean checks that got no answer. */
  perMethod: Record<CertificateMethod, { expected: number; accepted: number; unanswered: number }>;
  /** Problems where some method's certificate was accepted. */
  closed: number;
}

export interface CertificatePassDeps {
  checker: LeanChecker;
  /** The compute tool for one problem, in a session of its own; undefined when the host offers none. */
  compute: (problemId: string) => ComputeTool | undefined;
  /** Seconds each method may spend on a problem. Default 120. */
  budgetSec?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/** Runs every method of the stage on every problem (one at a time, so that each method's count is its own). */
export async function certificatePass(bench: CertificateBench, deps: CertificatePassDeps): Promise<CertificatePassReport> {
  const rows: CertificatePassRow[] = [];
  let capability: string | null = null;
  for (const problem of bench.problems) {
    if (deps.signal?.aborted) break;
    const route = routeStatement(problem.statement);
    const compute = deps.compute(problem.id);
    const row: CertificatePassRow = { id: problem.id, kind: problem.kind, e6: route.moves.includes("E6"), expect: problem.expect, accepted: [], tries: [], notes: [], cpuMs: 0 };
    try {
      for (const method of CERTIFICATE_METHODS) {
        const out = await runCertificates({
          checker: deps.checker,
          goal: { header: bench.header, statement: problem.statement },
          domain: primaryDomain(route),
          settings: { ...DEFAULT_CERTIFICATES, methods: [method] },
          ...(compute !== undefined ? { compute } : {}),
          budgetSec: deps.budgetSec ?? 120,
          // No claim and no validate: Lean's acceptance is what the pass counts.
          submit: async () => true,
          maxSubmissions: 1,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        });
        row.tries.push(...out.tries);
        row.notes.push(...out.notes);
        row.cpuMs += out.cpuMs;
        if (out.winner !== undefined) row.accepted.push(method);
      }
    } finally {
      // Read after the calls: the tool that answered, once one was found unavailable.
      if (compute !== undefined) capability = compute.capability;
      await compute?.release?.().catch(() => {});
    }
    rows.push(row);
    deps.log?.(`${problem.id.padEnd(10)} ${row.e6 ? "E6" : "--"}  accepted: ${row.accepted.join(", ") || "none"}  (expected ${problem.expect.join(", ")}; ${Math.round(row.cpuMs / 100) / 10} s)`);
  }
  const perMethod = Object.fromEntries(
    CERTIFICATE_METHODS.map((m) => [
      m,
      {
        expected: rows.filter((r) => r.expect.includes(m)).length,
        accepted: rows.filter((r) => r.accepted.includes(m)).length,
        unanswered: rows.reduce((n, r) => n + r.tries.filter((t) => t.tactic === `cert.${m}` && t.outcome === "error").length, 0),
      },
    ]),
  ) as CertificatePassReport["perMethod"];
  return { benchId: bench.benchId, compute: capability, rows, perMethod, closed: rows.filter((r) => r.accepted.length > 0).length };
}

/**
 * `harness certificates FILE [--host HOST] [--problem ID]... [--out FILE]`: the pass on the host's Lean (`lean.check`) and compute
 * tool (`compute.python`, else `compute.sage`), as tool runs of the actor `line:M10`. Prints a line per problem and the count per
 * method; `--out` writes the whole report as JSON.
 */
export async function certificatesCommand(registry: Registry, file: string, options: { problems?: readonly string[]; out?: string; log: (line: string) => void; signal?: AbortSignal }): Promise<number> {
  let bench: CertificateBench;
  try {
    bench = readCertificateBench(file);
  } catch (error) {
    if (!(error instanceof CertificateBenchError)) throw error;
    options.log(error.message);
    return 2;
  }
  if (options.problems !== undefined && options.problems.length > 0) {
    const unknown = options.problems.filter((id) => !bench.problems.some((p) => p.id === id));
    if (unknown.length > 0) {
      options.log(`${file} has no problem ${unknown.join(", ")}`);
      return 2;
    }
    bench = { ...bench, problems: bench.problems.filter((p) => options.problems?.includes(p.id)) };
  }
  const actor = "line:M10";
  const report = await certificatePass(bench, {
    checker: new RegistryLeanChecker(registry, { actor }),
    compute: (id) => registryCompute(registry, { actor, scope: `cx4-pass:${id}`, needs: CERTIFICATE_NEEDS }),
    log: options.log,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  options.log("");
  options.log(`compute tool: ${report.compute ?? "none (the host offers neither compute.python nor compute.sage: polyrith and sos are skipped)"}`);
  for (const m of CERTIFICATE_METHODS) {
    const c = report.perMethod[m];
    options.log(`${m.padEnd(10)} accepted by Lean on ${c.accepted} problem(s); expected on ${c.expected}${c.unanswered > 0 ? `; ${c.unanswered} check(s) got no answer from Lean` : ""}`);
  }
  options.log(`closed by some certificate: ${report.closed} of ${report.rows.length}`);
  if (options.out !== undefined) writeFileSync(options.out, `${JSON.stringify(report, null, 1)}\n`);
  return 0;
}

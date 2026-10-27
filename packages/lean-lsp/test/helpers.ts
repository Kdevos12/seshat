import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSketch, type Json, type Sketch } from "@seshat/core";
import { type Capability, type ImplementationFactory, loadCatalog, type ImplementationSpec, type InprocImplementationSpec } from "@seshat/registry";
import { LeanLspImplementation, leanLspFactory, type LeanLspFactoryOptions } from "../src/index.ts";
import type { FakeLeanLspMcp } from "./fixtures/fake-lean-lsp-mcp.ts";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));

export const catalog = loadCatalog(join(REPO, "capabilities"));
export const capability = catalog.capabilities.get("lean.lsp") as Capability;
export const spec = capability.manifest.implementations[0] as InprocImplementationSpec;

/** The sketch of the contract's file: no import, one theorem whose proof is `sorry`. */
export const SKETCH: Sketch = prepareSketch("theorem seshat_contract (n : Nat) : n + 0 = n := by\n  sorry\n", "seshat_contract");

/** A problem file as the bench has them: imports, a namespace, definitions, a docstring and an attribute. */
export const RICH_FILE = `import Mathlib

namespace Demo

def double (n : Nat) : Nat := n + n

/-- Doubling is adding. -/
@[simp]
theorem double_eq (n : Nat) : double n = n + n := by
    sorry

theorem later (n : Nat) : n = n := rfl

end Demo
`;
export const RICH: Sketch = prepareSketch(RICH_FILE, "Demo.double_eq");

/** A directory that is a Lean project for the factory's checks (the fake serves the files in it). */
export function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "mh-lean-lsp-"));
  writeFileSync(join(dir, "lean-toolchain"), "leanprover/lean4:v4.27.0\n");
  writeFileSync(join(dir, "lakefile.toml"), 'name = "demo"\n');
  return dir;
}

/** A scratch directory that is not a Lean project. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mh-lean-lsp-dir-"));
}

/** A factory for every in-process implementation of the catalog, except the ones given: a host profile needs them all. */
export function standIns(given: Record<string, ImplementationFactory>): Record<string, ImplementationFactory> {
  const idle: ImplementationFactory = () => ({ invoke: async () => ({}) });
  const named = [...catalog.capabilities.values()].flatMap((c) => c.manifest.implementations.flatMap((i) => (i.kind === "inproc" ? [i.factory] : [])));
  return { ...Object.fromEntries(named.map((name) => [name, idle])), ...given };
}

export interface Built {
  impl: LeanLspImplementation;
  project: string;
  /** The clock of the implementation, in milliseconds; move it to let a cooldown pass. */
  clock: { now: number };
}

/** The factory's implementation over the fake server, with the settings of the manifest and these. */
export function build(fake: FakeLeanLspMcp, settings: Record<string, Json> = {}, options: LeanLspFactoryOptions = {}): Built {
  const project = (settings.projectDir as string | undefined) ?? tempProject();
  fake.projectDir = project;
  const clock = { now: 1_000_000 };
  const impl = leanLspFactory({ transport: () => fake.transport(), now: () => clock.now, ...options })({
    capability: capability.manifest,
    spec,
    settings: { ...(spec.settings ?? {}), projectDir: project, ...settings },
  }) as LeanLspImplementation;
  return { impl, project, clock };
}

/** One call of the implementation in a scope. */
export function invoke(impl: LeanLspImplementation, input: Record<string, Json>, scope = "att_1", timeoutMs = 60_000): Promise<Json> {
  return impl.invoke(input as Json, { signal: new AbortController().signal, timeoutMs, scope });
}

/** The input of a file operation on the contract's sketch. */
export function onSketch(input: Record<string, Json>, sketch: Sketch = SKETCH): Record<string, Json> {
  return { ...input, sketch: sketch as unknown as Json };
}

export type { ImplementationSpec };

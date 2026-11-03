import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_FILE, loadEnvSpec, resolveEnvironment, writeEnvironment, type Fetcher } from "@seshat/lean-env";
import type { LeanChecker } from "@seshat/core";
import { leanCheckImplementation, loadCatalog, Registry, type HostProfile, type LeanEnvPin } from "@seshat/registry";
import { REPO_ROOT, type RunOptions } from "../src/index.ts";

/** Two resolved Lean environments (`base` and `extended`, which adds a package) written to a temporary directory, with their pins; nothing is fetched or built. */
const FC = "https://github.com/google-deepmind/formal-conjectures";
const BASE = `toolchain = "leanprover/lean4:v4.27.0"\n[base]\nname = "formal_conjectures"\ngit = "${FC}"\nrev = "bench-v1-lean4.27.0"\nlean_libs = ["FormalConjectures"]\n`;
const EXTENDED = `${BASE}\n[[package]]\nname = "Duper"\ngit = "https://github.com/leanprover-community/duper"\nrev = "v4.27.0"\nlean_libs = ["Duper"]\n`;
const MATHLIB = { name: "mathlib", type: "git", url: "https://github.com/leanprover-community/mathlib4", rev: "a".repeat(40), inputRev: "v4.27.0" };
const fetch: Fetcher = async (_source, file) => (file === "lean-toolchain" ? "leanprover/lean4:v4.27.0\n" : JSON.stringify({ packages: [MATHLIB] }));

export async function leanEnvPins(): Promise<{ base: LeanEnvPin; extended: LeanEnvPin }> {
  const root = mkdtempSync(join(tmpdir(), "mh-pins-"));
  writeFileSync(join(root, "base.toml"), BASE);
  writeFileSync(join(root, "extended.toml"), EXTENDED);
  const out: Record<string, LeanEnvPin> = {};
  for (const name of ["base", "extended"]) {
    const spec = loadEnvSpec(name, root);
    const { lock } = await resolveEnvironment(spec, { fetch });
    if (lock === undefined) throw new Error("the environment did not resolve");
    writeEnvironment(spec, lock, join(root, name));
    writeFileSync(join(root, name, BUILD_FILE), JSON.stringify({ hash: lock.hash, finishedAt: "now", steps: [] }));
    out[name] = { name, hash: lock.hash, dir: join(root, name), status: "resolved", built: true };
  }
  return out as { base: LeanEnvPin; extended: LeanEnvPin };
}

const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] } } };

/** The registry of the demo runs, built for the environment a line asks (M17) or else the base one. */
export function registryForPins(pins: { base: LeanEnvPin; extended: LeanEnvPin }, lean: LeanChecker): RunOptions["registry"] {
  return (journal, blobs, options) => new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean) }, journal, blobs, leanEnv: options?.leanEnv === "extended" ? pins.extended : pins.base });
}

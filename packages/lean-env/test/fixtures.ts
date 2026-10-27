import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Fetcher, PackageFile } from "../src/index.ts";

export const MATHLIB_URL = "https://github.com/leanprover-community/mathlib4";
export const MATHLIB = "a3a10db".padEnd(40, "0");
export const BATTERIES_URL = "https://github.com/leanprover-community/batteries";
export const BATTERIES = "b".repeat(40);
export const AESOP_URL = "https://github.com/leanprover-community/aesop";
export const AESOP = "c".repeat(40);
export const TOOLCHAIN = "leanprover/lean4:v4.27.0";

export interface Dep {
  name: string;
  url: string;
  rev: string;
  inputRev?: string;
}

/** A `lake-manifest.json` of a package named `name` that lists `deps`. */
export function manifest(name: string, deps: readonly Dep[]): string {
  return JSON.stringify({
    version: "1.1.0",
    packagesDir: ".lake/packages",
    packages: deps.map((d) => ({ url: d.url, type: "git", subDir: null, scope: "x", rev: d.rev, name: d.name, manifestFile: "lake-manifest.json", inputRev: d.inputRev ?? "main", inherited: false, configFile: "lakefile.lean" })),
    name,
    lakeDir: ".lake",
  });
}

export const mathlib = (rev = MATHLIB): Dep => ({ name: "mathlib", url: MATHLIB_URL, rev });
export const batteries = (rev = BATTERIES): Dep => ({ name: "batteries", url: BATTERIES_URL, rev });
export const aesop = (rev = AESOP): Dep => ({ name: "aesop", url: AESOP_URL, rev });

/** The files of remote packages, by `git@rev`; a fetcher over them that counts its calls. */
export function fixtureFetcher(files: Files): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async ({ git, rev }, file: PackageFile) => {
    calls.push(`${git}@${rev} ${file}`);
    const entry = files[`${git}@${rev}`];
    if (entry === undefined) return undefined;
    return file === "lean-toolchain" ? entry.toolchain : entry.manifest;
  }) as Fetcher & { calls: string[] };
  fetcher.calls = calls;
  return fetcher;
}

/** A directory for `lean/env/`, with the environment files given as `name -> text`. */
export function envRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "seshat-lean-env-"));
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

export const FC = "https://github.com/google-deepmind/formal-conjectures";
export const DUPER = "https://github.com/leanprover-community/duper";
export const PFR = "https://github.com/teorth/pfr";

export const BASE_TOML = `
description = "the bench"
toolchain = "leanprover/lean4:v4.27.0"

[base]
name = "formal_conjectures"
git = "${FC}"
rev = "bench-v1-lean4.27.0"
lean_libs = ["FormalConjectures"]
`;

export const EXTENDED_TOML = `${BASE_TOML}
[[package]]
name = "Duper"
git = "${DUPER}"
rev = "v4.27.0"
lean_libs = ["Duper"]

[[package]]
name = "PFR"
git = "${PFR}"
rev = "v4.27.0"
lean_libs = ["PFR"]
`;

/** The remote files that make the base project and Duper and PFR agree. */
export type Files = Record<string, { toolchain?: string; manifest?: string }>;

export function agreeing(): Files {
  return {
    [`${FC}@bench-v1-lean4.27.0`]: { toolchain: `${TOOLCHAIN}\n`, manifest: manifest("formal_conjectures", [mathlib(), batteries(), aesop()]) },
    [`${DUPER}@v4.27.0`]: { toolchain: `${TOOLCHAIN}\n`, manifest: manifest("Duper", [mathlib(), batteries(), aesop()]) },
    [`${PFR}@v4.27.0`]: { toolchain: `${TOOLCHAIN}\n`, manifest: manifest("PFR", [mathlib(), batteries()]) },
  };
}

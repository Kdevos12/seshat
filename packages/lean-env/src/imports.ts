import type { EnvLock } from "./lock.ts";

/**
 * The modules the files of a run in this environment import besides their own imports: the
 * libraries of the extra packages, in the order the environment lists them. The base project's
 * libraries are not among them (the bench's files import what they need of it), nor are a package's
 * dependencies.
 */
export function environmentImports(lock: Pick<EnvLock, "packages">): string[] {
  const modules: string[] = [];
  for (const pkg of lock.packages) {
    if (pkg.role === "base") continue;
    for (const lib of pkg.leanLibs) if (!modules.includes(lib)) modules.push(lib);
  }
  return modules;
}

/** An `import` line: `import A`, or `import A B` (Lean takes several modules on one line). */
const IMPORT = /^import\s+(\S+(?:\s+\S+)*)\s*$/;

/**
 * Adds `import <module>` for each module to a Lean file in plain-header form (its first non-blank
 * lines are its imports), after the file's last import, or at the top when it has none. A module the
 * file already imports is not added again. Nothing else in the file changes.
 */
export function withEnvironmentImports(source: string, modules: readonly string[]): string {
  if (modules.length === 0) return source;
  const lines = source.split("\n");
  let last = -1;
  const present = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const found = IMPORT.exec(line.replace(/\s*--.*$/, ""));
    if (found !== null) {
      for (const module of (found[1] as string).split(/\s+/)) present.add(module);
      last = i;
    } else if (line.trim() !== "" && !line.trim().startsWith("--")) {
      break;
    }
  }
  const added = modules.filter((m) => !present.has(m)).map((m) => `import ${m}`);
  if (added.length === 0) return source;
  lines.splice(last + 1, 0, ...added);
  return lines.join("\n");
}

/**
 * A Lean file that is only the environment's imports: a server that checks it without error has the
 * libraries. Undefined for an environment with no extra package.
 */
export function environmentProbe(lock: Pick<EnvLock, "packages">): string | undefined {
  const modules = environmentImports(lock);
  return modules.length === 0 ? undefined : `${modules.map((m) => `import ${m}`).join("\n")}\n`;
}

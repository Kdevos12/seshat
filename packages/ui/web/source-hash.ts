import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A digest of what the built front end is made from: the sources under `web/`, the package's own manifest (the pinned versions of the
 * libraries it bundles), the lockfile entries (integrity hashes) of the build libraries and everything they pull in, and the built files
 * themselves under `static/` (so a hand-edited bundle no longer matches). The build writes it beside the built files
 * (`static/source.sha256`); a test compares it with the sources, so a change that was not built again fails `pnpm check`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = join(here, "..", "static");
const BUILD_LIBRARIES = ["vite", "preact", "cytoscape"];

/** The lockfile's entries for the build libraries and, transitively, their dependencies: the snapshot and the integrity of each. */
export function lockClosure(lockfile: string): string {
  const lines = lockfile.split("\n");
  const section = (header: string): string[] => {
    const from = lines.indexOf(`${header}:`);
    if (from < 0) return [];
    const rest = lines.slice(from + 1);
    const to = rest.findIndex((l) => /^\S/.test(l));
    return to < 0 ? rest : rest.slice(0, to);
  };
  // Entries at two spaces of indent: `  key:` with their deeper lines.
  const entries = (body: string[]): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    let current: string[] | undefined;
    for (const line of body) {
      const m = /^ {2}(\S.*?):(?: .*)?$/.exec(line);
      if (m !== null) {
        current = [];
        map.set((m[1] as string).replace(/^'|'$/g, ""), current);
        if (line.length > m[0].length - 0 && /: \{.*\}$/.test(line)) current.push(line);
      } else if (current !== undefined) current.push(line);
    }
    return map;
  };
  const snapshots = entries(section("snapshots"));
  const packages = entries(section("packages"));
  const importers = entries(section("importers"));
  const mine = importers.get("packages/ui") ?? [];
  const todo: string[] = [];
  for (const name of BUILD_LIBRARIES) {
    const at = mine.findIndex((l) => l === `      ${name}:`);
    const version = at < 0 ? undefined : /^ {8}version: (.*)$/.exec(mine[at + 2] ?? "")?.[1];
    if (version !== undefined) todo.push(`${name}@${version}`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  while (todo.length > 0) {
    const key = todo.pop() as string;
    if (seen.has(key)) continue;
    seen.add(key);
    const body = snapshots.get(key);
    if (body === undefined) continue;
    out.push(key, ...body);
    out.push(...(packages.get(key.replace(/\(.*$/, "")) ?? []).filter((l) => l.includes("resolution:")));
    for (const line of body) {
      const dep = /^ {6}'?([^':]+)'?: (\S.*)$/.exec(line);
      if (dep !== null) todo.push(`${dep[1]}@${dep[2]}`);
    }
  }
  return out.sort().join("\n");
}

function staticFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...staticFiles(path));
    else if (entry.name !== "source.sha256") out.push(path);
  }
  return out.sort();
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else out.push(path);
  }
  return out.sort();
}

export function sourceHash(): string {
  const hash = createHash("sha256");
  for (const file of [...files(here), join(here, "..", "package.json")].filter((f) => !f.endsWith("source-hash.ts") && !f.endsWith("stamp.ts"))) {
    hash.update(relative(join(here, ".."), file));
    hash.update("\0");
    // The manifest counts only for what it pins, not for scripts or the description.
    if (file.endsWith("package.json")) {
      const { dependencies, devDependencies } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      hash.update(JSON.stringify({ dependencies, devDependencies }));
    } else {
      hash.update(readFileSync(file));
    }
    hash.update("\0");
  }
  hash.update("lock\0");
  hash.update(lockClosure(readFileSync(join(here, "..", "..", "..", "pnpm-lock.yaml"), "utf8")));
  for (const file of staticFiles(staticDir)) {
    hash.update(`static/${relative(staticDir, file)}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

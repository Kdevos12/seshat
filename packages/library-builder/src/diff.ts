import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { allowedPrefix, type LibrarySpec } from "./spec.ts";

/** One file the agent's working directory differs by, from the tree it started from. */
export interface Change {
  /** A new file, a modified file, a deleted file, or something that is not a regular file (a link, a device...). */
  status: "A" | "M" | "D" | "T";
  path: string;
  /** The file's bytes, for an added file; absent for a file larger than the cap, which is never read into memory. */
  content?: Buffer;
  /** The file's size in bytes. */
  size?: number;
  executable?: boolean;
}

/** The git blob id of bytes, as `git hash-object` gives it without filters. */
export function blobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** The blob id of a file, read in pieces, so a large file in the base is compared without holding it in memory. */
function blobIdOfFile(path: string, size: number): string {
  const hash = createHash("sha1").update(`blob ${size}\0`);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Directories the agent's work leaves that are not part of the project: Lake's build products and git's own. */
const SKIPPED = new Set([".git", ".lake"]);

export const MAX_ENTRIES = 50_000;

/**
 * What the agent changed, found by reading its directory and comparing it with the tree it started from (`base`: path to
 * blob id), never by asking the git directory in that folder, which the agent could have rewritten. Regular files only are
 * read; a link, a device or anything else is a change of status `T`.
 */
export function changesFrom(root: string, base: ReadonlyMap<string, string>, maxBytes: number = DEFAULT_LIMITS.maxBytesPerFile): Change[] {
  const changes: Change[] = [];
  const seen = new Set<string>();
  let entries = 0;
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      if (relative === "" && SKIPPED.has(name)) continue;
      if (SKIPPED.has(name) && name === ".lake") continue;
      const path = relative === "" ? name : `${relative}/${name}`;
      if (++entries > MAX_ENTRIES) throw new Error(`the agent's directory holds more than ${MAX_ENTRIES} entries`);
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) {
        walk(path);
      } else if (!stat.isFile()) {
        changes.push({ status: "T", path });
        seen.add(path);
      } else {
        seen.add(path);
        const executable = (stat.mode & 0o111) !== 0;
        const known = base.get(path);
        if (known === undefined && stat.size > maxBytes) {
          // A new file over the cap is not read: its size is the finding.
          changes.push({ status: "A", path, size: stat.size, executable });
        } else if (known !== undefined && stat.size > maxBytes) {
          if (known !== blobIdOfFile(join(root, path), stat.size)) changes.push({ status: "M", path, size: stat.size, executable });
        } else {
          const content = readFileSync(join(root, path));
          if (known === undefined) changes.push({ status: "A", path, content, size: content.length, executable });
          else if (known !== blobId(content)) changes.push({ status: "M", path, content, size: content.length, executable });
        }
      }
    }
  };
  walk("");
  for (const path of base.keys()) if (!seen.has(path) && !path.split("/").some((p) => p === ".lake")) changes.push({ status: "D", path });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface DiffLimits {
  maxFiles: number;
  maxBytesPerFile: number;
}

export const DEFAULT_LIMITS: DiffLimits = { maxFiles: 40, maxBytesPerFile: 512 * 1024 };

/** The non-Lean files a port may add. `lakefile.lean` is code and is a `.lean` file: the gate treats it as code that runs, not as a Lean source. */
const PORT_FILES = /(?:^|\/)(?:lakefile\.toml|lean-toolchain|lake-manifest\.json|LICENSE|README\.md)$/;

/** Whether a relative path is confined: no `..`, no absolute or backslash path, no `.git`, no hidden segment. */
export function pathProblem(path: string): string | undefined {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return "not a relative path";
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return "has an empty, . or .. segment";
  if (parts.some((p) => p.startsWith("."))) return "has a hidden segment";
  // Plain ASCII names only: no look-alike letters, no control or bidirectional characters, no spaces.
  if (parts.some((p) => !/^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/.test(p))) return "has a character outside A-Z a-z 0-9 _ . -";
  return undefined;
}

/**
 * The rules about the diff (plan change LC4, gate rule 2): it only adds regular files, under the spec's directory
 * (`<libRoot>/SeshatLib/<domain>/`, or the ported package's), each of a type the job allows, not too many or too large.
 * Returns the violations, empty when the diff is confined.
 */
export function diffViolations(changes: readonly Change[], spec: LibrarySpec, libRoot: string, limits: DiffLimits = DEFAULT_LIMITS): string[] {
  const prefix = `${libRoot}/${allowedPrefix(spec).replace(/^lean\//, "")}`;
  const violations: string[] = [];
  if (changes.length === 0) return ["the agent changed nothing"];
  if (changes.length > limits.maxFiles) violations.push(`${changes.length} changed files, more than the ${limits.maxFiles} allowed`);
  for (const c of changes) {
    const bad = pathProblem(c.path);
    if (c.status === "T") violations.push(`${c.path}: not a regular file (a link or a special file)`);
    else if (c.status === "M") violations.push(`${c.path}: an existing file was modified`);
    else if (c.status === "D") violations.push(`${c.path}: an existing file was deleted`);
    else if (bad !== undefined) violations.push(`${c.path}: ${bad}`);
    else if (!c.path.startsWith(prefix)) violations.push(`${c.path}: outside ${prefix}`);
    else if (!(c.path.endsWith(".lean") || (spec.job === "port" && PORT_FILES.test(c.path)))) violations.push(`${c.path}: a file of a type this job does not add`);
    else if (c.executable === true) violations.push(`${c.path}: executable`);
    else if ((c.size ?? c.content?.length ?? 0) > limits.maxBytesPerFile) violations.push(`${c.path}: larger than ${limits.maxBytesPerFile} bytes`);
    else if (c.content !== undefined && c.content.includes(0)) violations.push(`${c.path}: not text`);
  }
  if (!changes.some((c) => c.status === "A" && c.path.endsWith(".lean"))) violations.push("no Lean file was added");
  return violations;
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Hex } from "@seshat/core";

/**
 * The files the language server reads, one per scope (one per attempt of a run), in a directory of
 * the Lean project that git ignores. They are the only files a prover's queries ever name: the
 * harness writes the sketch with the prover's regions into them, and passes the server their
 * project-relative paths. A prover never gives a path, and nothing else is written.
 */
export class Scratch {
  /** Absolute path of the directory. */
  readonly dir: string;
  /** The same, relative to the project, with `/` (what the server is given). */
  readonly relativeDir: string;
  private readonly files = new Map<string, { path: string; text: string }>();
  private ready = false;

  constructor(projectDir: string, scratchDir: string) {
    const project = resolve(projectDir);
    if (isAbsolute(scratchDir) || scratchDir.split(/[\\/]/).includes("..") || scratchDir.trim() === "") {
      throw new Error(`the scratch directory ${JSON.stringify(scratchDir)} must be a directory inside the Lean project, given relative to it`);
    }
    this.dir = resolve(project, scratchDir);
    const inside = relative(project, this.dir);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`the scratch directory ${JSON.stringify(scratchDir)} is not inside the Lean project`);
    }
    this.relativeDir = inside.split(sep).join("/");
  }

  /** The name of a scope's file: readable, and distinct for scopes that sanitize to the same text. */
  nameOf(scope: string): string {
    return `${scope.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)}-${sha256Hex(scope).slice(0, 8)}.lean`;
  }

  /** The project-relative path of a scope's file. */
  pathOf(scope: string): string {
    return `${this.relativeDir}/${this.nameOf(scope)}`;
  }

  /** Puts `text` in the scope's file, unless it holds it already; returns the project-relative path. */
  write(scope: string, text: string): string {
    const known = this.files.get(scope);
    const path = join(this.dir, this.nameOf(scope));
    if (known === undefined || known.text !== text || !existsSync(path)) {
      this.prepare();
      writeFileSync(path, text);
      this.files.set(scope, { path, text });
    }
    return this.pathOf(scope);
  }

  /** Deletes the scope's file. */
  remove(scope: string): void {
    const known = this.files.get(scope);
    this.files.delete(scope);
    if (known !== undefined) rmSync(known.path, { force: true });
  }

  /** Deletes the files of every scope. */
  removeAll(): void {
    for (const scope of [...this.files.keys()]) this.remove(scope);
  }

  private prepare(): void {
    if (this.ready && existsSync(this.dir)) return;
    mkdirSync(this.dir, { recursive: true });
    // Git ignores everything in the directory, this file included.
    const ignore = join(this.dir, ".gitignore");
    if (!existsSync(ignore) || readFileSync(ignore, "utf8") !== "*\n") writeFileSync(ignore, "*\n");
    this.ready = true;
  }
}

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, type Json, sha256Hex } from "./canonical-json.ts";

/**
 * Content-addressed storage next to a journal. A blob is stored under the sha256 of its text, so an
 * event that names a hash always finds the same content, and the content can be checked against
 * its name. JSON values are stored as canonical JSON, so their name is `hashJson(value)`.
 */
export class BlobStore {
  readonly dir: string;
  /** The blob directories of earlier runs, read after this one's and never written (documentation/memory.md, "Memory across runs"). */
  readonly readFrom: readonly string[];

  constructor(dir: string, readFrom: readonly string[] = []) {
    this.dir = dir;
    this.readFrom = readFrom;
    mkdirSync(dir, { recursive: true });
  }

  /** Stores a text and returns its sha256. Storing the same text again writes nothing. */
  put(text: string): string {
    const hash = sha256Hex(text);
    const path = this.path(hash);
    if (!existsSync(path)) {
      mkdirSync(join(this.dir, hash.slice(0, 2)), { recursive: true });
      // Written aside, then renamed: a reader never sees half a blob.
      const partial = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.partial`;
      writeFileSync(partial, text);
      renameSync(partial, path);
    }
    return hash;
  }

  /** Stores a JSON value as canonical JSON and returns `hashJson(value)`. */
  putJson(value: unknown): string {
    return this.put(canonicalJson(value));
  }

  has(hash: string): boolean {
    return this.found(hash) !== undefined;
  }

  /** The text stored under `hash` here or in an earlier run's directory, or undefined. Throws if the file does not match its name. */
  get(hash: string): string | undefined {
    const path = this.found(hash);
    if (path === undefined) return undefined;
    const text = readFileSync(path, "utf8");
    if (sha256Hex(text) !== hash) throw new Error(`blob ${hash} does not match its content`);
    return text;
  }

  getJson(hash: string): Json | undefined {
    const text = this.get(hash);
    return text === undefined ? undefined : (JSON.parse(text) as Json);
  }

  private path(hash: string, dir: string = this.dir): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`not a sha256: ${JSON.stringify(hash)}`);
    return join(dir, hash.slice(0, 2), hash);
  }

  /** The file that holds `hash`: this run's, else the first earlier run's that has it. */
  private found(hash: string): string | undefined {
    for (const dir of [this.dir, ...this.readFrom]) {
      const path = this.path(hash, dir);
      if (existsSync(path)) return path;
    }
    return undefined;
  }
}

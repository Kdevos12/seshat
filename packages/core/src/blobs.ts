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

  constructor(dir: string) {
    this.dir = dir;
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
    return existsSync(this.path(hash));
  }

  /** The text stored under `hash`, or undefined. Throws if the file does not match its name. */
  get(hash: string): string | undefined {
    const path = this.path(hash);
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, "utf8");
    if (sha256Hex(text) !== hash) throw new Error(`blob ${hash} does not match its content`);
    return text;
  }

  getJson(hash: string): Json | undefined {
    const text = this.get(hash);
    return text === undefined ? undefined : (JSON.parse(text) as Json);
  }

  private path(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`not a sha256: ${JSON.stringify(hash)}`);
    return join(this.dir, hash.slice(0, 2), hash);
  }
}

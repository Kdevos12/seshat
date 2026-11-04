import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * The API keys of the local interface (documentation/ui.md, "Provider settings"). Each key lives in one local file with mode 0600, in a
 * directory with mode 0700, outside the repository. The server reads it to build the environment of a subprocess, which is how a command
 * receives a key; the browser can save a key and delete it, and is never sent one back. A key is not logged, not journaled, and
 * not part of any response.
 */

/** A problem with the key file, in words a person can act on. It never holds a key. */
export class KeyFileError extends Error {}

interface Stored {
  /** The environment variable the provider reads its key from, as pi-ai says. */
  variable: string;
  key: string;
}

interface FileShape {
  version: 1;
  keys: Record<string, Stored>;
}

/** Where keys live unless `SESHAT_KEYS_FILE` says otherwise: `$XDG_CONFIG_HOME/seshat/keys.json`, or `~/.config/seshat/keys.json`. */
export function defaultKeyFile(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const given = env.SESHAT_KEYS_FILE;
  if (given !== undefined && given !== "") return resolve(given);
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".config");
  return join(base, "seshat", "keys.json");
}

/** What a key may look like: one line of printable characters. */
export function validKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 8 && key.length <= 4096 && /^[\x21-\x7e]+$/.test(key);
}

const VARIABLE = /^[A-Z][A-Z0-9_]{1,80}$/;

export class KeyStore {
  readonly file: string;

  /** `repoRoot`: a file inside it is refused, so a key cannot be committed by mistake. */
  constructor(file: string, repoRoot?: string) {
    this.file = resolve(file);
    if (repoRoot !== undefined) {
      const root = resolve(repoRoot);
      if (this.file === root || this.file.startsWith(root.endsWith(sep) ? root : root + sep)) {
        throw new KeyFileError(`the key file must be outside the repository (${root}); set SESHAT_KEYS_FILE to a path elsewhere`);
      }
    }
  }

  private read(): FileShape {
    if (!existsSync(this.file)) return { version: 1, keys: {} };
    const s = lstatSync(this.file);
    if (s.isSymbolicLink() || !s.isFile()) throw new KeyFileError(`${this.file} is not a plain file`);
    if ((s.mode & 0o077) !== 0) {
      throw new KeyFileError(`${this.file} can be read by other users (mode ${(s.mode & 0o777).toString(8)}): run chmod 600 on it, or delete it and save the keys again`);
    }
    if (typeof process.getuid === "function" && s.uid !== process.getuid()) throw new KeyFileError(`${this.file} belongs to another user`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new KeyFileError(`${this.file} is not valid JSON; delete it and save the keys again`);
    }
    const keys: Record<string, Stored> = {};
    const raw = (parsed as { keys?: unknown } | null)?.keys;
    if (typeof raw === "object" && raw !== null) {
      for (const [id, v] of Object.entries(raw)) {
        const e = v as Partial<Stored> | null;
        if (e !== null && typeof e === "object" && typeof e.variable === "string" && VARIABLE.test(e.variable) && validKey(e.key)) keys[id] = { variable: e.variable, key: e.key };
      }
    }
    return { version: 1, keys };
  }

  private write(data: FileShape): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // A directory we do not own: the file's own mode still protects the keys.
    }
    const temporary = `${this.file}.${process.pid}.tmp`;
    // The file is created with mode 0600 and nothing is ever written to it with a wider one.
    const fd = openSync(temporary, "w", 0o600);
    try {
      chmodSync(temporary, 0o600);
      writeSync(fd, `${JSON.stringify(data)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.file);
  }

  /** The ids of the providers that have a stored key. */
  providers(): string[] {
    return Object.keys(this.read().keys);
  }

  has(providerId: string): boolean {
    return Object.hasOwn(this.read().keys, providerId);
  }

  set(providerId: string, variable: string, key: string): void {
    if (!VARIABLE.test(variable)) throw new KeyFileError("not an environment variable name");
    if (!validKey(key)) throw new KeyFileError("a key is one line of 8 to 4096 printable characters, without spaces");
    const data = this.read();
    data.keys[providerId] = { variable, key };
    this.write(data);
  }

  remove(providerId: string): boolean {
    const data = this.read();
    if (!Object.hasOwn(data.keys, providerId)) return false;
    delete data.keys[providerId];
    this.write(data);
    return true;
  }

  /** The environment variables of the stored keys, for a subprocess. */
  env(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { variable, key } of Object.values(this.read().keys)) out[variable] = key;
    return out;
  }

  /** The key values, to be hidden from any text the server relays. */
  secrets(): string[] {
    return Object.values(this.read().keys).map((e) => e.key);
  }
}

/** Replaces every stored key in a line of text. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join("[key hidden]");
  return out;
}

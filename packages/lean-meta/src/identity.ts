import { statementIdV0 } from "@seshat/core";
import type { StatementContext, StatementIdentity } from "@seshat/memory";
import type { LeanMeta } from "./meta.ts";

export interface LeanIdentityOptions {
  /** The header of a statement that has none. Default: `lean.meta`'s, `import Mathlib`. */
  header?: string;
  /** Lean's time limit for one id, in seconds. */
  timeoutSec?: number;
  /** Ids kept in memory, so that a statement asked again costs no Lean call. Default 10000. */
  cacheSize?: number;
}

/**
 * Version 1 of the statement identity: the hash of the statement's elaborated term, computed by
 * Lean (`lean.meta`, op `hash`; documentation/lean-meta.md#the-canonical-form). The statement is
 * read under its header, so the names of a problem's definitions resolve, and the id ignores bound
 * names, binder kinds and the instance paths elaboration took: `(n : ℕ) : n + 0 = n` and
 * `{m : Nat} : m + 0 = m` are the same claim. An informal statement cannot be elaborated: it keeps
 * its textual id (`st0_`), and can only be the same claim as the same informal text.
 *
 * A statement Lean refuses has no id: `id` throws the `LeanMetaError` (kind `rejected`), and so does
 * `ensureClaim`. Ids are cached by statement and header; a failed call is not.
 */
export class LeanIdentity implements StatementIdentity {
  readonly version = "st1";
  private readonly meta: LeanMeta;
  private readonly header: string | undefined;
  private readonly timeoutSec: number | undefined;
  private readonly cacheSize: number;
  private readonly cache = new Map<string, Promise<string>>();

  constructor(meta: LeanMeta, options: LeanIdentityOptions = {}) {
    this.meta = meta;
    this.header = options.header;
    this.timeoutSec = options.timeoutSec;
    this.cacheSize = Math.max(1, options.cacheSize ?? 10_000);
  }

  id(statement: string, context: StatementContext = {}): Promise<string> {
    if (context.kind === "informal") return Promise.resolve(statementIdV0(statement));
    const header = context.header ?? this.header;
    const key = JSON.stringify([statement, header ?? null]);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // Most recently used last, so that the oldest entry is the first one dropped.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const pending = this.meta.hash(statement, {
      ...(header !== undefined ? { header } : {}),
      ...(this.timeoutSec !== undefined ? { timeoutSec: this.timeoutSec } : {}),
    });
    this.cache.set(key, pending);
    pending.catch(() => {
      if (this.cache.get(key) === pending) this.cache.delete(key);
    });
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
    return pending;
  }
}

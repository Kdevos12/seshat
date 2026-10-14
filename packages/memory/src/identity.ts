import { type ClaimKind, statementIdV0 } from "@seshat/core";

/** What a statement means besides its text: the Lean header it is read under, and its kind. */
export interface StatementContext {
  header?: string;
  kind?: ClaimKind;
}

/**
 * How the memory names statements: two statements with the same id are the same claim ("same
 * hash, same claim", plan §3.1). Ids of different versions never compare equal, so a run uses one
 * identity. An identity may need Lean to compute an id, hence the promise.
 */
export interface StatementIdentity {
  /** The family of the ids, which is also their prefix: `st0`, `st1`... */
  readonly version: string;
  id(statement: string, context?: StatementContext): string | Promise<string>;
}

/**
 * Version 0: a hash of the statement's text without comments and with whitespace collapsed
 * (`statementIdV0`). It only catches textual duplicates, and ignores the header.
 */
export class TextIdentity implements StatementIdentity {
  readonly version = "st0";

  id(statement: string): string {
    return statementIdV0(statement);
  }
}

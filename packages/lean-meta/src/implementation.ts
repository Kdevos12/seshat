import { importsOf, type Json, type LeanCheckResult, type LeanMessage, toPlainHeader } from "@seshat/core";
import {
  type FactoryContext,
  type HealthAwareChecker,
  type HealthCheck,
  type ImplementationFactory,
  type ImplementationInstance,
  UnavailableError,
} from "@seshat/registry";
import { DEFAULT_HEADER, DEFAULT_HEARTBEATS, type LeanMetaInput, type LeanMetaOutput } from "./meta.ts";

/** The module of the SeshatMeta library (lean/SeshatMeta) that the snippets import. */
export const SESHAT_META_MODULE = "SeshatMeta";

/**
 * The id of `: True` (canonical text `(C True)`). The health check asks for it, which shows that the
 * server's project has SeshatMeta, and that its canonical form is the one documented.
 */
export const TRUE_ID = "st1_d76c7ae2a56599db06b0896a06e93c37";

/** A Lean file that runs one `#seshat_*` command, and where that command is. */
export interface MetaSnippet {
  code: string;
  /** The lines of the command (1-based, inclusive): its answer is an information message there. */
  firstLine: number;
  lastLine: number;
}

/**
 * The file for one call: the header (or the whole file, for `premises`) in plain form with
 * `import SeshatMeta` added after its imports, the facts of `instances` as axioms, then the
 * command. A statement is followed by a line break, so that a line comment at its end cannot hide
 * the rest of the command.
 */
export function metaSnippet(input: LeanMetaInput): MetaSnippet {
  const parts = [withSeshatMeta(input.op === "premises" ? input.code : (input.header ?? DEFAULT_HEADER)).trimEnd(), ""];
  if (input.op === "instances") {
    // Like the statements, the facts bind no variable automatically.
    parts.push("set_option autoImplicit false", "");
    input.facts.forEach((fact, i) => {
      if (fact.statement !== undefined) parts.push(`axiom ${factConstant(i)} ${fact.statement}`, "");
    });
  }
  const before = `${parts.join("\n")}\n`;
  const command = commandOf(input);
  const firstLine = before.split("\n").length;
  return { code: `${before}${command}\n`, firstLine, lastLine: firstLine + command.split("\n").length - 1 };
}

/** The constant that stands for the fact at position `i` when it is given by a statement. */
export function factConstant(i: number): string {
  return `seshat_fact_${i}`;
}

function commandOf(input: LeanMetaInput): string {
  switch (input.op) {
    case "hash":
      return input.simp !== undefined && input.simp.length > 0
        ? `#seshat_hash ${input.statement}\n  using [${input.simp.join(", ")}]`
        : `#seshat_hash ${input.statement}`;
    case "defeq":
      return `set_option maxHeartbeats ${input.heartbeats ?? DEFAULT_HEARTBEATS} in\n#seshat_defeq ${input.statement}\n  with ${input.other}`;
    case "premises":
      return `#seshat_premises ${input.declaration}`;
    case "profile":
      return `#seshat_profile ${input.statement}`;
    case "instances":
      return `#seshat_instances ${input.statement}\n  using [${input.facts.map((f, i) => (f.statement !== undefined ? factConstant(i) : f.name)).join(", ")}]`;
  }
}

/**
 * A header in plain form (`toPlainHeader`) with `import SeshatMeta` after its last import, so that
 * the REPL takes it as part of the header; unchanged when it imports SeshatMeta already.
 */
export function withSeshatMeta(header: string): string {
  const plain = toPlainHeader(header);
  if (importsOf(plain).includes(SESHAT_META_MODULE)) return plain;
  const lines = plain === "" ? [] : plain.split("\n");
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (/^import\s/.test(line)) last = i;
    else if (line !== "") break;
  }
  lines.splice(last + 1, 0, `import ${SESHAT_META_MODULE}`);
  return lines.join("\n");
}

/**
 * The answer of the snippet's command: the one information message on the command's lines whose
 * text is a JSON object. A result that did not reach Lean is an `UnavailableError` (the registry
 * then tries the host's next implementation); an error anywhere in the file, Lean's time limit, a
 * REPL failure, or no answer is an `Error` with Lean's messages.
 */
export function readAnswer(result: LeanCheckResult, snippet: MetaSnippet): Record<string, Json> {
  if (result.status === "server_error") throw new UnavailableError(result.error ?? "the Lean server did not answer");
  if (result.status === "timeout") throw new Error(`Lean ran out of time${result.error !== undefined ? `: ${result.error}` : ""}`);
  if (result.status === "repl_error") throw new Error(`the Lean REPL failed${result.error !== undefined ? `: ${result.error}` : ""}`);
  const errors = result.messages.filter((m) => m.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((m) => describeMessage(m, snippet)).join("\n"));
  const answers: Record<string, Json>[] = [];
  for (const message of result.messages) {
    if (message.severity !== "info" || message.pos.line < snippet.firstLine || message.pos.line > snippet.lastLine) continue;
    const parsed = parseObject(message.text);
    if (parsed !== undefined) answers.push(parsed);
  }
  if (answers.length !== 1) {
    throw new Error(
      answers.length === 0
        ? `SeshatMeta gave no answer (is lean/SeshatMeta built in the server's project?)`
        : `SeshatMeta gave ${answers.length} answers to one command`,
    );
  }
  return answers[0] as Record<string, Json>;
}

function describeMessage(message: LeanMessage, snippet: MetaSnippet): string {
  const where = message.pos.line >= snippet.firstLine && message.pos.line <= snippet.lastLine ? "the command" : `line ${message.pos.line} of the file`;
  return `Lean error at ${where}: ${message.text}`;
}

function parseObject(text: string): Record<string, Json> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(trimmed) as Json;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The capability's output, from the command's answer; an `Error` when the answer is not what the command prints. */
export function outputOf(input: LeanMetaInput, answer: Record<string, Json>): LeanMetaOutput {
  switch (input.op) {
    case "hash": {
      const id = answer.id;
      if (typeof id !== "string" || !/^st1_[0-9a-f]{32}$/.test(id)) throw new Error(`SeshatMeta answered an id of another form: ${JSON.stringify(id)}`);
      return { id };
    }
    case "defeq": {
      const defeq = answer.defeq;
      if (defeq !== true && defeq !== false && defeq !== null) throw new Error(`SeshatMeta answered defeq ${JSON.stringify(defeq)}`);
      return { defeq };
    }
    case "premises":
      return { premises: strings(answer, "premises") };
    case "profile":
      return { classes: strings(answer, "classes"), instances: strings(answer, "instances") };
    case "instances": {
      const names = input.facts.map((f) => f.name);
      return { instanceOf: factNames(answer, "instanceOf", names), covers: factNames(answer, "covers", names) };
    }
  }
}

function strings(answer: Record<string, Json>, key: string): string[] {
  const value = answer[key];
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) throw new Error(`SeshatMeta answered ${key} ${JSON.stringify(value)}`);
  return value as string[];
}

function factNames(answer: Record<string, Json>, key: string, names: readonly string[]): string[] {
  const value = answer[key];
  if (!Array.isArray(value) || !value.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x < names.length)) {
    throw new Error(`SeshatMeta answered ${key} ${JSON.stringify(value)}`);
  }
  const positions = [...new Set(value as number[])].sort((a, b) => a - b);
  return positions.map((i) => names[i] as string);
}

/**
 * `lean.meta` over any `LeanChecker` whose Lean project has lean/SeshatMeta built: each call is one
 * snippet (`metaSnippet`), and its answer is read from Lean's messages (`readAnswer`). The health
 * check asks for the id of `: True` with no other import, and compares it with `TRUE_ID`.
 */
export function leanMetaImplementation(checker: HealthAwareChecker): ImplementationInstance {
  const run = async (input: LeanMetaInput, signal: AbortSignal, timeoutSec: number | undefined): Promise<LeanMetaOutput> => {
    const snippet = metaSnippet(input);
    const results = await checker.check([{ id: `meta-${input.op}`, code: snippet.code }], {
      signal,
      ...(timeoutSec !== undefined ? { timeoutSec } : {}),
    });
    const result = results[0];
    if (result === undefined) throw new UnavailableError("the Lean checker returned no result");
    return outputOf(input, readAnswer(result, snippet));
  };
  return {
    async invoke(input, context) {
      const typed = input as unknown as LeanMetaInput;
      const timeoutSec = typed.timeoutSec ?? Math.max(1, Math.floor(context.timeoutMs / 1000));
      return (await run(typed, context.signal, timeoutSec)) as unknown as Json;
    },
    async health({ signal }): Promise<HealthCheck> {
      if (checker.health !== undefined && !(await checker.health(signal))) {
        return { ok: false, detail: `${checker.implementation} does not answer its health check` };
      }
      try {
        const { id } = await run({ op: "hash", statement: ": True", header: "" }, signal, 120);
        return id === TRUE_ID
          ? { ok: true, detail: `${checker.implementation} ${checker.version}, SeshatMeta answers` }
          : { ok: false, detail: `SeshatMeta gives ${String(id)} for ": True", not ${TRUE_ID}: another canonical form` };
      } catch (error) {
        return { ok: false, detail: `SeshatMeta does not answer: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}

/**
 * The registry factory of a `lean.meta` implementation over a checker, such as `kimina-meta`: the
 * composition root passes the function that builds the checker from the implementation's settings
 * (for Kimina, `kiminaChecker` of @seshat/lean-kimina).
 */
export function leanMetaFactory(makeChecker: (context: FactoryContext) => HealthAwareChecker): ImplementationFactory {
  return (context) => leanMetaImplementation(makeChecker(context));
}

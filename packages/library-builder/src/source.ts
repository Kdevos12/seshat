import { importsOf, maskCommentsAndStrings, namespacesAt, readDeclarationHead, scanRegion, splitCommands, forbiddenTokensIn, type Command } from "@seshat/core";

/** A declaration the agent's file adds, with the text of its command. */
export interface Declaration {
  /** `theorem` or `lemma` (proofs to certify), or `def`, `abbrev`, `structure`, `inductive`, `class`, `instance` (definitions). */
  keyword: string;
  /** The full name, with the namespaces in force. Empty for an anonymous instance. */
  name: string;
  /** The name as the command writes it, inside its namespaces. */
  written: string;
  /** The command's index in the file's commands. */
  index: number;
  command: Command;
}

export interface FileScan {
  imports: string[];
  commands: Command[];
  declarations: Declaration[];
}

const PROOFS = new Set(["theorem", "lemma"]);
const DEFINITIONS = new Set(["def", "abbrev", "structure", "inductive", "class", "instance", "opaque"]);

export const isProof = (d: Declaration): boolean => PROOFS.has(d.keyword);
export const isDefinition = (d: Declaration): boolean => DEFINITIONS.has(d.keyword);

/** Cuts a Lean file into its declarations (`splitCommands` is the validator's own scanner). */
export function scanFile(text: string): FileScan {
  const commands = splitCommands(text);
  const spaces = namespacesAt(commands);
  const declarations: Declaration[] = [];
  commands.forEach((command, index) => {
    if (command.kind !== "code") return;
    const head = readDeclarationHead(command.text);
    if (head === undefined || !(PROOFS.has(head.keyword) || DEFINITIONS.has(head.keyword))) return;
    const own = head.name.replace(/^_root_\./, "");
    const rooted = head.name.startsWith("_root_.");
    const prefix = rooted ? [] : (spaces[index] ?? []);
    const name = own === "" ? "" : [...prefix, own].join(".");
    declarations.push({ keyword: head.keyword, name, written: own, index, command });
  });
  return { imports: importsOf(text), commands, declarations };
}

/** The file with its import lines blanked, for the token screen: `import` is a forbidden token elsewhere. */
function withoutImports(text: string): string {
  const lines = text.split("\n");
  let inHeader = true;
  return lines
    .map((line) => {
      if (inHeader && /^\s*(?:public\s+)?(?:meta\s+)?import\s/.test(line)) return "";
      if (inHeader && line.trim() !== "" && !/^\s*(?:module\s*|--.*)$/.test(line)) inHeader = false;
      return line;
    })
    .join("\n");
}

const HOLES = new Set(["sorry", "admit", "axiom", "native_decide", "ofReduceBool", "ofReduceNat", "trustCompiler", "skipKernelTC"]);

export interface FileScreen {
  /** Ways to skip or weaken a proof: always refused. */
  holes: string[];
  /** Code that runs while Lean elaborates, or changes the syntax; refused in a `fill`, flagged in a `port`. */
  meta: string[];
  /** Strings and «» names, unclosed comments: the scanner of the validator cannot read these exactly. */
  problems: string[];
}

/** The strict screen of a file the agent wrote, with the validator's own token list and scanner. */
export function screenFile(text: string): FileScreen {
  const scan = scanRegion(withoutImports(text));
  const tokens = forbiddenTokensIn(scan.masked);
  return { holes: tokens.filter((t) => HOLES.has(t)), meta: tokens.filter((t) => !HOLES.has(t)), problems: scan.problems };
}

/** Index of the top-level `:=` of a command (outside brackets), in the masked text; -1 when it has none. */
function assignmentOffset(masked: string): number {
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i] as string;
    if ("([{⟨⦃⟦".includes(c)) depth++;
    else if (")]}⟩⦄⟧".includes(c)) depth--;
    else if (depth <= 0 && c === ":" && masked[i + 1] === "=") return i;
  }
  return -1;
}

/**
 * The file with one theorem's proof replaced by `sorry`, or with its statement replaced by another (the spec's), so that
 * the certifier compares the candidate's theorem with a statement the agent did not write. Undefined when the command's
 * statement cannot be isolated (no top-level `:=`, as with a theorem defined by equations): the gate fails closed.
 */
export function referenceFor(text: string, declaration: Declaration, statement?: string): string | undefined {
  const command = declaration.command;
  const head = readDeclarationHead(command.text);
  if (head === undefined) return undefined;
  let replacement: string;
  if (statement !== undefined) {
    const prefix = command.text.slice(0, head.keywordOffset);
    replacement = `${prefix}theorem ${declaration.written} ${statement.trim()} := by sorry\n\n`;
  } else {
    const at = assignmentOffset(maskCommentsAndStrings(command.text));
    if (at < 0) return undefined;
    replacement = `${command.text.slice(0, at)}:= by sorry\n\n`;
  }
  const before = text.slice(0, command.start);
  const after = text.slice(command.end);
  return `${before}${replacement}${after}`;
}

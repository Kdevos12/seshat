import { forbiddenTokensIn, importsOf, maskCommentsAndStrings, namespacesAt, readDeclarationHead, scanRegion, splitCommands, type Command } from "@seshat/core";

/** A declaration the agent's file adds, with the text of its command. */
export interface Declaration {
  /** `theorem` or `lemma` (proofs to certify), or `def`, `abbrev`, `structure`, `inductive`, `class`, `instance`, `opaque` (definitions). */
  keyword: string;
  /** The full name, with the namespaces in force. Empty for an anonymous instance. */
  name: string;
  /** The name as the command writes it, inside its namespaces. */
  written: string;
  /** The command's index in the file's commands. */
  index: number;
  command: Command;
  /** How many characters of the command come before the declaration itself: `open X in`, `set_option ... in`, `attribute [..] in`. */
  prefixLength: number;
  /** Constructors of an inductive type, fields of a structure or class, by full name. */
  members: string[];
}

export interface FileScan {
  imports: string[];
  commands: Command[];
  declarations: Declaration[];
  /** The first word of every command the scanner does not recognise. A gate that cannot read a command refuses it. */
  unrecognised: string[];
}

const PROOFS = new Set(["theorem", "lemma"]);
const DEFINITIONS = new Set(["def", "abbrev", "structure", "inductive", "class", "instance", "opaque"]);
/** Declarations that add no name a statement can use. */
const HARMLESS = new Set(["example"]);
/** Commands that add no declaration. A command that is none of these and no declaration is unrecognised. */
const NEUTRAL = new Set(["namespace", "section", "end", "variable", "universe", "open", "set_option", "import", "module", "export"]);

export const isProof = (d: Declaration): boolean => PROOFS.has(d.keyword);
export const isDefinition = (d: Declaration): boolean => DEFINITIONS.has(d.keyword);

/** Length of the `open X in` / `set_option o v in` / `attribute [a] in` prefixes at the start of a (masked) command. */
const PREFIX = /^\s*(?:open\s[^\n]*?\sin|set_option\s+\S+\s+\S+\s+in|attribute\s*\[[^\]\n]*\]\s*in)(?=\s)/;
export function prefixLengthOf(masked: string): number {
  let at = 0;
  for (;;) {
    const m = PREFIX.exec(masked.slice(at));
    if (m === null) return at;
    at += m[0].length;
  }
}

const MEMBER_CHARS = "[A-Za-z_][A-Za-z0-9_']*";

/** The constructors of an inductive type or the fields of a structure or class, as the command writes them. */
function membersOf(keyword: string, masked: string): string[] {
  const found: string[] = [];
  if (keyword === "inductive") {
    for (const m of masked.matchAll(new RegExp(`^\\s*\\|\\s*(${MEMBER_CHARS})`, "gm"))) found.push(m[1] as string);
  } else if (keyword === "structure" || keyword === "class") {
    const where = masked.search(/\bwhere\b|:=/);
    const body = where < 0 ? "" : masked.slice(where);
    for (const m of body.matchAll(new RegExp(`^[ \\t]+(${MEMBER_CHARS})(?:\\s+${MEMBER_CHARS})*\\s*(?::|\\()`, "gm"))) found.push(m[1] as string);
    for (const m of body.matchAll(new RegExp(`^\\s*(${MEMBER_CHARS})\\s*::`, "gm"))) found.push(m[1] as string);
  }
  return [...new Set(found)];
}

/** Cuts a Lean file into its declarations (`splitCommands` is the validator's own scanner). */
export function scanFile(text: string): FileScan {
  const commands = splitCommands(text);
  const spaces = namespacesAt(commands);
  const declarations: Declaration[] = [];
  const unrecognised: string[] = [];
  commands.forEach((command, index) => {
    if (command.kind !== "code") return;
    const masked = maskCommentsAndStrings(command.text);
    const prefixLength = prefixLengthOf(masked);
    const rest = command.text.slice(prefixLength);
    const head = readDeclarationHead(rest);
    if (head !== undefined && (PROOFS.has(head.keyword) || DEFINITIONS.has(head.keyword))) {
      const own = head.name.replace(/^_root_\./, "");
      const prefix = head.name.startsWith("_root_.") ? [] : (spaces[index] ?? []);
      const name = own === "" ? "" : [...prefix, own].join(".");
      const members = name === "" ? [] : membersOf(head.keyword, masked.slice(prefixLength)).map((m) => `${name}.${m}`);
      declarations.push({ keyword: head.keyword, name, written: own, index, command, prefixLength, members });
      return;
    }
    if (head !== undefined && HARMLESS.has(head.keyword)) return;
    const first = /^\s*(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|public|nonrec|partial|unsafe)\s+)*([^\s]+)/.exec(masked.slice(prefixLength))?.[1] ?? "";
    // `noncomputable section` and `@[expose] public section` are sections.
    // A command that opens like a harmless one but holds a declaration further on (a multi-line `open X in`, say) is not read: refused.
    const hidesDeclaration = /\n\s*(?:@\[[^\]]*\]\s*)?(?:(?:private|protected|noncomputable|public|nonrec|partial|unsafe)\s+)*(?:theorem|lemma|def|abbrev|structure|inductive|class|instance|opaque)\b/.test(masked.slice(prefixLength));
    if (NEUTRAL.has(first) && !hidesDeclaration) return;
    unrecognised.push(first === "" ? "(empty)" : first);
  });
  return { imports: importsOf(text), commands, declarations, unrecognised };
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

/** Ways to skip, weaken or trust-compile a proof: always refused. The validator's list, and the options that reach `ofReduceBool`. */
const HOLES = new Set(["sorry", "admit", "axiom", "native_decide", "ofReduceBool", "ofReduceNat", "trustCompiler", "skipKernelTC"]);
const EXTRA_HOLES: ReadonlyArray<readonly [string, RegExp]> = [
  ["+native", /\+\s*native\b/],
  ["bv_decide", /\bbv_decide\b/],
  ["Lean.ofReduceBool", /\bofReduceBool\b|\btrustCompiler\b/],
];
/** Code that runs while Lean elaborates, reaches the machine, or changes the syntax. */
const EXTRA_META: ReadonlyArray<readonly [string, RegExp]> = [
  ["@[init]", /@\[[^\]]*\b(?:init|export|extern|implemented_by|csimp|builtin_\w+)\b/],
  ["BaseIO", /\b(?:BaseIO|EIO|System|FilePath)\b/],
];

export interface FileScreen {
  /** Ways to skip or weaken a proof: always refused. */
  holes: string[];
  /** Code that runs while Lean elaborates, or changes the syntax; refused in a `fill`, and in a `port` unless a person is named. */
  meta: string[];
  /** Strings and «» names, unclosed comments: the scanner of the validator cannot read these exactly. */
  problems: string[];
}

/** The strict screen of a file the agent wrote, with the validator's own token list and scanner, and a few tokens of its own. */
export function screenFile(text: string): FileScreen {
  const scan = scanRegion(withoutImports(text));
  const tokens = forbiddenTokensIn(scan.masked);
  const holes = tokens.filter((t) => HOLES.has(t));
  const meta = tokens.filter((t) => !HOLES.has(t));
  for (const [name, pattern] of EXTRA_HOLES) if (pattern.test(scan.masked)) holes.push(name);
  for (const [name, pattern] of EXTRA_META) if (pattern.test(scan.masked)) meta.push(name);
  return { holes: [...new Set(holes)], meta: [...new Set(meta)], problems: scan.problems };
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
 * the certifier compares the candidate's theorem with a statement the agent did not write. The `open X in` and `set_option`
 * prefixes of the command stay, so the statement is read under the same options. Undefined when the command's statement cannot be
 * isolated (no top-level `:=`, as with a theorem defined by equations): the gate fails closed.
 */
export function referenceFor(text: string, declaration: Declaration, statement?: string): string | undefined {
  const command = declaration.command;
  const body = command.text.slice(declaration.prefixLength);
  const head = readDeclarationHead(body);
  if (head === undefined) return undefined;
  let replacement: string;
  if (statement !== undefined) {
    replacement = `${command.text.slice(0, declaration.prefixLength + head.keywordOffset)}theorem ${declaration.written} ${statement.trim()} := by sorry\n\n`;
  } else {
    const at = assignmentOffset(maskCommentsAndStrings(command.text));
    if (at < 0) return undefined;
    replacement = `${command.text.slice(0, at)}:= by sorry\n\n`;
  }
  return `${text.slice(0, command.start)}${replacement}${text.slice(command.end)}`;
}

/** Names of the identifiers in Lean text, dotted names whole. */
function identifiersIn(text: string): string[] {
  return [...new Set(maskCommentsAndStrings(text).match(/[A-Za-z_][A-Za-z0-9_'.]*/g) ?? [])];
}

/**
 * Names that could shadow a name in a test lemma's statement (review I3). The statement is elaborated in the agent's file, under its
 * namespaces, so a declaration `Dom.Finset.card` inside `namespace Dom` is what `Finset.card` means there, in the reference and in the candidate alike.
 * A new declaration is refused when a dotted suffix of its full name (past the first component) is a name, or the start of one, that a test
 * lemma's statement uses, unless it is the item or test lemma the spec names. Conservative: it can refuse a harmless helper.
 */
export function shadowing(declarations: readonly { name: string }[], statements: readonly string[], allowed: ReadonlySet<string>): string[] {
  const used = new Set<string>();
  for (const s of statements) {
    for (const id of identifiersIn(s)) {
      const parts = id.split(".").filter((p) => p !== "");
      for (let i = 1; i <= parts.length; i++) used.add(parts.slice(0, i).join("."));
    }
  }
  const found: string[] = [];
  for (const d of declarations) {
    const parts = d.name.split(".");
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join(".");
      if (used.has(suffix) && !allowed.has(suffix)) {
        found.push(`${d.name} would shadow ${suffix}, which a test lemma uses`);
        break;
      }
    }
  }
  return found;
}

/**
 * Instances that add to the meaning of statements about existing types (review I2): an `instance` is refused unless its type mentions a
 * type, class or definition declared in the same build. The check is by the last component of the declared names.
 */
export function foreignInstances(scans: readonly FileScan[]): string[] {
  const own = new Set<string>();
  for (const scan of scans) for (const d of scan.declarations) if (d.keyword !== "instance" && d.keyword !== "theorem" && d.keyword !== "lemma" && d.name !== "") own.add(d.name.split(".").pop() as string);
  const found: string[] = [];
  for (const scan of scans) {
    for (const d of scan.declarations) {
      if (d.keyword !== "instance") continue;
      const masked = maskCommentsAndStrings(d.command.text.slice(d.prefixLength));
      const end = masked.search(/:=|\bwhere\b|\n\s*\|/);
      const type = masked.slice(0, end < 0 ? undefined : end).replace(/\(\s*priority\s*:=[^)]*\)/, " ");
      if (![...own].some((name) => new RegExp(`(?<![\\p{L}\\p{N}_'])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_'])`, "u").test(type))) {
        found.push(`the instance ${d.written || "(anonymous)"} mentions no type or definition of this build`);
      }
    }
  }
  return found;
}

/**
 * The screen of a file a port adds that is not a Lean source (review I5). `lakefile.lean` is code Lake runs, so it is always
 * meta. `lean-toolchain` must be one toolchain name. `lake-manifest.json` must be JSON that fetches nothing. `lakefile.toml` may
 * declare libraries only: a dependency, an executable, a script, a target or an argument for the compiler or the linker is meta.
 * Meta is refused unless a person is named. `LICENSE` and `README.md` are text and are not read.
 */
export function screenSupportFile(path: string, text: string): { meta: string[]; problems: string[] } {
  const meta: string[] = [];
  const problems: string[] = [];
  const base = path.split("/").pop() as string;
  if (base === "lakefile.lean") meta.push("lakefile.lean (code that Lake runs)");
  else if (base === "lean-toolchain") {
    if (!/^leanprover\/lean4:[A-Za-z0-9._-]+\s*$/.test(text)) problems.push(`${path} is not one toolchain name`);
  } else if (base === "lake-manifest.json") {
    try {
      const manifest = JSON.parse(text) as { packages?: unknown };
      if (Array.isArray(manifest.packages) && manifest.packages.length > 0) meta.push("lake-manifest.json (packages to fetch)");
    } catch {
      problems.push(`${path} is not JSON`);
    }
  } else if (base === "lakefile.toml") {
    const sections = new Set(["lean_lib"]);
    const keys = new Set(["name", "version", "defaultTargets", "roots", "globs", "srcDir", "libName", "keywords", "description", "homepage", "license", "readmeFile", "leanOptions", "testDriver", "lintDriver"]);
    for (const raw of text.split("\n")) {
      const line = raw.replace(/#.*$/, "").trim();
      if (line === "") continue;
      const section = /^\[\[?\s*([A-Za-z_.]+)\s*\]\]?$/.exec(line);
      if (section !== null) {
        if (!sections.has(section[1] as string)) meta.push(`lakefile.toml [[${section[1]}]]`);
        continue;
      }
      const key = /^([A-Za-z_][A-Za-z0-9_.]*)\s*=/.exec(line)?.[1];
      if (key !== undefined && !keys.has(key.split(".")[0] as string)) meta.push(`lakefile.toml key ${key}`);
      else if (key === undefined && !/^["\]\[,}{A-Za-z0-9_.\s"'-]*$/.test(line)) meta.push("lakefile.toml line it cannot read");
    }
  }
  return { meta: [...new Set(meta)], problems };
}

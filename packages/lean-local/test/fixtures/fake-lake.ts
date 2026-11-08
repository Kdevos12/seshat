/**
 * A stand-in for `lake`, which prints what the real one would print for the three calls the
 * certifier makes (documentation/certifier.md#the-process):
 *
 *   lake env lean --version
 *   lake env lean --root=DIR -o OUT.olean IN.lean  (the "object file" is a copy of the source)
 *   lake env lean --run PROGRAM request.json       (the verdict is chosen by a marker in the candidate)
 *
 * As Lean v4.27.0 does, a compile with `-o` names the module from the source's path relative to the
 * root directory (`--root`, `-R`, or else the working directory), and fails with exit code 1 when the
 * source is outside it. The module name is in the log (`module`).
 *
 * A marker is a line `-- fake: <name>` in the file. Every call is appended to the file named by
 * FAKE_LAKE_LOG, as a line of JSON.
 *
 * Some markers stand for code that a compile runs. Its reach is the directory the sandbox command
 * leaves it to write (FAKE_SANDBOX_WRITABLE, set by fixtures/fake-sandbox.ts):
 *   plant-fifo       makes request.json a named pipe there
 *   plant-dir        makes the directory `reference` there
 *   tamper-program   overwrites the file FAKE_LAKE_TAMPER (the replay program, in a test)
 *   symlink-object   makes the object file a link to the source
 *
 * A few variables stand for a state of the Lean installation:
 *   FAKE_LAKE_VERSION          what `--version` prints
 *   FAKE_LAKE_BROKEN_IMPORTS   every compile fails the way an unbuilt project does (an import error, exit 1)
 *   FAKE_LAKE_HANG_VERSION     `--version` never answers
 *   FAKE_LAKE_VERSION_DELAY_MS `--version` answers after this long
 *   FAKE_LAKE_VERSION_PIDFILE  the pid of a `--version` call is written to this file
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const log = process.env.FAKE_LAKE_LOG;

/** The arguments after `env lean`, read as Lean reads them. */
interface LeanCall {
  mode?: "--version" | "-o" | "--run";
  out?: string;
  root?: string;
  input?: string;
  /** For `--run`: the program, then its arguments. */
  run?: string[];
}
function parse(rest: readonly string[]): LeanCall {
  const call: LeanCall = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === "--version") call.mode = "--version";
    else if (arg === "-o") {
      call.mode ??= "-o";
      call.out = rest[++i] ?? "";
    } else if (arg.startsWith("--o=")) {
      call.mode ??= "-o";
      call.out = arg.slice(4);
    } else if (arg === "-R" || arg === "--root") call.root = rest[++i] ?? "";
    else if (arg.startsWith("--root=")) call.root = arg.slice(7);
    else if (arg === "--run") {
      call.mode = "--run";
      call.run = rest.slice(i + 1);
      break;
    } else if (arg.startsWith("-")) {
      process.stderr.write(`fake lake: unknown option ${arg}\n`);
      process.exit(2);
    } else call.input = arg;
  }
  return call;
}
const lean = args[0] === "env" && args[1] === "lean" ? parse(args.slice(2)) : {};

/** The module Lean names a compiled file: its path relative to the root, or undefined when it is not inside. */
function moduleOf(input: string, root: string): string | undefined {
  const path = relative(resolve(root), resolve(input));
  if (path === "" || path.startsWith("..") || isAbsolute(path)) return undefined;
  return path.replace(/\.lean$/, "").split(sep).join(".");
}
const module = lean.mode === "-o" && lean.input !== undefined ? moduleOf(lean.input, lean.root ?? process.cwd()) : undefined;

// The request of a `--run` call is in the log, since the certifier removes the file afterwards.
const request = lean.mode === "--run" ? (JSON.parse(readFileSync(lean.run?.[1] as string, "utf8")) as { reference: string; candidate: string; target: string[]; allowedAxioms: string[][] }) : undefined;
// The file a compile reads is in the log too, since the certifier removes its directory afterwards.
const compiled = lean.mode === "-o" && lean.input !== undefined && existsSync(lean.input) ? readFileSync(lean.input, "utf8") : undefined;
// The program of a `--run` call, likewise.
const program = lean.mode === "--run" && existsSync(lean.run?.[0] as string) ? readFileSync(lean.run?.[0] as string, "utf8") : undefined;
if (log !== undefined) {
  const { TMPDIR: tmpdir, HOME: home } = process.env;
  appendFileSync(
    log,
    `${JSON.stringify({ args, lean, module, cwd: process.cwd(), env: Object.keys(process.env).sort(), values: { tmpdir, home }, request, source: compiled, program })}\n`,
  );
}

const fail = (message: string, code = 2): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const markers = (text: string): Set<string> => new Set([...text.matchAll(/^-- fake: (.+)$/gm)].map((m) => (m[1] as string).trim()));

const hang = (): never => {
  setTimeout(() => undefined, 120_000);
  return undefined as never;
};

if (args[0] !== "env" || args[1] !== "lean") fail(`fake lake: unexpected call: ${args.join(" ")}`);
const mode = lean.mode;

if (mode === "--version") {
  const print = () => console.log(process.env.FAKE_LAKE_VERSION ?? "Lean (version 4.27.0, x86_64-unknown-linux-gnu, commit 0123456789ab, Release)");
  if (process.env.FAKE_LAKE_VERSION_PIDFILE !== undefined) writeFileSync(process.env.FAKE_LAKE_VERSION_PIDFILE, String(process.pid));
  if (process.env.FAKE_LAKE_HANG_VERSION === "1") hang();
  else if (process.env.FAKE_LAKE_VERSION_DELAY_MS !== undefined) setTimeout(print, Number(process.env.FAKE_LAKE_VERSION_DELAY_MS));
  else print();
} else if (mode === "-o") {
  const out = lean.out as string;
  const input = lean.input as string;
  if (module === undefined) {
    // What Lean v4.27.0 says on stderr, with exit code 1, for a source outside its root directory.
    const root = resolve(lean.root ?? process.cwd());
    fail(`input file '${input}' must be contained in root directory (${root}${sep})`, 1);
  }
  const text = readFileSync(input, "utf8");
  const m = markers(text);
  if (process.env.FAKE_LAKE_BROKEN_IMPORTS === "1") {
    // What Lean says when the project is not built, or is the wrong checkout: an error in the imports.
    console.log(`${input}:1:0: error: unknown module prefix 'FormalConjectures'`);
    console.log("");
    console.log("No directory 'FormalConjectures' or file 'FormalConjectures.olean' in the search path entries:");
    process.exit(1);
  } else if (m.has("hang-with-child")) {
    // A grandchild in the same process group: killing the group must take it too.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    writeFileSync(process.env.FAKE_LAKE_PIDFILE as string, String(child.pid));
    hang();
  } else if (m.has("hang")) {
    hang();
  } else if (m.has("crash")) {
    process.kill(process.pid, "SIGKILL");
  } else if (m.has("exit-3")) {
    process.exit(3);
  } else if (m.has("compile-error")) {
    console.log(`${input}:3:2: error: unknown identifier 'foo'`);
    console.log("  extra line of the message");
    console.log(`${input}:4:0: warning: unused variable`);
    console.log(`${input}:5:7: error: type mismatch`);
    process.exit(1);
  } else if (!m.has("no-object-file")) {
    const reach = process.env.FAKE_SANDBOX_WRITABLE as string;
    if (m.has("plant-fifo")) execFileSync("mkfifo", [join(reach, "request.json")]);
    if (m.has("plant-dir")) mkdirSync(join(reach, "reference"));
    if (m.has("tamper-program")) writeFileSync(process.env.FAKE_LAKE_TAMPER as string, "-- tampered by the candidate's compile\n");
    if (m.has("symlink-object")) symlinkSync(input, out);
    else writeFileSync(out, text);
  }
} else if (mode === "--run") {
  if (request === undefined || !existsSync(request.reference) || !existsSync(request.candidate)) fail("fake lake: an object file is missing");
  const asked = request as NonNullable<typeof request>;
  const reference = markers(readFileSync(asked.reference, "utf8"));
  const m = markers(readFileSync(asked.candidate, "utf8"));
  console.log("fake lake: replaying the module");
  const verdict = (v: string, reasons: string[], axioms: string[]) => console.log(JSON.stringify({ verdict: v, reasons, axioms }));
  if (reference.has("program-fails-on-reference")) fail(`the reference does not declare ${asked.target.join(".")}`, 1);
  else if (m.has("hang-replay")) hang();
  else if (m.has("program-crash")) fail("Stack overflow detected. Aborting.", 134);
  else if (m.has("unreadable-object")) fail("seshat-certify: failed to read file 'candidate.olean', invalid header", 1);
  else if (m.has("garbage")) console.log('{"verdict": "certified", "reasons": [');
  else if (m.has("no-verdict")) console.log("this is not json");
  else if (m.has("not-a-verdict")) console.log(JSON.stringify({ verdict: "maybe", reasons: [], axioms: [] }));
  else if (m.has("kernel-reject")) verdict("rejected", ["the kernel refused the module: (kernel) declaration type mismatch at Foo.bar"], []);
  else if (m.has("type-mismatch")) verdict("rejected", [`${asked.target.join(".")} does not state what the reference states`], ["propext"]);
  else if (m.has("extra-axioms")) {
    verdict("rejected", [`${asked.target.join(".")} depends on axioms that are not allowed: [sorryAx]`], ["propext", "sorryAx"]);
  } else if (m.has("lying-certified")) verdict("certified", [], ["propext", "sorryAx"]);
  else if (m.has("certified-with-reasons")) verdict("certified", ["something is wrong"], []);
  else if (m.has("rejected-without-reason")) verdict("rejected", [], []);
  else verdict("certified", [], ["Quot.sound", "propext", "Classical.choice"]);
} else {
  fail(`fake lake: unexpected call: ${args.join(" ")}`);
}

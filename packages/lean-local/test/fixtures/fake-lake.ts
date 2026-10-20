/**
 * A stand-in for `lake`, which prints what the real one would print for the three calls the
 * certifier makes (documentation/certifier.md#the-process):
 *
 *   lake env lean --version
 *   lake env lean -o OUT.olean IN.lean          (the "object file" is a copy of the source)
 *   lake env lean --run PROGRAM request.json    (the verdict is chosen by a marker in the candidate)
 *
 * A marker is a line `-- fake: <name>` in the file. Every call is appended to the file named by
 * FAKE_LAKE_LOG, as a line of JSON.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const log = process.env.FAKE_LAKE_LOG;
// The request of a `--run` call is in the log, since the certifier removes the file afterwards.
const request = args[2] === "--run" ? (JSON.parse(readFileSync(args[4] as string, "utf8")) as { reference: string; candidate: string; target: string; allowedAxioms: string[] }) : undefined;
if (log !== undefined) {
  appendFileSync(log, `${JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env).sort(), request })}\n`);
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
const [mode, first, second] = args.slice(2);

if (mode === "--version") {
  console.log(process.env.FAKE_LAKE_VERSION ?? "Lean (version 4.27.0, x86_64-unknown-linux-gnu, commit 0123456789ab, Release)");
} else if (mode === "-o") {
  const out = first as string;
  const input = second as string;
  const text = readFileSync(input, "utf8");
  const m = markers(text);
  if (m.has("hang-with-child")) {
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
    writeFileSync(out, text);
  }
} else if (mode === "--run") {
  if (request === undefined || !existsSync(request.reference) || !existsSync(request.candidate)) fail("fake lake: an object file is missing");
  const asked = request as NonNullable<typeof request>;
  const reference = markers(readFileSync(asked.reference, "utf8"));
  const m = markers(readFileSync(asked.candidate, "utf8"));
  console.log("fake lake: replaying the module");
  const verdict = (v: string, reasons: string[], axioms: string[]) => console.log(JSON.stringify({ verdict: v, reasons, axioms }));
  if (reference.has("program-fails-on-reference")) fail(`the reference does not declare ${asked.target}`, 1);
  else if (m.has("hang-replay")) hang();
  else if (m.has("program-crash")) fail("Stack overflow detected. Aborting.", 134);
  else if (m.has("garbage")) console.log('{"verdict": "certified", "reasons": [');
  else if (m.has("no-verdict")) console.log("this is not json");
  else if (m.has("not-a-verdict")) console.log(JSON.stringify({ verdict: "maybe", reasons: [], axioms: [] }));
  else if (m.has("kernel-reject")) verdict("rejected", ["the kernel refused the module: (kernel) declaration type mismatch at Foo.bar"], []);
  else if (m.has("type-mismatch")) verdict("rejected", [`${asked.target} does not state what the reference states`], ["propext"]);
  else if (m.has("extra-axioms")) {
    verdict("rejected", [`${asked.target} depends on axioms that are not allowed: [sorryAx]`], ["propext", "sorryAx"]);
  } else if (m.has("lying-certified")) verdict("certified", [], ["propext", "sorryAx"]);
  else if (m.has("certified-with-reasons")) verdict("certified", ["something is wrong"], []);
  else if (m.has("rejected-without-reason")) verdict("rejected", [], []);
  else verdict("certified", [], ["Quot.sound", "propext", "Classical.choice"]);
} else {
  fail(`fake lake: unexpected call: ${args.join(" ")}`);
}

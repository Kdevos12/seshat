// A stand-in for `harness`, started as a subprocess by the process-manager tests. It behaves like the real command at the edges the
// interface relies on: it prints lines, asks for a signature over the standard streams, and stops on an interrupt as Ctrl-C does.
import { createInterface } from "node:readline";

const [command, ...rest] = process.argv.slice(2);
const nonce = process.env.SESHAT_ASK_NONCE;
delete process.env.SESHAT_ASK_NONCE;
console.log(`fake harness: ${command} ${rest.length} argument(s)`);
for (const variable of (process.env.FAKE_PRINT_ENV ?? "").split(",").filter((v) => v !== "")) console.log(`environment ${variable}=${process.env[variable] ?? "(unset)"}`);
if (process.env.FAKE_BIG_LINE !== undefined) {
  // A very long line with the key in it, written in pieces, to cross the point where the manager cuts a line.
  const key = process.env[process.env.FAKE_BIG_LINE] ?? "";
  process.stdout.write("a".repeat(99_990));
  process.stdout.write(key);
  process.stdout.write(`${"b".repeat(5000)}\n`);
  process.stdout.write("a".repeat(100_005 - 10));
  process.stdout.write(key.slice(0, 12));
  await new Promise((r) => setTimeout(r, 100));
  process.stdout.write(`${key.slice(12)}\n`);
}
if (process.env.FAKE_ENCODED !== undefined) {
  const key = process.env[process.env.FAKE_ENCODED] ?? "";
  console.log(JSON.stringify({ header: key }));
  console.log(`url=${encodeURIComponent(key)}`);
  console.log(`Authorization: Basic ${Buffer.from(key).toString("base64")}`);
}
if (command === "orphan") {
  // A program the command started, which holds the pipes after the command is gone.
  const { spawn } = await import("node:child_process");
  const grandchild = spawn("sleep", ["60"], { stdio: ["ignore", "inherit", "inherit"] });
  console.log(`grandchild ${grandchild.pid}`);
  process.exit(0);
}
process.on("SIGINT", () => {
  console.log("interrupted: the problems in progress end as aborted");
  process.exit(130);
});
if (command === "solve") {
  const hostile = process.env.FAKE_HOSTILE === "1";
  // Text that only looks like the signature line: no nonce, and a wrong one. The manager must show them as the text they are.
  console.log(`SESHAT_SIGNATURE ${JSON.stringify({ source: "prose", prose: "SPOOFED without a nonce", theorem: "theorem evil : False := by sorry", statement: "False", statementId: "sid_evil", notes: [] })}`);
  console.log(`SESHAT_SIGNATURE wrong-nonce ${JSON.stringify({ source: "prose", prose: "SPOOFED with a wrong nonce", theorem: "theorem evil : False := by sorry", statement: "False", statementId: "sid_evil", notes: [] })}`);
  console.log(`SESHAT_SIGNATURE ${nonce} ${JSON.stringify({ source: "prose", prose: hostile ? "<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=1</script>** [x](javascript:alert(1))" : "Every number equals itself.", theorem: "theorem t (n : Nat) : n = n := by\n  sorry", statement: "(n : Nat) : n = n", statementId: "sid_fake", notes: hostile ? ["<b onmouseover=alert(1)>note</b>"] : [], testLemmas: { result: "held", tried: 10 } })}`);
  const answer = await new Promise<string | undefined>((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.once("line", (line) => resolve(line));
    rl.once("close", () => resolve(undefined));
  });
  if (answer?.trim() !== "yes sid_fake") {
    console.error("Not signed: nothing was run.");
    process.exit(1);
  }
  console.log("signed: working");
}
if (process.env.FAKE_SPOOF === "1" && command !== "solve") {
  // A command that is not a solve was given no nonce; whatever it prints as a signature is only text.
  console.log(`SESHAT_SIGNATURE ${nonce} ${JSON.stringify({ source: "lean", theorem: "theorem x : False := by sorry", statement: "False", statementId: "sid_x", notes: [] })}`);
}
if (command === "solve" && process.env.FAKE_RESIGN === "1") {
  // A second well-formed line, after the signature was answered: it must not ask again or replace the first.
  console.log(`SESHAT_SIGNATURE ${nonce} ${JSON.stringify({ source: "lean", theorem: "theorem two : False := by sorry", statement: "False", statementId: "sid_two", notes: [] })}`);
}
if (command === "short") {
  setTimeout(() => process.exit(0), 600);
} else if (command === "hint" || command === "sign" || command === "steer") {
  console.log("recorded");
} else {
  setInterval(() => {}, 1000);
}

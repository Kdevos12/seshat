// A stand-in for `harness`, started as a subprocess by the process-manager tests. It behaves like the real command at the edges the
// interface relies on: it prints lines, asks for a signature over the standard streams, and stops on an interrupt as Ctrl-C does.
import { createInterface } from "node:readline";

const [command, ...rest] = process.argv.slice(2);
const keyVariable = process.env.FAKE_PRINT_ENV;
console.log(`fake harness: ${command} ${rest.length} argument(s)`);
if (keyVariable !== undefined) console.log(`environment ${keyVariable}=${process.env[keyVariable] ?? "(unset)"}`);
process.on("SIGINT", () => {
  console.log("interrupted: the problems in progress end as aborted");
  process.exit(130);
});
if (command === "solve") {
  console.log(`SESHAT_SIGNATURE ${JSON.stringify({ source: "prose", prose: "Every number equals itself.", theorem: "theorem t (n : Nat) : n = n := by\n  sorry", statement: "(n : Nat) : n = n", statementId: "sid_fake", notes: [] })}`);
  const answer = await new Promise<string | undefined>((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.once("line", (line) => resolve(line));
    rl.once("close", () => resolve(undefined));
  });
  if (answer?.trim() !== "yes") {
    console.error("Not signed: nothing was run.");
    process.exit(1);
  }
  console.log("signed: working");
}
if (command === "short") {
  setTimeout(() => process.exit(0), 600);
} else if (command === "hint" || command === "sign" || command === "steer") {
  console.log("recorded");
} else {
  setInterval(() => {}, 1000);
}

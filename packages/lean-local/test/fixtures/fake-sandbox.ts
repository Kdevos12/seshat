/**
 * A stand-in for a sandbox command (`bwrap`, a container runner): it records the arguments it was
 * given, which the certifier has completed, and runs the rest of the command line after `--`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const split = args.indexOf("--");
const log = process.env.FAKE_SANDBOX_LOG;
if (log !== undefined) appendFileSync(log, `${JSON.stringify({ args: args.slice(0, split), cwd: process.cwd() })}\n`);
const [command, ...rest] = args.slice(split + 1);
const result = spawnSync(command as string, rest, { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);

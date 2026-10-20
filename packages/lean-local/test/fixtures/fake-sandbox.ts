/**
 * A stand-in for a sandbox command (`bwrap`, a container runner): it records the arguments it was
 * given, which the certifier has completed, and runs the rest of the command line after `--`. The
 * directory of its first `--bind` is the only one the command leaves to write: the program that
 * runs is told which in FAKE_SANDBOX_WRITABLE (fake-lake.ts has code that tries to write there).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const split = args.indexOf("--");
const log = process.env.FAKE_SANDBOX_LOG;
if (log !== undefined) appendFileSync(log, `${JSON.stringify({ args: args.slice(0, split), cwd: process.cwd() })}\n`);
const [command, ...rest] = args.slice(split + 1);
const bind = args.indexOf("--bind");
const writable = bind === -1 ? {} : { FAKE_SANDBOX_WRITABLE: args[bind + 1] as string };
const result = spawnSync(command as string, rest, { stdio: "inherit", env: { ...process.env, ...writable } });
process.exit(result.status ?? 1);

// Loads the repository's `.env` into the environment when the command line is started as `pnpm harness`
// (documentation/install.md#the-env-file). It runs before any other module of the command line (cli.ts
// imports it first). A variable already set in the environment wins over the file, as with Node's
// --env-file. `SESHAT_ENV_FILE=PATH` names another file, whatever started the process; a missing file is
// no error. A test that starts cli.ts with node does not go through `pnpm harness`, so the machine's
// `.env` never reaches it.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const named = process.env.SESHAT_ENV_FILE;
const path = named !== undefined && named !== ""
  ? named
  : process.env.npm_lifecycle_event === "harness"
    ? fileURLToPath(new URL("../../../.env", import.meta.url))
    : undefined;

if (path !== undefined && existsSync(path)) process.loadEnvFile(path);

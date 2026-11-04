import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceHash } from "./source-hash.ts";

writeFileSync(join(import.meta.dirname, "..", "static", "source.sha256"), `${sourceHash()}\n`);

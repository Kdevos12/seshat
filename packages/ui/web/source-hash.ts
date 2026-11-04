import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A digest of what the built front end is made from: the sources under `web/`, the package's own manifest (the pinned versions of the
 * libraries it bundles). The build writes it beside the built files (`static/source.sha256`); a test compares it with the sources, so a
 * change to the front end that was not built again fails `pnpm check`.
 */
const here = dirname(fileURLToPath(import.meta.url));

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else out.push(path);
  }
  return out.sort();
}

export function sourceHash(): string {
  const hash = createHash("sha256");
  for (const file of [...files(here), join(here, "..", "package.json")].filter((f) => !f.endsWith("source-hash.ts") && !f.endsWith("stamp.ts"))) {
    hash.update(relative(join(here, ".."), file));
    hash.update("\0");
    // The manifest counts only for what it pins, not for scripts or the description.
    if (file.endsWith("package.json")) {
      const { dependencies, devDependencies } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      hash.update(JSON.stringify({ dependencies, devDependencies }));
    } else {
      hash.update(readFileSync(file));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

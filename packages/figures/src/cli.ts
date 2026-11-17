#!/usr/bin/env node
/**
 * `pnpm figures`: writes every figure of FIGURES to documentation/images/NAME.svg.
 * `pnpm figures --check` writes nothing and fails when a file differs from its figure or a figure has a problem.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { FIGURES, IMAGES_DIR, render } from "./index.ts";

const check = process.argv.includes("--check");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let failed = false;
for (const [name, build] of Object.entries(FIGURES)) {
  if (only.length > 0 && !only.includes(name)) continue;
  const { svg, problems } = render(build);
  const path = `${IMAGES_DIR}/${name}.svg`;
  for (const p of problems) console.error(`${name}: ${p}`);
  if (problems.length > 0) failed = true;
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== svg) {
      console.error(`${name}: ${path} is not the figure's output; run pnpm figures`);
      failed = true;
    }
  } else {
    writeFileSync(path, svg);
    console.log(`wrote ${path}`);
  }
}
process.exitCode = failed ? 1 : 0;

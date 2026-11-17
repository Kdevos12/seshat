/**
 * The figures of the documentation. Each entry writes documentation/images/NAME.svg (`pnpm figures`), and a test
 * checks that the file in the repository is the figure's output, so that a figure changes only through its code.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Figure } from "./svg.ts";
import { architecture } from "./figures/architecture.ts";
import { overview } from "./figures/overview.ts";
import { trust } from "./figures/trust.ts";
import { certification } from "./figures/certification.ts";
import { journal } from "./figures/journal.ts";
import { memory } from "./figures/memory.ts";
import { tools } from "./figures/tools.ts";
import { battery } from "./figures/battery.ts";
import { graph } from "./figures/graph.ts";
import { context } from "./figures/context.ts";
import { leanEnv } from "./figures/lean-env.ts";
import { solveLoop } from "./figures/solve-loop.ts";
import { sessions } from "./figures/sessions.ts";
import { budget } from "./figures/budget.ts";
import { ladder } from "./figures/ladder.ts";
import { blueprints } from "./figures/blueprints.ts";
import { fleet } from "./figures/fleet.ts";
import { runs } from "./figures/runs.ts";
import { campaign } from "./figures/campaign.ts";
import { consortium } from "./figures/consortium.ts";
import { ablation } from "./figures/ablation.ts";

export * from "./svg.ts";

export const IMAGES_DIR = join(fileURLToPath(new URL("../../..", import.meta.url)), "documentation", "images");

/** Every figure, by the name of its file in documentation/images. */
export const FIGURES: Record<string, () => Figure> = {
  overview,
  architecture,
  trust,
  certification,
  journal,
  memory,
  tools,
  battery,
  graph,
  context,
  "lean-env": leanEnv,
  "solve-loop": solveLoop,
  sessions,
  budget,
  ladder,
  blueprints,
  fleet,
  runs,
  campaign,
  consortium,
  ablation,
};

export function render(build: () => Figure): { svg: string; problems: string[] } {
  const figure = build();
  return { svg: figure.toString(), problems: [...figure.problems] };
}

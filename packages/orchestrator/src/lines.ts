import { M10, registryCompute } from "@seshat/classical";
import { M4 } from "@seshat/context";
import { fleet } from "@seshat/fleet";
import { graphSearch, M13, M16, M8 } from "@seshat/induction";
import { M17 } from "@seshat/lean-env";
import { m2Line } from "@seshat/graph";
import { M6 } from "@seshat/guards";
import { M5 } from "@seshat/lessons";
import { M3 } from "@seshat/library";
import type { LineRegistry } from "@seshat/lines";
import { createM11 } from "@seshat/models";
import { M14 } from "@seshat/repair";
import { m12Line, m15Line, m18Line } from "@seshat/scheduler";
import { M1 } from "./m1.ts";

/**
 * M11 with the search beyond the lists of graphs (CA20), which lives in @seshat/induction, and the host's compute tool for its SAT encoders
 * (CX6, python-sat first), chosen by @seshat/classical: `@seshat/models` cannot import either. Only the options `M11.graphs` and `M11.sat` make them run.
 */
const M11 = createM11({
  graphSearch,
  compute: (problem) => registryCompute(problem.registry, { actor: "line:M11", scope: `${problem.runId}/${problem.problemId}`, needs: ["pysat"] }),
});

/**
 * The lines a run can enable, by id (documentation/lines.md). A line that is planned and not
 * implemented is not here: a run that enables it stops before it starts, and says so. The task
 * that implements a line adds it here.
 */
export const LINES: LineRegistry = { M1, M10, M11, M12: m12Line, M15: m15Line, M17, M18: m18Line, M2: m2Line, M3, M4, M6, M8, M13, M14, M16, M5, fleet };

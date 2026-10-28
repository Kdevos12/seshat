import { fleet } from "@seshat/fleet";
import { M17 } from "@seshat/lean-env";
import { m2Line } from "@seshat/graph";
import { M6 } from "@seshat/guards";
import type { LineRegistry } from "@seshat/lines";
import { M11 } from "@seshat/models";
import { m12Line } from "@seshat/scheduler";
import { M1 } from "./m1.ts";

/**
 * The lines a run can enable, by id (documentation/lines.md). A line that is planned and not
 * implemented is not here: a run that enables it stops before it starts, and says so. The task
 * that implements a line adds it here.
 */
export const LINES: LineRegistry = { M1, M11, M12: m12Line, M17, M2: m2Line, M6, fleet };

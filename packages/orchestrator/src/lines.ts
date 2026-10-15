import { fleet } from "@seshat/fleet";
import { M6 } from "@seshat/guards";
import type { LineRegistry } from "@seshat/lines";
import { M1 } from "./m1.ts";

/**
 * The lines a run can enable, by id (documentation/lines.md). A line that is planned and not
 * implemented is not here: a run that enables it stops before it starts, and says so. The task
 * that implements a line adds it here.
 */
export const LINES: LineRegistry = { M1, M6, fleet };

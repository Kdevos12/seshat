import { m2Line } from "@seshat/graph";
import type { LineRegistry } from "@seshat/lines";

/**
 * The lines a run can enable, by id (documentation/lines.md). A run that enables a line that is not
 * here stops before it starts, and says that the line is planned. The task that implements a line
 * adds it here, from its own package.
 */
export const LINES: LineRegistry = { M2: m2Line };

import type { LineRegistry } from "@seshat/lines";

/**
 * The lines a run can enable, by id (documentation/lines.md). No line is implemented yet: a run
 * that enables one stops before it starts, and says that the line is planned. The task that
 * implements a line adds it here, from its own package.
 */
export const LINES: LineRegistry = {};

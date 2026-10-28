/**
 * @seshat/fleet: the fleet policy (line `fleet`, plan §11), documented in documentation/fleet.md.
 * Beta posteriors from the journal, Thompson sampling for the next session's strategy and model,
 * adaptive width, escalation, sampled session settings, informal-first sessions, the discount and
 * exploration floor of the soft failure memory.
 */
export * from "./allocation.ts";
export * from "./beta.ts";
export * from "./choose.ts";
export * from "./dag.ts";
export * from "./discount.ts";
export * from "./escalation.ts";
export * from "./fleet.ts";
export * from "./posterior.ts";
export * from "./random.ts";
export * from "./settings.ts";
export * from "./width.ts";

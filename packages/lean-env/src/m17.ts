import { LINE_TITLES, type Line } from "@seshat/lines";

/** Version of the line; it has no behavior of its own besides naming the environment. */
export const M17_VERSION = "m17-1";

/** The environment M17 puts the run in unless its option `env` says another. */
export const M17_DEFAULT_ENV = "extended";

/**
 * Line M17, "extended environment" (plan change LC3): the run's Lean environment is the one the
 * option `env` names, in place of the host's `LEAN_ENV`. The line has no hook: the orchestrator
 * builds the run's registry for the environment, adds the extra packages' imports to the problem
 * files, records the environment's name and hash, and refuses to start unless it is resolved
 * (documentation/lean-env.md). Resuming is safe because the environment is in the run's record, and
 * a resumed run is refused in another one.
 */
export const M17: Line = {
  id: "M17",
  title: LINE_TITLES.M17,
  requires: [],
  options: { env: M17_DEFAULT_ENV },
  version: M17_VERSION,
  resume: "stateless",
  leanEnv: (options) => (typeof options.env === "string" && options.env !== "" ? options.env : M17_DEFAULT_ENV),
  hooks: {},
};

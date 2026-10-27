/**
 * The run could not start, or be resumed: its configuration, model, directory, registry or journal
 * is wrong. No event was written, and a run directory created for the run was removed.
 */
export class RunSetupError extends Error {}

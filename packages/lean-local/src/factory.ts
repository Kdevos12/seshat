import type { Json } from "@seshat/core";
import { type ImplementationFactory, type JsonSchema, leanCertifyImplementation, UnavailableError, validate } from "@seshat/registry";
import { LakeCertifier } from "./certifier.ts";

const SETTINGS: JsonSchema = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    projectDir: { type: "string" },
    program: { type: "string" },
    probe: { type: "string" },
    sandbox: { type: "array", items: { type: "string", minLength: 1 } },
    workDir: { type: "string" },
    timeoutSec: { type: "integer", minimum: 1, maximum: 3600 },
    env: { type: "object" },
  },
  required: ["command"],
  additionalProperties: false,
};

/**
 * The registry factory `lake-certify`: `lean.certify` over a pinned Lean project, with the
 * settings `command`, `args`, `projectDir`, `program`, `probe`, `sandbox`, `workDir`, `timeoutSec`
 * and `env` (an empty `projectDir`, `program`, `probe` or `workDir`, or an empty variable, is left
 * out). The Lean version the implementation is pinned to is the `lean` of the spec's environment.
 * Without a project directory the certifier cannot find the modules a file imports, so it is
 * unavailable.
 */
export function lakeCertifyFactory(): ImplementationFactory {
  return ({ spec, settings }) => {
    const problems = validate(SETTINGS, settings, "settings");
    if (problems.length > 0) throw new Error(`lake-certify: ${problems.join("; ")}`);
    const s = settings as {
      command: string;
      args?: string[];
      projectDir?: string;
      program?: string;
      probe?: string;
      sandbox?: string[];
      workDir?: string;
      timeoutSec?: number;
      env?: Record<string, Json>;
    };
    if (s.projectDir === undefined || s.projectDir === "") {
      throw new UnavailableError("lean.certify needs the Lean project of the bench: set LEAN_PROJECT_DIR");
    }
    const env = Object.fromEntries(Object.entries(s.env ?? {}).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
    const certifier = new LakeCertifier({
      projectDir: s.projectDir,
      command: s.command,
      ...(s.args !== undefined ? { args: s.args } : {}),
      ...(s.program !== undefined && s.program !== "" ? { program: s.program } : {}),
      ...(s.probe !== undefined && s.probe !== "" ? { probe: s.probe } : {}),
      ...(s.sandbox !== undefined ? { sandbox: s.sandbox } : {}),
      ...(s.workDir !== undefined && s.workDir !== "" ? { workDir: s.workDir } : {}),
      ...(s.timeoutSec !== undefined ? { timeoutSec: s.timeoutSec } : {}),
      env,
      ...(spec.environment?.lean !== undefined ? { lean: spec.environment.lean } : {}),
      implementation: spec.id,
      version: spec.version,
    });
    return leanCertifyImplementation(certifier);
  };
}

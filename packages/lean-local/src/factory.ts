import type { Json } from "@seshat/core";
import { type ImplementationFactory, type JsonSchema, leanCertifyImplementation, messageOf, UnavailableError, validate } from "@seshat/registry";
import { LakeCertifier, sandboxRequired } from "./certifier.ts";

const SETTINGS: JsonSchema = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    projectDir: { type: "string" },
    program: { type: "string" },
    probe: { type: "string" },
    sandbox: { type: "array", items: { type: "string", minLength: 1 } },
    unsandboxed: { type: "boolean" },
    workDir: { type: "string" },
    timeoutSec: { type: "integer", minimum: 1, maximum: 3600 },
    env: { type: "object" },
  },
  required: ["command"],
  additionalProperties: false,
};

/**
 * The registry factory `lake-certify`: `lean.certify` over a pinned Lean project, with the
 * settings `command`, `args`, `projectDir`, `program`, `probe`, `sandbox`, `unsandboxed`, `workDir`,
 * `timeoutSec` and `env` (an empty `projectDir`, `program`, `probe` or `workDir`, or an empty
 * variable, is left out). The Lean version the implementation is pinned to is the `lean` of the
 * spec's environment.
 *
 * It fails closed: the implementation is unavailable, with the reason, without a project directory
 * (the certifier cannot find the modules a file imports), and unless the host gives a `sandbox`
 * command or says `unsandboxed: true`, since the compile runs the candidate's code. The host
 * `server` never runs it unsandboxed.
 */
export function lakeCertifyFactory(): ImplementationFactory {
  return ({ spec, settings, host }) => {
    const problems = validate(SETTINGS, settings, "settings");
    if (problems.length > 0) throw new Error(`lake-certify: ${problems.join("; ")}`);
    const s = settings as {
      command: string;
      args?: string[];
      projectDir?: string;
      program?: string;
      probe?: string;
      sandbox?: string[];
      unsandboxed?: boolean;
      workDir?: string;
      timeoutSec?: number;
      env?: Record<string, Json>;
    };
    const unavailable: string[] = [];
    if (s.projectDir === undefined || s.projectDir === "") unavailable.push("lean.certify needs the Lean project of the bench: set LEAN_PROJECT_DIR");
    const refusal = sandboxRequired({ sandbox: s.sandbox, unsandboxed: s.unsandboxed });
    if (refusal !== undefined) unavailable.push(refusal);
    else if ((s.sandbox?.length ?? 0) === 0 && host === "server") {
      unavailable.push("the host server never runs lean.certify without a sandbox: give it a sandbox command (documentation/certifier.md#where-untrusted-code-runs)");
    }
    if (unavailable.length > 0) throw new UnavailableError(unavailable.join("; "));
    const env = Object.fromEntries(Object.entries(s.env ?? {}).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
    let certifier: LakeCertifier;
    try {
      certifier = new LakeCertifier({
        projectDir: s.projectDir as string,
        command: s.command,
        ...(s.args !== undefined ? { args: s.args } : {}),
        ...(s.program !== undefined && s.program !== "" ? { program: s.program } : {}),
        ...(s.probe !== undefined && s.probe !== "" ? { probe: s.probe } : {}),
        ...(s.sandbox !== undefined ? { sandbox: s.sandbox } : {}),
        ...(s.unsandboxed !== undefined ? { unsandboxed: s.unsandboxed } : {}),
        ...(s.workDir !== undefined && s.workDir !== "" ? { workDir: s.workDir } : {}),
        ...(s.timeoutSec !== undefined ? { timeoutSec: s.timeoutSec } : {}),
        env,
        ...(spec.environment?.lean !== undefined ? { lean: spec.environment.lean } : {}),
        implementation: spec.id,
        version: spec.version,
      });
    } catch (error) {
      // What the certifier refuses to be made with (a program that cannot be read) leaves it unavailable.
      throw new UnavailableError(messageOf(error));
    }
    return leanCertifyImplementation(certifier);
  };
}

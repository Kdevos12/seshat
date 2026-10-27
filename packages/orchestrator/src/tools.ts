import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Json, Sketch, Submission } from "@seshat/core";
import { leanLspBinding } from "@seshat/lean-lsp";
import { CapabilityError, type CapabilityManifest, type JsonSchema, messageOf, type Registry } from "@seshat/registry";

/** The name a model calls a capability by: its id with `_` for `.`, such as `compute_sage`. */
export function toolName(id: string): string {
  return id.replace(/\./g, "_");
}

/** Problems with the capabilities a run gives its provers besides `lean_check`; empty when they are fine. */
export function checkTools(registry: Registry, ids: readonly string[]): string[] {
  const problems: string[] = [];
  const names = new Set(["lean_check"]);
  for (const id of ids) {
    const capability = registry.catalog.capabilities.get(id);
    if (capability === undefined) {
      problems.push(`unknown capability ${id}`);
      continue;
    }
    if (id === "lean.check") {
      problems.push("lean.check is always given, as lean_check");
      continue;
    }
    if (capability.manifest.exposure !== "direct") problems.push(`${id} is not a direct capability (its exposure is ${capability.manifest.exposure})`);
    if (!registry.offers(id)) problems.push(`host ${registry.host.host} does not offer ${id}`);
    if (names.has(toolName(id))) problems.push(`${id}: the tool name ${toolName(id)} is taken`);
    names.add(toolName(id));
  }
  return problems;
}

/** A capability given to the provers, and the implementation that answers its calls in the run. */
export interface PinnedTool {
  capability: string;
  implementation: string;
  version: string;
}

/**
 * Pins each capability to the first of the host's implementations that answers now, so that every
 * call of a run goes to the same implementation, and none goes first to one that is down. A
 * capability none of whose implementations answers is a problem; `notes` says which ones were
 * passed over, and why.
 */
export async function pinTools(
  registry: Registry,
  ids: readonly string[],
): Promise<{ tools: PinnedTool[]; problems: string[]; notes: string[] }> {
  const tools: PinnedTool[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  for (const id of ids) {
    const health = await registry.health(id);
    const index = health.findIndex((h) => h.ok);
    const down = health.slice(0, index === -1 ? health.length : index).map((h) => `${h.implementation}: ${h.detail}`);
    const up = health[index];
    if (up === undefined) {
      problems.push(`${id} cannot be reached on host ${registry.host.host} (${down.join("; ")})`);
      continue;
    }
    tools.push({ capability: id, implementation: up.implementation, version: up.version });
    if (down.length > 0) notes.push(`${id} uses ${up.implementation}, because ${down.join("; ")}`);
  }
  return { tools, problems, notes };
}

/**
 * How a run adapts a capability's tool to the prover that uses it, for the capabilities some of
 * whose inputs belong to the harness and not to the model (the problem's sketch, for `lean.lsp`).
 * A hidden field is not in the tool's parameters, a value the model gives for it is dropped, and
 * `bind` sets it; `present` writes the answer for the model in place of one line per field.
 */
export interface ToolBinding {
  /** Top-level input fields that the harness sets. */
  readonly hidden?: readonly string[];
  /** The input of the registry call, from the arguments of the model's call. */
  bind?(params: Record<string, Json>): Record<string, Json>;
  /** The answer as the model reads it; default: `renderOutput`. */
  present?(output: Json): string;
}

/** The binding of a capability for a prover on this sketch, when it has one; `current` gives the regions the prover last checked. */
export function toolBinding(id: string, o: { sketch: Sketch; current: () => Submission }): ToolBinding | undefined {
  return id === "lean.lsp" ? leanLspBinding(o) : undefined;
}

export interface CapabilityToolOptions {
  registry: Registry;
  /** The attempt the calls belong to; also the scope of a stateful capability. */
  attemptId: string;
  actor: string;
  /** The implementation that answers, as `pinTools` chose it; otherwise the host's order applies. */
  implementation?: string;
  /** Length limit of the text a call returns to the model. */
  maxChars?: number;
  /** Inputs the harness sets and how the answer reads; see `ToolBinding`. */
  binding?: ToolBinding;
}

export interface CapabilityToolDetails {
  outcome: "ok" | CapabilityError["code"] | "error";
  toolRunId?: string;
}

const MAX_CHARS = 8000;

/**
 * A `direct` capability as a tool of one attempt's session. Its calls are tool runs of the attempt,
 * in the attempt's scope, so a stateful capability (a SageMath session) keeps its state for the
 * session and no longer; the prover releases the scope when the attempt ends. Errors go back to the
 * model as tool errors, and a capability that cannot be reached is not tried again in the session.
 */
export function capabilityTool(id: string, o: CapabilityToolOptions): AgentTool<never, CapabilityToolDetails> {
  const manifest = o.registry.capability(id).manifest;
  const name = toolName(id);
  const maxChars = o.maxChars ?? MAX_CHARS;
  let unreachable: string | undefined;
  const answer = (text: string, details: CapabilityToolDetails, isError = false): AgentToolResult<CapabilityToolDetails> => ({
    content: [{ type: "text", text: clip(text, maxChars) }],
    details,
    ...(isError ? { isError: true } : {}),
  });
  return {
    name,
    label: manifest.title,
    description: toolDescription(manifest),
    // The manifest's input schema is plain JSON Schema, which pi validates as it is.
    parameters: withoutFields(manifest.input, o.binding?.hidden ?? []) as never,
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      if (unreachable !== undefined) return answer(`Error: ${name} is unavailable in this session (${unreachable}).`, { outcome: "unavailable" }, true);
      try {
        const input = o.binding?.bind !== undefined ? o.binding.bind(params as unknown as Record<string, Json>) : (params as Json);
        const result = await o.registry.invoke(id, input, {
          attemptId: o.attemptId,
          actor: o.actor,
          ...(o.implementation !== undefined ? { implementation: o.implementation } : {}),
          ...(manifest.stateful === true ? { scope: o.attemptId } : {}),
          ...(signal !== undefined ? { signal } : {}),
        });
        return answer((o.binding?.present ?? renderOutput)(result.output), { outcome: "ok", toolRunId: result.toolRunId });
      } catch (error) {
        if (!(error instanceof CapabilityError)) return answer(`Error: the harness failed: ${messageOf(error)}`, { outcome: "error" }, true);
        const details: CapabilityToolDetails = { outcome: error.code, ...(error.toolRunId !== undefined ? { toolRunId: error.toolRunId } : {}) };
        if (error.code === "unavailable") {
          unreachable = error.message;
          return answer(`Error: ${name} cannot be reached (${error.message}). Go on without it: it stays unavailable in this session.`, details, true);
        }
        return answer(`Error: ${errorText(error)}`, details, true);
      }
    },
  };
}

/** The schema of an object without some of its properties, which also stop being required. */
function withoutFields(schema: JsonSchema, hidden: readonly string[]): JsonSchema {
  if (hidden.length === 0 || schema.properties === undefined) return schema;
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !hidden.includes(name)));
  const required = schema.required?.filter((name) => !hidden.includes(name));
  return { ...schema, properties, ...(required !== undefined ? { required } : {}) };
}

function errorText(error: CapabilityError): string {
  switch (error.code) {
    case "failed":
      return error.details[0] || "(no message)";
    case "timeout":
      return `no answer within the time limit; the call was stopped (${error.message})`;
    case "invalid_input":
      return `invalid input: ${error.details.join("; ") || error.message}`;
    case "invalid_output":
      return "the tool returned a result the harness does not accept: a fault of the harness or the tool, not of your input";
    default:
      return error.message;
  }
}

/** What the model reads about a capability: the manifest's description, when to use it, examples. */
export function toolDescription(manifest: CapabilityManifest): string {
  const lines = [`${manifest.title}. ${manifest.description.trim()}`];
  if (manifest.when.length > 0) lines.push("", "Use it for:", ...manifest.when.map((w) => `- ${w}`));
  if (manifest.whenNot.length > 0) lines.push("", "Do not use it for:", ...manifest.whenNot.map((w) => `- ${w}`));
  const examples = manifest.examples ?? [];
  if (examples.length > 0) lines.push("", "Examples:");
  for (const example of examples) {
    lines.push(`- ${example.title}: ${JSON.stringify(example.input)}${example.output !== undefined ? " returns" : ""}`);
    if (example.output !== undefined) lines.push(...renderOutput(example.output).split("\n").map((line) => `  ${line}`));
    if (example.note !== undefined) lines.push(`  ${example.note}`);
  }
  return lines.join("\n");
}

/**
 * An output as the model reads it: one line per field, without the empty ones; text of several
 * lines below its field, indented; numbers to four significant digits.
 */
export function renderOutput(output: Json): string {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return JSON.stringify(output);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(output)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "string") {
      const text = value.replace(/\n$/, "");
      if (text.includes("\n")) lines.push(`${key}:`, ...text.split("\n").map((line) => `  ${line}`));
      else lines.push(`${key}: ${text}`);
    } else if (typeof value === "number") {
      lines.push(`${key}: ${Number.isInteger(value) ? value : Number(value.toPrecision(4))}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.length === 0 ? "(no output)" : lines.join("\n");
}

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars)}\n[cut at ${chars} characters: print less, or summarize in the code]`;
}

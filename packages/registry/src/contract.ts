import type { Json } from "@math-harness/core";
import { messageOf } from "./implementation.ts";
import type { Expectation } from "./manifest.ts";
import { getPath } from "./paths.ts";
import { CapabilityError, type Registry } from "./registry.ts";
import { jsonEqual } from "./schema.ts";

export interface CaseResult {
  name: string;
  passed: boolean;
  failures: string[];
  durationMs: number;
  implementation?: string;
  version?: string;
  output?: Json;
}

export interface ContractReport {
  capability: string;
  /** The implementation asked for, or the host's choice. */
  implementation: string;
  host: string;
  passed: number;
  failed: number;
  cases: CaseResult[];
}

export interface ContractOptions {
  /** Run against this implementation instead of the host's first choice. */
  implementation?: string;
  /** Only the cases with these names. */
  only?: readonly string[];
  signal?: AbortSignal;
  onCase?: (result: CaseResult) => void;
}

/**
 * Runs a capability's contract cases (the golden inputs in its `contract.json`) through the
 * registry and checks each output against the case's expectations. A new implementation or
 * version replaces the old one only when it passes them.
 */
export async function runContract(registry: Registry, capabilityId: string, options: ContractOptions = {}): Promise<ContractReport> {
  const capability = registry.capability(capabilityId);
  const cases = capability.contract.filter((c) => options.only === undefined || options.only.includes(c.name));
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const started = performance.now();
    let result: CaseResult;
    try {
      const run = await registry.invoke(capabilityId, testCase.input, {
        actor: "contract",
        ...(options.implementation !== undefined ? { implementation: options.implementation } : {}),
        ...(testCase.timeoutMs !== undefined ? { timeoutMs: testCase.timeoutMs } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      const failures = checkExpectations(run.output, testCase.expect);
      result = {
        name: testCase.name,
        passed: failures.length === 0,
        failures,
        durationMs: run.durationMs,
        implementation: run.implementation,
        version: run.version,
        output: run.output,
      };
    } catch (error) {
      const code = error instanceof CapabilityError ? `${error.code}: ` : "";
      result = {
        name: testCase.name,
        passed: false,
        failures: [`${code}${messageOf(error)}`],
        durationMs: Math.round(performance.now() - started),
      };
    }
    results.push(result);
    options.onCase?.(result);
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    capability: capabilityId,
    implementation: options.implementation ?? registry.host.capabilities[capabilityId]?.use[0] ?? "(none)",
    host: registry.host.host,
    passed,
    failed: results.length - passed,
    cases: results,
  };
}

/** The expectations a value fails, each as a sentence naming the path; empty when all hold. */
export function checkExpectations(value: Json | undefined, expectations: readonly Expectation[], prefix = ""): string[] {
  return expectations.flatMap((expectation) => evaluate(value, expectation, prefix));
}

function evaluate(root: Json | undefined, e: Expectation, prefix: string): string[] {
  const value = getPath(root, e.path);
  const where = prefix + (e.path === "" ? "(output)" : e.path);
  if ("exists" in e) {
    return (value !== undefined) === e.exists ? [] : [`${where}: expected ${e.exists ? "a value" : "nothing"}, found ${show(value)}`];
  }
  if (value === undefined) return [`${where}: nothing there`];
  if ("equals" in e) return jsonEqual(value, e.equals) ? [] : [`${where}: expected ${show(e.equals)}, found ${show(value)}`];
  if ("matches" in e) {
    return typeof value === "string" && new RegExp(e.matches, "u").test(value)
      ? []
      : [`${where}: expected text matching /${e.matches}/, found ${show(value)}`];
  }
  if ("length" in e) {
    const length = Array.isArray(value) ? value.length : typeof value === "string" ? [...value].length : undefined;
    return length === e.length ? [] : [`${where}: expected length ${e.length}, found ${length ?? show(value)}`];
  }
  if ("atLeast" in e) {
    return typeof value === "number" && value >= e.atLeast ? [] : [`${where}: expected at least ${e.atLeast}, found ${show(value)}`];
  }
  if ("atMost" in e) {
    return typeof value === "number" && value <= e.atMost ? [] : [`${where}: expected at most ${e.atMost}, found ${show(value)}`];
  }
  if (!Array.isArray(value)) return [`${where}: expected a list, found ${show(value)}`];
  if ("some" in e) {
    if (value.some((item) => checkExpectations(item, e.some).length === 0)) return [];
    return [`${where}: no item has ${e.some.map(summarize).join(" and ")} (items: ${show(value)})`];
  }
  return value.flatMap((item, i) => checkExpectations(item, e.every, `${where}.${i}.`));
}

function summarize(e: Expectation): string {
  const { path, ...rest } = e;
  const [operator, operand] = Object.entries(rest)[0] as [string, unknown];
  return `${path === "" ? "value" : path} ${operator} ${JSON.stringify(operand)}`;
}

function show(value: unknown): string {
  if (value === undefined) return "nothing";
  const text = JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

import { hashJson, newId, type EventDataMap, type EventType, type Json } from "@math-harness/core";
import type { McpTransport } from "@earendil-works/pi-mcp";
import { describeCapability } from "./describe.ts";
import { checkHostProfile, hostProfileHash, hostProfilePath, interpolate, loadHostProfile, type HostProfile } from "./host.ts";
import {
  CatalogError,
  checkServer,
  loadCatalog,
  type Capability,
  type Catalog,
  type ImplementationSpec,
  type McpImplementationSpec,
  type McpServerSpec,
} from "./manifest.ts";
import { messageOf, UnavailableError, type HealthCheck, type ImplementationFactory, type ImplementationInstance } from "./implementation.ts";
import { defaultMcpTransport, McpImplementation } from "./mcp.ts";
import { getPath } from "./paths.ts";
import { validate } from "./schema.ts";

/** Where tool runs are recorded: a `Journal`, or anything with the same `emit`. */
export interface ToolRunSink {
  emit<K extends EventType>(type: K, data: EventDataMap[K], actor: string): unknown;
}

/** Where the inputs and outputs of tool runs are kept, by the hashes the tool runs record. */
export interface BlobSink {
  /** Stores a value as canonical JSON and returns `hashJson(value)`. */
  putJson(value: unknown): string;
}

export type McpTransportFactory = (server: McpServerSpec, spec: McpImplementationSpec) => McpTransport;

export interface RegistryOptions {
  catalog: Catalog;
  host: HostProfile;
  /** In-process implementations, by the `factory` name their manifests use. */
  factories?: Readonly<Record<string, ImplementationFactory>>;
  journal?: ToolRunSink;
  /** Keeps every input and output, so that a tool run's hashes can be read back. A `BlobStore` fits. */
  blobs?: BlobSink;
  /** Source of `${env:NAME}`. Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Builds MCP transports. Default: spawn stdio servers, connect to HTTP ones. */
  mcpTransport?: McpTransportFactory;
}

export interface InvokeOptions {
  attemptId?: string;
  /** Actor of the tool run events. Default: the capability id. */
  actor?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Use this implementation of the manifest, even one the host does not list (contract tests). */
  implementation?: string;
}

export interface InvokeResult {
  output: Json;
  toolRunId: string;
  implementation: string;
  version: string;
  durationMs: number;
}

export interface HealthEntry {
  capability: string;
  implementation: string;
  version: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

export type CapabilityErrorCode =
  | "unknown_capability"
  | "invalid_input"
  | "unavailable"
  | "timeout"
  | "aborted"
  | "failed"
  | "invalid_output";

export class CapabilityError extends Error {
  readonly code: CapabilityErrorCode;
  readonly capability: string;
  readonly implementation: string | undefined;
  readonly toolRunId: string | undefined;
  readonly details: string[];

  constructor(
    code: CapabilityErrorCode,
    capability: string,
    message: string,
    extra: { implementation?: string; toolRunId?: string; details?: string[] } = {},
  ) {
    super(message);
    this.code = code;
    this.capability = capability;
    this.implementation = extra.implementation;
    this.toolRunId = extra.toolRunId;
    this.details = extra.details ?? [];
  }
}

const HEALTH_TIMEOUT_MS = 15_000;

/**
 * The single way the harness calls a tool. Callers name a capability (`lean.check`); the host
 * profile picks the implementation; every call is checked against the manifest's schemas and
 * recorded as a tool run with the implementation's pinned version and the hashes of its input
 * and output.
 */
export class Registry {
  readonly catalog: Catalog;
  readonly host: HostProfile;
  /** Pins the catalog and the host profile; recorded in `run.started`. */
  readonly hash: string;
  private readonly factories: Readonly<Record<string, ImplementationFactory>>;
  private readonly journal: ToolRunSink | undefined;
  private readonly blobs: BlobSink | undefined;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly mcpTransport: McpTransportFactory;
  private readonly instances = new Map<string, Promise<ImplementationInstance>>();

  constructor(options: RegistryOptions) {
    this.catalog = options.catalog;
    this.host = options.host;
    this.factories = options.factories ?? {};
    this.journal = options.journal;
    this.blobs = options.blobs;
    this.env = options.env ?? process.env;
    this.mcpTransport = options.mcpTransport ?? defaultMcpTransport;
    const problems = checkHostProfile(this.host, this.catalog);
    for (const [id, binding] of Object.entries(this.host.capabilities)) {
      for (const implId of binding.use) {
        const spec = this.catalog.capabilities.get(id)?.manifest.implementations.find((i) => i.id === implId);
        if (spec?.kind === "inproc" && !Object.hasOwn(this.factories, spec.factory)) {
          problems.push(`host ${this.host.host}: ${id}/${implId} needs the factory ${spec.factory}, which is not registered`);
        }
      }
    }
    if (problems.length > 0) throw new CatalogError(problems);
    this.hash = hashJson({ catalog: this.catalog.hash, host: hostProfileHash(this.host) });
  }

  /** Loads `<catalogDir>/*` and `<configDir>/hosts/<host>.json`. */
  static load(options: Omit<RegistryOptions, "catalog" | "host"> & { catalogDir: string; configDir: string; host: string }): Registry {
    const { catalogDir, configDir, host, ...rest } = options;
    return new Registry({ ...rest, catalog: loadCatalog(catalogDir), host: loadHostProfile(hostProfilePath(configDir, host)) });
  }

  /** Every capability of the catalog, by id. */
  capabilities(): Capability[] {
    return [...this.catalog.capabilities.values()].sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1));
  }

  /** Whether the host offers the capability. */
  offers(id: string): boolean {
    return id in this.host.capabilities;
  }

  capability(id: string): Capability {
    const capability = this.catalog.capabilities.get(id);
    if (!capability) throw new CapabilityError("unknown_capability", id, `unknown capability ${id}`);
    return capability;
  }

  /** The manifest written out for a model: what it does, when to use it, its input and output. */
  describe(id: string): string {
    return describeCapability(this.capability(id).manifest);
  }

  async invoke(id: string, input: Json, options: InvokeOptions = {}): Promise<InvokeResult> {
    const capability = this.capability(id);
    const manifest = capability.manifest;
    const problems = validate(manifest.input, input, "input");
    if (problems.length > 0) {
      throw new CapabilityError("invalid_input", id, `invalid input for ${id}: ${problems.join("; ")}`, { details: problems });
    }
    const binding = this.host.capabilities[id];
    const candidates = options.implementation !== undefined ? [options.implementation] : (binding?.use ?? []);
    if (candidates.length === 0) {
      throw new CapabilityError("unavailable", id, `${id} is not offered on host ${this.host.host}`);
    }
    const timeoutMs = options.timeoutMs ?? binding?.timeoutMs ?? manifest.timeoutMs;
    const unreachable: string[] = [];
    for (const implId of candidates) {
      const spec = manifest.implementations.find((i) => i.id === implId);
      if (!spec) throw new CapabilityError("unavailable", id, `${id} has no implementation ${implId}`);
      if (options.signal?.aborted) throw new CapabilityError("aborted", id, `${id}: aborted`, { implementation: implId });
      let instance: ImplementationInstance;
      try {
        instance = await this.instance(capability, spec);
      } catch (error) {
        unreachable.push(`${implId}: ${messageOf(error)}`);
        continue;
      }
      const result = await this.run(capability, spec, instance, input, timeoutMs, options);
      if ("unavailable" in result) {
        unreachable.push(`${implId}: ${result.unavailable}`);
        continue;
      }
      return result;
    }
    throw new CapabilityError("unavailable", id, `${id}: no implementation could be reached (${unreachable.join("; ")})`, {
      details: unreachable,
    });
  }

  private async run(
    capability: Capability,
    spec: ImplementationSpec,
    instance: ImplementationInstance,
    input: Json,
    timeoutMs: number,
    options: InvokeOptions,
  ): Promise<InvokeResult | { unavailable: string }> {
    const manifest = capability.manifest;
    const toolRunId = newId("tr");
    const actor = options.actor ?? manifest.id;
    const started = performance.now();
    const inputHash = this.blobs?.putJson(input) ?? hashJson(input);
    this.journal?.emit(
      "tool_run.started",
      {
        toolRunId,
        capability: manifest.id,
        implementation: spec.id,
        version: spec.version,
        inputHash,
        timeoutMs,
        ...(options.attemptId !== undefined ? { attemptId: options.attemptId } : {}),
      },
      actor,
    );
    const finish = (outcome: EventDataMap["tool_run.finished"]["outcome"], extra: { outputHash?: string; summary?: Json } = {}) => {
      const durationMs = Math.round(performance.now() - started);
      this.journal?.emit("tool_run.finished", { toolRunId, outcome, durationMs, ...extra }, actor);
      return durationMs;
    };
    const fail = (code: CapabilityErrorCode, message: string, details: string[] = []) => {
      finish(code === "timeout" ? "timeout" : code === "aborted" ? "aborted" : "error", {
        summary: { error: code, message: message.slice(0, 500) },
      });
      return new CapabilityError(code, manifest.id, message, { implementation: spec.id, toolRunId, details });
    };

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let output: Json;
      try {
        output = await untilAborted(instance.invoke(input, { signal: controller.signal, timeoutMs }), controller.signal);
      } catch (error) {
        if (timedOut) throw fail("timeout", `${manifest.id}/${spec.id}: timed out after ${timeoutMs} ms`);
        if (controller.signal.aborted) throw fail("aborted", `${manifest.id}/${spec.id}: aborted`);
        if (error instanceof UnavailableError) {
          fail("unavailable", error.message);
          return { unavailable: error.message };
        }
        throw fail("failed", `${manifest.id}/${spec.id} failed: ${messageOf(error)}`);
      }
      const problems = validate(manifest.output, output, "output");
      if (problems.length > 0) {
        throw fail("invalid_output", `${manifest.id}/${spec.id} returned an invalid output: ${problems.join("; ")}`, problems);
      }
      const summary =
        manifest.summary === undefined
          ? undefined
          : Object.fromEntries(manifest.summary.map((path) => [path, getPath(output, path) ?? null]));
      const outputHash = this.blobs?.putJson(output) ?? hashJson(output);
      const durationMs = finish("ok", { outputHash, ...(summary !== undefined ? { summary } : {}) });
      return { output, toolRunId, implementation: spec.id, version: spec.version, durationMs };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private instance(capability: Capability, spec: ImplementationSpec): Promise<ImplementationInstance> {
    const key = `${capability.manifest.id}/${spec.id}`;
    let pending = this.instances.get(key);
    if (pending === undefined) {
      const created = this.create(capability, spec);
      this.instances.set(key, created);
      // A failed construction is not cached: the next call tries again.
      created.catch(() => {
        if (this.instances.get(key) === created) this.instances.delete(key);
      });
      pending = created;
    }
    return pending;
  }

  private async create(capability: Capability, spec: ImplementationSpec): Promise<ImplementationInstance> {
    const overrides = this.host.capabilities[capability.manifest.id]?.settings?.[spec.id] ?? {};
    const variables = { dir: capability.dir, env: this.env };
    if (spec.kind === "inproc") {
      const factory = Object.hasOwn(this.factories, spec.factory) ? this.factories[spec.factory] : undefined;
      if (factory === undefined) throw new UnavailableError(`the factory ${spec.factory} is not registered`);
      const settings = interpolate({ ...(spec.settings ?? {}), ...overrides }, variables);
      return await factory({ capability: capability.manifest, spec, settings });
    }
    // A host that changes the transport replaces the server; otherwise its fields replace the manifest's.
    const base = spec.server as unknown as Record<string, Json>;
    const merged = overrides.transport !== undefined && overrides.transport !== base.transport ? overrides : { ...base, ...overrides };
    const server = interpolate(merged, variables);
    const problems = checkServer(server);
    if (problems.length > 0) throw new UnavailableError(problems.join("; "));
    return new McpImplementation(spec, server as unknown as McpServerSpec, this.mcpTransport);
  }

  /** Reaches every implementation the host lists (or those of one capability) and asks for its health. */
  async health(id?: string): Promise<HealthEntry[]> {
    const ids = id !== undefined ? [id] : Object.keys(this.host.capabilities).sort();
    const entries: HealthEntry[] = [];
    for (const capabilityId of ids) {
      const capability = this.capability(capabilityId);
      for (const implId of this.host.capabilities[capabilityId]?.use ?? []) {
        const spec = capability.manifest.implementations.find((i) => i.id === implId) as ImplementationSpec;
        const started = performance.now();
        let check: HealthCheck;
        try {
          const instance = await this.instance(capability, spec);
          const signal = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
          check = instance.health ? await untilAborted(instance.health({ signal }), signal) : { ok: true, detail: "reachable; no health check" };
        } catch (error) {
          check = { ok: false, detail: messageOf(error) };
        }
        entries.push({
          capability: capabilityId,
          implementation: implId,
          version: spec.version,
          ok: check.ok,
          detail: check.detail ?? "",
          durationMs: Math.round(performance.now() - started),
        });
      }
    }
    return entries;
  }

  /** Closes every implementation (MCP connections, child processes). */
  async close(): Promise<void> {
    const pending = [...this.instances.values()];
    this.instances.clear();
    await Promise.all(
      pending.map(async (p) => {
        try {
          await (await p).close?.();
        } catch {
          // Construction failed or the implementation could not close: nothing left to release.
        }
      }),
    );
  }
}

/** Settles like `promise`, or rejects as soon as `signal` aborts, whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

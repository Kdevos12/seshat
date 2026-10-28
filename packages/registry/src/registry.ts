import { hashJson, newId, type EventDataMap, type EventType, type Json } from "@seshat/core";
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
import {
  type CapabilityErrorCode,
  messageOf,
  UnavailableError,
  type HealthCheck,
  type ImplementationFactory,
  type ImplementationInstance,
} from "./implementation.ts";
import { defaultMcpTransport, McpImplementation, McpToolError } from "./mcp.ts";
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

/**
 * The Lean environment a registry's tool runs belong to (documentation/lean-env.md): its name, its
 * hash when it is resolved on this machine, and where its project is. `@seshat/lean-env` makes it
 * (`lookupEnvironment`, the same shape); the registry only records it, so a run is pinned to one
 * environment from its start to its end: the pin is read when the registry is built and never again.
 */
export interface LeanEnvPin {
  name: string;
  /** The environment hash; null when the environment is not resolved. */
  hash: string | null;
  /** The environment's project directory. */
  dir?: string;
  status?: "resolved" | "unresolved" | "stale" | "unknown";
  /** Why the environment is not resolved, and what to do. */
  detail?: string;
  /** Whether `harness lean-env build` finished for this hash. */
  built?: boolean;
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
  /**
   * The Lean environment of the host. The implementations whose manifest `environment` has a `lean`
   * entry record its hash in their version (`versionOf`), so that every tool run says which
   * environment it ran in.
   */
  leanEnv?: LeanEnvPin;
}

export interface InvokeOptions {
  attemptId?: string;
  /** Required by a stateful capability: calls with the same scope share state. See `release`. */
  scope?: string;
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
  /** Set when the host's profile marks the capability `optional`: a failure of it is a warning. */
  optional?: true;
}

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
/** Past a tool's own time limit (`timeoutField`), the time it gets to stop and say so. */
export const TOOL_TIMEOUT_MARGIN_MS = 15_000;
const RELEASE_TIMEOUT_MS = 10_000;

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
  /** The Lean environment the registry was built for, if the host names one. Fixed for the registry's life. */
  readonly leanEnv: LeanEnvPin | undefined;
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
    this.leanEnv = options.leanEnv === undefined ? undefined : { ...options.leanEnv };
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

  /**
   * The version a tool run of this implementation records: the manifest's pinned version, and, for an
   * implementation whose results depend on Lean (its manifest `environment` has `lean`) in a registry
   * with a resolved Lean environment, `+env:<name>@<first 12 digits of the environment hash>`. The
   * hash is in the version, so two tool runs differ in version exactly when their environments do.
   */
  versionOf(spec: ImplementationSpec): string {
    const pin = this.leanEnv;
    if (pin === undefined || pin.hash === null || spec.environment?.lean === undefined) return spec.version;
    return `${spec.version}+env:${pin.name}@${pin.hash.slice(0, 12)}`;
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
    if (manifest.stateful === true && options.scope === undefined) {
      throw new CapabilityError("invalid_input", id, `${id} keeps state between calls, so a call needs a scope`);
    }
    const binding = this.host.capabilities[id];
    const candidates = options.implementation !== undefined ? [options.implementation] : (binding?.use ?? []);
    if (candidates.length === 0) {
      throw new CapabilityError("unavailable", id, `${id} is not offered on host ${this.host.host}`);
    }
    const own = manifest.timeoutField !== undefined ? (input as Record<string, Json>)[manifest.timeoutField] : undefined;
    const timeoutMs =
      options.timeoutMs ??
      (typeof own === "number" ? Math.ceil(own * 1000) + TOOL_TIMEOUT_MARGIN_MS : (binding?.timeoutMs ?? manifest.timeoutMs));
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
        version: this.versionOf(spec),
        inputHash,
        timeoutMs,
        ...(options.attemptId !== undefined ? { attemptId: options.attemptId } : {}),
        ...(manifest.stateful === true && options.scope !== undefined ? { scope: options.scope } : {}),
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
        const context = { signal: controller.signal, timeoutMs, ...(manifest.stateful === true ? { scope: options.scope as string } : {}) };
        output = await untilAborted(instance.invoke(input, context), controller.signal);
      } catch (error) {
        if (timedOut) throw fail("timeout", `${manifest.id}/${spec.id}: timed out after ${timeoutMs} ms`);
        if (controller.signal.aborted) throw fail("aborted", `${manifest.id}/${spec.id}: aborted`);
        if (error instanceof UnavailableError) {
          fail("unavailable", error.message);
          return { unavailable: error.message };
        }
        // `details` holds what the implementation said, for callers that show it without the prefix.
        const said = error instanceof McpToolError ? error.toolMessage : messageOf(error);
        throw fail("failed", `${manifest.id}/${spec.id} failed: ${messageOf(error)}`, [said]);
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
      return { output, toolRunId, implementation: spec.id, version: this.versionOf(spec), durationMs };
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
      return await factory({ capability: capability.manifest, spec, settings, host: this.host.host });
    }
    // A host that changes the transport replaces the server; otherwise its fields replace the manifest's.
    const base = spec.server as unknown as Record<string, Json>;
    const merged = overrides.transport !== undefined && overrides.transport !== base.transport ? overrides : { ...base, ...overrides };
    const server = interpolate(merged, variables);
    const problems = checkServer(server);
    if (problems.length > 0) throw new UnavailableError(problems.join("; "));
    return new McpImplementation(spec, server as unknown as McpServerSpec, this.mcpTransport);
  }

  /**
   * Whether the host can create an implementation of the capability at all, without calling any: an
   * in-process factory refuses a configuration it cannot work with (a missing project, no sandbox).
   * `ok` with the first implementation that was created; otherwise `detail` has every reason, in the
   * host's order. That an implementation exists says nothing of its health (`health`).
   */
  async usable(id: string): Promise<{ ok: boolean; detail: string }> {
    const capability = this.capability(id);
    const reasons: string[] = [];
    for (const implId of this.host.capabilities[id]?.use ?? []) {
      const spec = capability.manifest.implementations.find((i) => i.id === implId) as ImplementationSpec;
      try {
        await this.instance(capability, spec);
        return { ok: true, detail: implId };
      } catch (error) {
        reasons.push(`${implId}: ${messageOf(error)}`);
      }
    }
    return { ok: false, detail: reasons.length > 0 ? reasons.join("; ") : `${id} is not offered on host ${this.host.host}` };
  }

  /** Reaches every implementation the host lists (or those of one capability) and asks for its health. */
  async health(id?: string): Promise<HealthEntry[]> {
    const ids = id !== undefined ? [id] : Object.keys(this.host.capabilities).sort();
    const entries: HealthEntry[] = [];
    for (const capabilityId of ids) {
      const capability = this.capability(capabilityId);
      const optional = this.host.capabilities[capabilityId]?.optional === true;
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
          version: this.versionOf(spec),
          ok: check.ok,
          detail: check.detail ?? "",
          durationMs: Math.round(performance.now() - started),
          ...(optional ? { optional: true as const } : {}),
        });
      }
    }
    return entries;
  }

  /**
   * Ends a scope of the stateful capabilities: each implementation called with it drops its state
   * (a computer algebra session, its variables, its memory). Best effort: an implementation that
   * cannot be reached has lost that state already.
   */
  async release(scope: string): Promise<void> {
    const signal = AbortSignal.timeout(RELEASE_TIMEOUT_MS);
    await Promise.all(
      [...this.instances.values()].map(async (pending) => {
        try {
          await untilAborted((await pending).release?.(scope, { signal }) ?? Promise.resolve(), signal);
        } catch {
          // The implementation is gone or does not answer: its state went with it, or it expires on its own.
        }
      }),
    );
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

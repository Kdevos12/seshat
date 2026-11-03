import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { BlobStore, Journal } from "@seshat/core";
import { type Definition, MemoryStore, type ReviewBy } from "@seshat/memory";

/**
 * The registry of the library's definitions (plan change LC5, review I1): a journal of its own, `library/registry` by default, that
 * `harness library build` adds the definitions of every accepted build to, `harness library review|deprecate` changes, and a run
 * reads when it starts. A run copies the definitions into its own journal as its first memory, so `ensureClaim` of that run refuses
 * a statement over a definition nobody reviewed, and the run replays without the registry.
 */
export const DEFAULT_LIBRARY_REGISTRY = "library/registry";

/** Opens the registry for writing (it is made when it does not exist). The caller closes the journal. */
export function openDefinitionRegistry(dir: string = DEFAULT_LIBRARY_REGISTRY): { memory: MemoryStore; journal: Journal } {
  const path = resolve(dir);
  const journal = Journal.open(path, "library_registry");
  return { journal, memory: new MemoryStore({ journal, blobs: new BlobStore(join(path, "blobs")), actor: "orchestrator" }) };
}

/** Whether the directory holds a registry. */
export const registryExists = (dir: string = DEFAULT_LIBRARY_REGISTRY): boolean => existsSync(join(resolve(dir), "journal.jsonl"));

/** The registry's definitions, current record of each name, in the order they were first recorded. */
export function registryDefinitions(dir: string = DEFAULT_LIBRARY_REGISTRY): Definition[] {
  if (!registryExists(dir)) return [];
  const { memory, journal } = openDefinitionRegistry(dir);
  try {
    const names = [...new Set(memory.definitions().map((d) => d.name))];
    return names.map((name) => memory.definition(name) as Definition);
  } finally {
    journal.close();
  }
}

/**
 * Copies definitions into a run's store with the status they have: unreviewed, reviewed (with the signature they were reviewed by) or
 * deprecated. The run's store is the root store, which is the only one that records definitions. Returns the names copied.
 */
export function seedDefinitions(memory: MemoryStore, definitions: readonly Definition[]): string[] {
  const copied: string[] = [];
  for (const d of definitions) {
    memory.recordDefinition({ name: d.name, keyword: d.keyword, ...(d.module !== undefined ? { module: d.module } : {}), buildId: d.buildId, testLemmas: d.testLemmas, ...(d.envHash !== undefined ? { envHash: d.envHash } : {}) });
    if (d.status === "reviewed" && d.review !== undefined) memory.reviewDefinition(d.name, { by: d.review.by, note: `carried from the library registry` });
    if (d.status === "deprecated") memory.deprecateDefinition(d.name, { reason: d.deprecated?.reason ?? "deprecated in the library registry", ...(d.deprecated?.envHash !== undefined ? { envHash: d.deprecated.envHash } : {}) });
    copied.push(d.name);
  }
  return copied;
}

export interface RegistryIo {
  registry?: string | undefined;
  print: (line: string) => void;
}

/** `harness library definitions [--registry DIR]`. */
export function libraryDefinitionsCommand(io: RegistryIo): number {
  const all = registryDefinitions(io.registry);
  if (all.length === 0) io.print("no definition in the registry");
  for (const d of all) io.print(`${d.status.padEnd(10)} ${d.name}  (${d.keyword}, ${d.module ?? "?"}, build ${d.buildId})`);
  return 0;
}

/** `harness library review NAME --as PERSON [--note TEXT]`: a person signs a definition as faithful. */
export function libraryReviewCommand(name: string, io: RegistryIo & { as: string | undefined; note?: string | undefined }): number {
  if (io.as === undefined || io.as.trim() === "") throw new Error("library review needs --as NAME: a definition is reviewed by a person");
  const { memory, journal } = openDefinitionRegistry(io.registry);
  try {
    const by: ReviewBy = { kind: "human", name: io.as.trim(), ...(io.note !== undefined ? { note: io.note } : {}) };
    const d = memory.reviewDefinition(name, { by, ...(io.note !== undefined ? { note: io.note } : {}) });
    io.print(`${d.name} is reviewed by ${io.as.trim()}: a claim statement may use it`);
    return 0;
  } finally {
    journal.close();
  }
}

/** `harness library deprecate NAME --reason TEXT [--as PERSON]`: a definition found wrong is dropped; its text is never edited. */
export function libraryDeprecateCommand(name: string, io: RegistryIo & { reason: string | undefined; as?: string | undefined }): number {
  if (io.reason === undefined || io.reason.trim() === "") throw new Error("library deprecate needs --reason TEXT");
  const { memory, journal } = openDefinitionRegistry(io.registry);
  try {
    const d = memory.deprecateDefinition(name, { reason: io.reason, ...(io.as !== undefined ? { by: io.as } : {}) });
    io.print(`${d.name} is deprecated: no new claim statement may use it`);
    return 0;
  } finally {
    journal.close();
  }
}

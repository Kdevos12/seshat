import { installedPacks, installPack, loadCatalog, loadPack, missingRequirements, PackError, PackStoreError, removePack } from "@seshat/registry";
import { packsDirectory, REPO_ROOT } from "./implementations.ts";
import { RunSetupError } from "./setup-error.ts";

/**
 * `harness add|packs|remove` (documentation/packs.md): the installable packs of the registry. Installing validates
 * and copies; it never runs a program of the pack, and a pack can never write a claim's status.
 */
export interface PacksIo {
  /** The pack directory. Default: `SESHAT_PACKS_DIR`, then `packs/` of this repository. */
  dir?: string | undefined;
  /** The repository's own catalog, whose ids a pack cannot take. Default: `capabilities/` of this repository. */
  catalogDir?: string | undefined;
  out: (line: string) => void;
}

export function addCommand(source: string, o: PacksIo & { allowPrograms?: boolean | undefined; replace?: boolean | undefined }): number {
  const dir = packsDirectory(o.dir);
  const reserved = new Set(loadCatalog(o.catalogDir ?? `${REPO_ROOT}capabilities`).capabilities.keys());
  try {
    const { pack, replaced } = installPack(dir, source, { reserved, allowPrograms: o.allowPrograms === true, replace: o.replace === true });
    const m = pack.manifest;
    if (replaced !== undefined) o.out(`replaced ${replaced.name} ${replaced.version}`);
    o.out(`installed ${m.name} ${m.version} (trust ${m.trust}, hash ${pack.hash.slice(0, 12)}) in ${pack.dir}`);
    o.out(`  tools (level 2, found through tool search): ${pack.capabilities.map((c) => c.manifest.id).join(", ") || "none"}`);
    if ((m.level1 ?? []).length > 0) o.out(`  asks for level 1: ${(m.level1 ?? []).join(", ")}; honoured from the next session`);
    o.out(`  environment variables its tools may read: ${(m.requires?.env ?? []).join(", ") || "none"}`);
    o.out(`  skills (listed by name; at most 3 are loaded in full): ${pack.skills.map((s) => s.name).join(", ") || "none"}`);
    for (const missing of missingRequirements(pack)) o.out(`  warning: missing ${missing}`);
    o.out("  the pack's tests were checked as written; none was run (harness contract ID runs one against a host)");
    return 0;
  } catch (error) {
    if (error instanceof PackError) throw new RunSetupError(error.message, { cause: error });
    if (error instanceof PackStoreError) throw new RunSetupError(error.message, { cause: error });
    throw error;
  }
}

export function packsCommand(o: PacksIo): number {
  const dir = packsDirectory(o.dir);
  const packs = installedPacks(dir);
  if (packs.length === 0) o.out("No pack is installed.");
  for (const p of packs) {
    o.out(`${p.name} ${p.version}  trust ${p.trust}  hash ${p.hash.slice(0, 12)}${p.intact ? "" : "  CHANGED ON DISK: remove and add it again"}`);
    o.out(`  tools: ${p.capabilities.join(", ") || "none"}; skills: ${p.skills.join(", ") || "none"}`);
    for (const program of p.programs) o.out(`  runs when called: ${program}`);
    if (p.intact) {
      for (const missing of missingRequirements(loadPack(p.dir))) o.out(`  warning: missing ${missing}`);
    }
  }
  return 0;
}

export function removeCommand(name: string, o: PacksIo): number {
  try {
    const removed = removePack(packsDirectory(o.dir), name);
    o.out(`removed ${removed.name} ${removed.version}; the journal keeps the install (hash ${removed.hash.slice(0, 12)})`);
    return 0;
  } catch (error) {
    if (error instanceof PackStoreError) throw new RunSetupError(error.message, { cause: error });
    throw error;
  }
}

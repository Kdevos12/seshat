import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addManifest, FAKE_SERVER, tempDir } from "./helpers.ts";

export const PACK_CASE = { name: "small", input: { a: 1, b: 2 }, expect: [{ path: "sum", equals: 3 }] };

/** The tool of the test pack: `pack_adder.padd`, served by the test MCP server (a program of the pack, started only when called). */
export function packCapability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = addManifest({ id: "pack_adder.padd", title: "Add, from a pack" });
  const mcp = (base.implementations as Array<Record<string, unknown>>).find((i) => i.kind === "mcp");
  return { ...base, implementations: [mcp], ...overrides };
}

export interface TestPack {
  manifest?: Record<string, unknown>;
  /** Capability manifests by id; the default is one tool. `null` for none. */
  capabilities?: Record<string, Record<string, unknown>> | null;
  contract?: (id: string) => unknown;
  skills?: Record<string, string>;
  /** Other files, by relative path. */
  files?: Record<string, string>;
}

/** Writes a pack directory and returns it. */
export function writePack(pack: TestPack = {}, root = tempDir("mh-pack-")): string {
  const capabilities = pack.capabilities === null ? {} : (pack.capabilities ?? { "pack_adder.padd": packCapability() });
  const skills = pack.skills ?? { "adding.md": "# Adding\nUse the tool to add.\n" };
  const manifest = {
    name: "adder",
    version: "1.0.0",
    description: "Adds numbers.",
    trust: "computed",
    writesClaimStatus: false,
    capabilities: Object.keys(capabilities),
    skills: Object.keys(skills).map((file) => ({ name: file.replace(/\.md$/, ""), description: `About ${file}`, file: `skills/${file}` })),
    ...pack.manifest,
  };
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("pack.json", JSON.stringify(manifest, null, 1));
  for (const [id, m] of Object.entries(capabilities)) {
    write(`capabilities/${id}/manifest.json`, JSON.stringify(m, null, 1));
    write(`capabilities/${id}/contract.json`, JSON.stringify(pack.contract?.(id) ?? { capability: id, cases: [PACK_CASE] }, null, 1));
  }
  for (const [file, text] of Object.entries(skills)) write(`skills/${file}`, text);
  for (const [path, text] of Object.entries(pack.files ?? {})) write(path, text);
  return root;
}

export { FAKE_SERVER };

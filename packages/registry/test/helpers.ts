import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(prefix = "mh-registry-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface CapabilityFiles {
  manifest: unknown;
  contract?: unknown;
  /** Other files of the capability's directory, by relative path. */
  files?: Record<string, string>;
}

/** Writes a catalog directory: one subdirectory per capability. */
export function writeCatalog(capabilities: Record<string, CapabilityFiles>, root = tempDir()): string {
  for (const [name, content] of Object.entries(capabilities)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(content.manifest, null, 1));
    if (content.contract !== undefined) writeFileSync(join(dir, "contract.json"), JSON.stringify(content.contract, null, 1));
    for (const [path, text] of Object.entries(content.files ?? {})) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }
  return root;
}

export const FAKE_SERVER = new URL("./fixtures/fake-mcp-server.ts", import.meta.url).pathname;

/** A toy capability with in-process and MCP implementations. */
export function addManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "math.add",
    version: 1,
    title: "Add two numbers",
    description: "Adds a and b and returns their sum.",
    when: ["adding two numbers"],
    whenNot: ["multiplying"],
    exposure: "deferred",
    input: {
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "number", description: "The first term" }, b: { type: "number" } },
      additionalProperties: false,
    },
    output: { type: "object", required: ["sum"], properties: { sum: { type: "number" } } },
    timeoutMs: 2000,
    summary: ["sum"],
    examples: [{ title: "two and two", input: { a: 2, b: 2 }, output: { sum: 4 } }],
    implementations: [
      { id: "js", version: "1", kind: "inproc", factory: "js-add" },
      { id: "backup", version: "2", kind: "inproc", factory: "js-add-backup", settings: { offset: 0 } },
      {
        id: "fake-mcp",
        version: "1.0.0",
        kind: "mcp",
        tool: "add",
        server: { transport: "stdio", command: process.execPath, args: ["--disable-warning=ExperimentalWarning", FAKE_SERVER, "--version", "1.0.0"] },
      },
    ],
    ...overrides,
  };
}

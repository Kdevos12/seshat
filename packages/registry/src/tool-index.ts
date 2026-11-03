import type { Registry } from "./registry.ts";

/** One tool of level 2, as `tool_search` and `codemode` list it. */
export interface ToolIndexEntry {
  id: string;
  title: string;
  description: string;
  when: string[];
  /** The pack that adds it; absent for the repository's own deferred capabilities. */
  pack?: string;
}

/**
 * The level-2 tools (documentation/capabilities.md#exposure): every `deferred` capability the host
 * offers, the repository's own and those of installed packs. A pack's tool is never in the level-1
 * declared set, which would change the prompt prefix; it is found here, on demand.
 */
export function toolIndex(registry: Registry): ToolIndexEntry[] {
  return registry
    .capabilities()
    .filter((c) => c.manifest.exposure === "deferred" && registry.offers(c.manifest.id))
    .map((c) => {
      const pack = registry.packOf(c.manifest.id)?.manifest.name;
      return {
        id: c.manifest.id,
        title: c.manifest.title,
        description: c.manifest.description,
        when: c.manifest.when,
        ...(pack !== undefined ? { pack } : {}),
      };
    });
}

/** The tools of the index that match a query, best first: a plain count of the words found in the id, title, description and `when`. */
export function searchTools(registry: Registry, query: string, limit = 5): ToolIndexEntry[] {
  const words = query.toLowerCase().split(/[^a-z0-9_.]+/).filter((w) => w.length > 1);
  if (words.length === 0) return [];
  return toolIndex(registry)
    .map((entry) => {
      const text = `${entry.id} ${entry.title} ${entry.description} ${entry.when.join(" ")}`.toLowerCase();
      return { entry, score: words.filter((w) => text.includes(w)).length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1))
    .slice(0, limit)
    .map((r) => r.entry);
}

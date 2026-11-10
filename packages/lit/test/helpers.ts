import type { HostProfile } from "@seshat/registry";

/** A host whose four remote backends are all at `url` (the fake serves each on its own path). */
export function hostAt(url: string, extra: Record<string, unknown> = {}): HostProfile {
  const backend = { baseUrl: url, allowedHosts: ["127.0.0.1"] };
  return {
    host: "test",
    capabilities: {
      "lit.search": { use: ["sources"], settings: { sources: { minIntervalMs: 0, backends: { openalex: backend, arxiv: backend, "semantic-scholar": backend, zbmath: backend }, ...extra } } },
    },
  } as unknown as HostProfile;
}


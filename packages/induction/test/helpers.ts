import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, Journal, type ProvenanceContext } from "@seshat/core";
import { type Llm, type LlmRequest, withJson } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";

const context: ProvenanceContext = { modelId: "faux/test", promptVersion: "m8-1", mathlibRev: "rev", harnessVersion: "h", budgetClass: "medium" };

export function openMemory(actor = "line:M8"): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "ind-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")), provenance: context }).withActor(actor);
}

/** An Llm that answers each call with the next script entry (a JSON value or a function of the request), and records the requests. */
export function scriptedLlm(script: Array<unknown | ((request: LlmRequest) => unknown)>): Llm & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let n = 0;
  const complete: Llm["complete"] = async (request) => {
    requests.push(request);
    const entry = script[Math.min(n, script.length - 1)];
    n++;
    const value = typeof entry === "function" ? (entry as (r: LlmRequest) => unknown)(request) : entry;
    return { text: typeof value === "string" ? value : JSON.stringify(value), cost: { usd: 0.001, inputTokens: 10, outputTokens: 10 }, model: "faux/test", modelCallId: `mc_${n}` };
  };
  return Object.assign(withJson(complete), { requests });
}

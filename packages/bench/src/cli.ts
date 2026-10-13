#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildIndex, DISCRETE, writeIndex } from "./bench.ts";
import { scanCheckout } from "./formal-conjectures.ts";

const usage = `usage:
  harness-bench build --checkout DIR --id BENCH_ID --out FILE [--ams 5,6,8,11,20] [--include-proof-in-file]
  harness-bench stats --checkout DIR`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    checkout: { type: "string" },
    id: { type: "string" },
    out: { type: "string" },
    ams: { type: "string" },
    "include-proof-in-file": { type: "boolean", default: false },
  },
});

const command = positionals[0];
if (!values.checkout || (command !== "build" && command !== "stats")) {
  console.error(usage);
  process.exit(2);
}

if (command === "stats") {
  const { problems, errors } = scanCheckout(values.checkout);
  const count = (key: (p: (typeof problems)[number]) => string) => {
    const counts = new Map<string, number>();
    for (const p of problems) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
    return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
  };
  const solved = problems.filter((p) => p.category === "research solved");
  console.log(JSON.stringify({
    theorems: problems.length,
    unreadable: errors.length,
    byCategory: count((p) => p.category),
    researchSolved: {
      total: solved.length,
      proofInFile: solved.filter((p) => p.proofInFile).length,
      unprovedBefore: solved.filter((p) => p.unprovedBefore.length > 0).length,
      formalProof: Object.fromEntries(["lean4", "formal_conjectures", "other_system"].map((k) => [k, solved.filter((p) => p.formalProof?.kind === k).length])),
    },
  }, null, 2));
  for (const error of errors.slice(0, 20)) console.error(`unreadable: ${error}`);
} else {
  if (!values.id || !values.out) {
    console.error(usage);
    process.exit(2);
  }
  const filter = {
    ...DISCRETE,
    ...(values.ams ? { ams: values.ams.split(",").map(Number) } : {}),
    includeProofInFile: values["include-proof-in-file"] ?? false,
  };
  const index = buildIndex(values.checkout, values.id, filter);
  writeIndex(values.out, index);
  console.log(`${index.benchId}: ${index.counts.selected} problems of ${index.counts.theorems} theorems (${index.source.repo}@${index.source.tag ?? index.source.rev.slice(0, 12)}, ${index.source.lean}) -> ${values.out}`);
  for (const error of index.errors.slice(0, 20)) console.error(`unreadable: ${error}`);
}

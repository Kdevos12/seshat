#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { readEvents } from "@seshat/core";
import { type Annotations, suggestTags, validateAnnotations } from "./annotations.ts";
import { buildIndex, DISCRETE, readIndex, sequencesOf, writeIndex } from "./bench.ts";
import { buildGraded, lakeAdmitter, writeGraded } from "./graded.ts";
import { convertRows, licenceNote, readCache, closedByStep } from "./ext.ts";
import { scanCheckout } from "./formal-conjectures.ts";

const usage = `usage:
  harness-bench build --checkout DIR --id BENCH_ID --out FILE [--ams 5,6,8,11,20] [--include-proof-in-file] [--annotations FILE]
  harness-bench stats --checkout DIR
  harness-bench sequences --index FILE
  harness-bench tags (validate|suggest) --index FILE [--annotations FILE]
  harness-bench graded --fc DIR --putnam DIR --seed S --out FILE [--lean-project DIR] [--size-b 100] [--size-c 70]
  harness-bench ext convert (--cache DIR | --rows FILE) [--out FILE]
  harness-bench ext steps RUN_DIR`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    checkout: { type: "string" },
    id: { type: "string" },
    out: { type: "string" },
    ams: { type: "string" },
    "include-proof-in-file": { type: "boolean", default: false },
    index: { type: "string" },
    annotations: { type: "string" },
    cache: { type: "string" },
    rows: { type: "string" },
    fc: { type: "string" },
    putnam: { type: "string" },
    seed: { type: "string" },
    "lean-project": { type: "string" },
    "size-b": { type: "string" },
    "size-c": { type: "string" },
  },
});

const command = positionals[0];

if (command === "sequences" || command === "tags" || command === "ext" || command === "graded") {
  process.exitCode = other();
  process.exit();
}

/** The commands that read an index, an annotations file or a local cache instead of a checkout. */
function other(): number {
  try {
    if (command === "sequences") {
      if (!values.index) throw new Error("sequences needs --index FILE");
      for (const s of sequencesOf(readIndex(values.index))) console.log(`${s.id}\t${s.kind}\t${s.problems.length}`);
      return 0;
    }
    if (command === "tags") {
      const sub = positionals[1];
      if (!values.index || (sub !== "validate" && sub !== "suggest")) throw new Error("tags takes validate or suggest, and --index FILE");
      const index = readIndex(values.index);
      if (sub === "suggest") {
        for (const s of suggestTags(index.problems)) console.log(`${s.kind}\t${s.problem}${s.with !== undefined ? `\twith ${s.with}` : ""}\t${s.reason}`);
        return 0;
      }
      if (!values.annotations) throw new Error("tags validate needs --annotations FILE");
      const problems = validateAnnotations(JSON.parse(readFileSync(values.annotations, "utf8")) as Annotations, index.problems);
      for (const p of problems) console.error(p);
      console.log(problems.length === 0 ? "annotations are valid" : `${problems.length} problem(s)`);
      return problems.length === 0 ? 0 : 1;
    }
    if (command === "graded") {
      if (!values.fc || !values.putnam || !values.seed || !values.out) throw new Error("graded needs --fc DIR, --putnam DIR, --seed S and --out FILE");
      const bench = buildGraded({
        fc: values.fc,
        putnam: values.putnam,
        seed: values.seed,
        ...(values["size-b"] !== undefined ? { sizeB: Number(values["size-b"]) } : {}),
        ...(values["size-c"] !== undefined ? { sizeC: Number(values["size-c"]) } : {}),
        ...(values["lean-project"] !== undefined ? { admit: lakeAdmitter(values["lean-project"]) } : {}),
      });
      writeGraded(values.out, bench);
      for (const [grade, g] of Object.entries(bench.grades)) console.log(`grade ${grade}: ${g.entries} problems of ${g.candidates} candidates, ${g.rejected.length} rejected by Lean (${g.source})`);
      if (values["lean-project"] === undefined) console.error("no --lean-project: every entry is recorded as unchecked, and a run refuses them without --allow-unchecked");
      return 0;
    }
    if (command === "ext") {
      if (positionals[1] === "convert") {
        console.error(licenceNote);
        const problems = values.cache ? readCache(values.cache) : values.rows ? convertRows(readFileSync(values.rows, "utf8")) : undefined;
        if (problems === undefined) throw new Error("ext convert needs --cache DIR (a local copy of the dataset) or --rows FILE");
        const text = `${JSON.stringify(problems, null, 1)}\n`;
        if (values.out) writeFileSync(values.out, text);
        else process.stdout.write(text);
        return 0;
      }
      if (positionals[1] === "steps" && positionals[2]) {
        const report = closedByStep(readEvents(`${positionals[2]}/journal.jsonl`));
        console.log(JSON.stringify(report, null, 1));
        return 0;
      }
      throw new Error("ext takes convert or steps RUN_DIR");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    return 2;
  }
  return 2;
}

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
  const annotations = values.annotations ? (JSON.parse(readFileSync(values.annotations, "utf8")) as Annotations) : undefined;
  const index = buildIndex(values.checkout, values.id, filter, annotations);
  writeIndex(values.out, index);
  console.log(`${index.benchId}: ${index.counts.selected} problems of ${index.counts.theorems} theorems (${index.source.repo}@${index.source.tag ?? index.source.rev.slice(0, 12)}, ${index.source.lean}) -> ${values.out}`);
  for (const error of index.errors.slice(0, 20)) console.error(`unreadable: ${error}`);
}

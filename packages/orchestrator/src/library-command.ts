import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BlobStore } from "@seshat/core";
import { libraryFiles } from "@seshat/library";
import { MemoryStore } from "@seshat/memory";
import { REPO_ROOT } from "./implementations.ts";
import { openForAnswers } from "./team.ts";

/** `harness library export RUN_DIR [--out DIR]`: the library of a run (and the runs it started on) as Lean files. */
export interface LibraryExportOptions {
  /** The directory the files are written under; default `lean/` of the repository, so `lean/SeshatLib/<Domain>.lean`. */
  out?: string | undefined;
  /** Also write the lemmas the certifier has not replayed (marked as such). Default: only the proved ones. */
  includeComputed?: boolean | undefined;
}

/**
 * Writes `SeshatLib/<Domain>.lean` for each domain from the lemmas the run's memory holds: the usable ones, whose claim
 * passed a Lean check in the run's environment and that still compile (documentation/library.md). The files are generated
 * from the journal; nothing is compiled here. Returns the paths written.
 */
export function libraryExportCommand(dir: string, o: LibraryExportOptions & { print: (line: string) => void }): string[] {
  const root = resolve(o.out ?? join(REPO_ROOT, "lean"));
  const journal = openForAnswers(resolve(dir));
  try {
    const memory = new MemoryStore({ journal, blobs: new BlobStore(join(resolve(dir), "blobs")) });
    const files = libraryFiles(memory, { includeComputed: o.includeComputed === true });
    const written: string[] = [];
    for (const [path, text] of files) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      written.push(target);
      o.print(`wrote ${target}`);
    }
    if (written.length === 0) o.print("the run's library holds no lemma to write (only lemmas the certifier replayed are, unless --include-computed): no file written");
    else o.print("These files are generated and have not been compiled by Lean here: a Lean host compiles them (documentation/library.md).");
    return written;
  } finally {
    journal.close();
  }
}

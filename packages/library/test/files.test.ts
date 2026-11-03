import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { libraryFiles, moduleName, modulePath, parseAuxRegion, renderLibraryFile, allLemmas } from "../src/index.ts";
import { library } from "./helpers.ts";

describe("the library's Lean files", () => {
  it("name a module after the domain", () => {
    assert.equal(moduleName("msc:11"), "SeshatLib.Msc11");
    assert.equal(moduleName("general"), "SeshatLib.General");
    assert.equal(moduleName("11"), "SeshatLib.D11");
    assert.equal(moduleName(":::"), "SeshatLib.General");
    assert.equal(modulePath("SeshatLib.Msc11"), "SeshatLib/Msc11.lean");
  });

  it("write each domain's lemmas under a namespace, with the provenance of each", async () => {
    const { memory } = await library("rev-a");
    const files = libraryFiles(memory);
    assert.deepEqual([...files.keys()], ["SeshatLib/General.lean"]);
    const text = files.get("SeshatLib/General.lean") as string;
    assert.match(text, /^\/-\n {2}SeshatLib\.General: lemmas that the harness proved/);
    assert.match(text, /\nimport Mathlib\n\nnamespace SeshatLib\.General\n\n/);
    assert.match(text, /Library lemma aux_lib_good_000000, from aux_good of problem p \(attempt a\)\.\n {4}Claim clm_\w+ \(computed\), statement st0_\w+\.\n {4}Mathlib revision rev-a/);
    assert.match(text, / -\/\ntheorem aux_lib_good_000000 \(n : ℕ\) : n \+ 0 = n \+ 0 := by\n {2}omega\n\n\/- Library lemma aux_lib_broken_000000/);
    assert.match(text, /\nend SeshatLib\.General\n$/);
    // The file reads back: each lemma in it is one the library holds, whole.
    const back = parseAuxRegion(text.replace(/namespace SeshatLib\.General|end SeshatLib\.General/g, "").replace(/theorem aux_lib_/g, "theorem aux_lib_"));
    assert.deepEqual(back.lemmas.map((l) => l.name), allLemmas(memory).map((l) => l.name));
  });

  it("leave out a lemma that is stale or whose claim is open, and write no file for an empty domain", async () => {
    const { memory } = await library("rev-a");
    memory.updateNode(allLemmas(memory)[1]?.nodeId as string, { stale: true }, "test");
    const text = libraryFiles(memory).get("SeshatLib/General.lean") as string;
    assert.match(text, /aux_lib_good_000000/);
    assert.doesNotMatch(text, /aux_lib_broken_000000/);
    memory.updateNode(allLemmas(memory)[0]?.nodeId as string, { stale: true }, "test");
    assert.equal(libraryFiles(memory).size, 0);
  });

  it("keep a comment closer in a gloss from ending the provenance comment", async () => {
    const { memory } = await library("rev-a");
    const [lemma] = allLemmas(memory);
    const text = renderLibraryFile("SeshatLib.General", [{ ...(lemma as NonNullable<typeof lemma>), source: { ...(lemma as NonNullable<typeof lemma>).source, name: "aux_x -/ evil" } }]);
    assert.doesNotMatch(text, /aux_x -\/ evil/);
  });
});

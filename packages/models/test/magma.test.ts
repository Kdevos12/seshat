import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allMagmas,
  canonicalMagma,
  countMagmas,
  magmaBattery,
  type Magma,
  permutations,
  relabel,
  Rng,
  sampleMagmas,
} from "../src/index.ts";

const commutative = (m: Magma) => m.table.every((v, i) => v === m.table[(i % m.size) * m.size + Math.floor(i / m.size)]);

describe("finite magmas up to isomorphism", () => {
  it("lists 1, 10 and 3330 magmas of sizes 1, 2 and 3 (OEIS A001329)", () => {
    assert.deepEqual([1, 2, 3].map((size) => allMagmas(size).length), [1, 10, 3330]);
  });

  it("agrees with Burnside's count, which also gives 178 981 952 magmas of size 4 without listing them", () => {
    assert.deepEqual([1, 2, 3, 4].map((size) => countMagmas(size)), [1n, 10n, 3330n, 178981952n]);
    assert.equal(countMagmas(5), 2483527537094825n);
    for (const size of [1, 2, 3]) assert.equal(BigInt(allMagmas(size).length), countMagmas(size));
  });

  it("lists each class once, in canonical form and in lexicographic order", () => {
    for (const size of [2, 3]) {
      const magmas = allMagmas(size);
      assert.equal(new Set(magmas.map((m) => m.id)).size, magmas.length);
      assert.deepEqual(magmas.map((m) => m.id), magmas.map((m) => m.id).sort());
      for (const magma of magmas) assert.deepEqual(canonicalMagma(magma).table, magma.table);
    }
  });

  it("recognizes isomorphic magmas by their canonical form, and tells the others apart", () => {
    const rng = new Rng(11);
    for (let k = 0; k < 30; k++) {
      const table = Array.from({ length: 9 }, () => rng.int(3));
      const perm = rng.permutation(3);
      const original = { size: 3, table };
      const renamed = { size: 3, table: relabel(original, perm) };
      assert.deepEqual(canonicalMagma(renamed).table, canonicalMagma(original).table);
    }
    // x * y = x and x * y = y are different magmas, and each is its own mirror image's relabeling.
    assert.notDeepEqual(canonicalMagma({ size: 2, table: [0, 0, 1, 1] }).table, canonicalMagma({ size: 2, table: [0, 1, 0, 1] }).table);
    assert.equal(permutations(4).length, 24);
  });

  it("refuses to list the magmas of size 4", () => {
    assert.throws(() => allMagmas(4), /too many magmas of size 4/);
    assert.throws(() => allMagmas(0), /at least one element/);
  });

  it("samples magmas of size 4 with a seed: the same seed gives the same magmas, none isomorphic to another", () => {
    const sample = sampleMagmas(4, 80, 7);
    assert.equal(sample.length, 80);
    assert.equal(new Set(sample.map((m) => m.id)).size, 80);
    for (const magma of sample) assert.deepEqual(canonicalMagma(magma).table, magma.table);
    assert.deepEqual(sampleMagmas(4, 80, 7).map((m) => m.id), sample.map((m) => m.id));
    assert.notDeepEqual(sampleMagmas(4, 80, 8).map((m) => m.id), sample.map((m) => m.id));
    // Uniform tables are almost never commutative; the other strategies reach such magmas.
    assert.ok(sample.filter(commutative).length >= 5);
    assert.ok(sample.some((m) => Array.from({ length: 4 }, (_, a) => new Set(m.table.slice(a * 4, a * 4 + 4)).size).every((k) => k === 1)), "a magma with constant rows");
  });

  it("returns fewer magmas than asked when the size has fewer classes", () => {
    assert.equal(sampleMagmas(2, 50, 1).length, 10);
  });
});

describe("the battery of magmas", () => {
  it("holds the magmas of sizes 1 to 3 and a sample of size 4, with an id that says how it was made", () => {
    const battery = magmaBattery();
    assert.equal(battery.id, "magmas:3+4x120@1");
    assert.equal(battery.objects.length, 1 + 10 + 3330 + 120);
    assert.equal(new Set(battery.objects.map((m) => m.id)).size, battery.objects.length);
    assert.deepEqual(battery.generator, { name: "magmas", params: { exhaustive: 3, sampleSize: 4, samples: 120, seed: 1 } });
    assert.equal(magmaBattery().digest, battery.digest);
    assert.notEqual(magmaBattery({ seed: 2 }).digest, battery.digest);
    assert.equal(magmaBattery({ samples: 0 }).id, "magmas:3");
    assert.equal(magmaBattery({ exhaustive: 2, sampleSize: 3, samples: 5 }).objects.length, 1 + 10 + 5);
  });

  it("refuses sizes it cannot list, and a sample that overlaps the listed sizes", () => {
    assert.throws(() => magmaBattery({ exhaustive: 4 }), /size 0 to 3/);
    assert.throws(() => magmaBattery({ sampleSize: 3 }), /must be above the listed sizes/);
  });
});

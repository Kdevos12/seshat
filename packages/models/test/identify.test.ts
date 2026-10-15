import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { MemoryStore } from "@seshat/memory";
import {
  allMagmas,
  countMagmas,
  GROUPS_OF_ORDER,
  graphsUpToIso,
  identifySequence,
  identifyTable,
  type KnownSequence,
  knownSequences,
  type Magma,
  product,
  recordIdentification,
  strengthOf,
  toTerms,
} from "../src/index.ts";

const sequence = (id: string): KnownSequence => {
  const found = knownSequences().find((s) => s.id === id);
  assert.ok(found !== undefined, `${id} is in the table`);
  return found;
};
const at = (id: string, n: number): bigint => sequence(id).terms[n - sequence(id).offset] as bigint;
const digits = (id: string, count: number): string => sequence(id).terms.slice(0, count).join("");

describe("the table of known sequences", () => {
  it("has each OEIS number once, with a name, an offset and terms", () => {
    const ids = knownSequences().map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const s of knownSequences()) {
      assert.match(s.id, /^A\d{6}$/);
      assert.ok(s.name.length > 10 && s.terms.length >= 5, s.id);
      assert.ok(s.offset === 0 || s.offset === 1, s.id);
    }
    assert.ok(knownSequences().length >= 60);
  });

  it("computes the sequences of a formula or a recurrence with exact integers", () => {
    // Values that are standard, written here from memory of the OEIS entries.
    assert.deepEqual(
      [at("A000045", 10), at("A000045", 20), at("A000045", 50), at("A000045", 89)],
      [55n, 6765n, 12586269025n, 1779979416004714189n],
    );
    assert.equal(at("A000032", 10), 123n);
    assert.equal(at("A000108", 10), 16796n);
    assert.equal(at("A000142", 20), 2432902008176640000n);
    assert.equal(at("A000142", 25), 15511210043330985984000000n);
    assert.deepEqual([at("A000041", 10), at("A000041", 20), at("A000041", 50)], [42n, 627n, 204226n]);
    assert.deepEqual([at("A000009", 10), at("A000009", 20)], [10n, 64n]);
    assert.deepEqual([at("A000110", 8), at("A000110", 10)], [4140n, 115975n]);
    assert.deepEqual([at("A000085", 7), at("A000085", 8)], [232n, 764n]);
    assert.deepEqual([at("A000670", 5), at("A000670", 6)], [541n, 4683n]);
    assert.deepEqual([at("A001006", 8), at("A001006", 10)], [323n, 2188n]);
    assert.deepEqual([at("A000010", 36), at("A000010", 60)], [12n, 16n]);
    assert.deepEqual([at("A000005", 12), at("A000005", 60)], [6n, 12n]);
    assert.deepEqual([at("A000203", 12), at("A000203", 60)], [28n, 168n]);
    assert.deepEqual([at("A008683", 6), at("A008683", 12), at("A008683", 30)], [1n, 0n, -1n]);
    assert.deepEqual([at("A000040", 10), at("A000040", 25), at("A000040", 70)], [29n, 97n, 349n]);
    assert.deepEqual([at("A000720", 10), at("A000720", 30), at("A000720", 60)], [4n, 10n, 17n]);
    assert.equal(at("A000272", 7), 16807n);
    assert.equal(at("A000124", 10), 56n);
    assert.equal(at("A001045", 10), 341n);
    assert.equal(at("A000073", 11), 149n);
    assert.equal(at("A000225", 64), 18446744073709551615n);
  });

  it("gives the same triangles and lists as the definitions", () => {
    assert.deepEqual(sequence("A007318").terms.slice(0, 15), [1n, 1n, 1n, 1n, 2n, 1n, 1n, 3n, 3n, 1n, 1n, 4n, 6n, 4n, 1n]);
    assert.deepEqual(sequence("A008277").terms.slice(0, 15), [1n, 1n, 1n, 1n, 3n, 1n, 1n, 7n, 6n, 1n, 1n, 15n, 25n, 10n, 1n]);
    assert.deepEqual(sequence("A005117").terms.slice(0, 12), [1n, 2n, 3n, 5n, 6n, 7n, 10n, 11n, 13n, 14n, 15n, 17n]);
    assert.deepEqual(sequence("A002808").terms.slice(0, 10), [4n, 6n, 8n, 9n, 10n, 12n, 14n, 15n, 16n, 18n]);
    assert.deepEqual(sequence("A001358").terms.slice(0, 10), [4n, 6n, 9n, 10n, 14n, 15n, 21n, 22n, 25n, 26n]);
    assert.deepEqual(sequence("A000961").terms.slice(0, 12), [1n, 2n, 3n, 4n, 5n, 7n, 8n, 9n, 11n, 13n, 16n, 17n]);
    assert.deepEqual(sequence("A002113").terms.slice(0, 13), [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 11n, 22n, 33n]);
  });

  it("has the digits of the constants, as an independent computation gives them", () => {
    assert.equal(digits("A000796", 60), "314159265358979323846264338327950288419716939937510582097494");
    assert.equal(digits("A001113", 60), "271828182845904523536028747135266249775724709369995957496696");
    assert.equal(digits("A002193", 60), "141421356237309504880168872420969807856967187537694807317667");
    assert.equal(digits("A001622", 60), "161803398874989484820458683436563811772030917980576286213544");
  });

  it("agrees with the counts of the package's own enumerations", () => {
    assert.deepEqual(sequence("A001329").terms.slice(0, 5), [1, 2, 3, 4, 5].map((n) => countMagmas(n)));
    assert.deepEqual(sequence("A000088").terms.slice(1, 7), [1, 2, 3, 4, 5, 6].map((n) => BigInt(graphsUpToIso(n).length)));
    assert.deepEqual(sequence("A000001").terms.slice(1, 33), GROUPS_OF_ORDER.map((n) => BigInt(n)));
    const associative = (m: Magma): boolean => {
      for (let a = 0; a < m.size; a++)
        for (let b = 0; b < m.size; b++)
          for (let c = 0; c < m.size; c++) if (product(m, product(m, a, b), c) !== product(m, a, product(m, b, c))) return false;
      return true;
    };
    const commutative = (m: Magma): boolean => {
      for (let a = 0; a < m.size; a++) for (let b = 0; b < m.size; b++) if (product(m, a, b) !== product(m, b, a)) return false;
      return true;
    };
    const semigroups = [1, 2, 3].map((n) => allMagmas(n).filter(associative));
    assert.deepEqual(sequence("A027851").terms.slice(0, 3), semigroups.map((s) => BigInt(s.length)));
    assert.deepEqual(sequence("A001426").terms.slice(0, 3), semigroups.map((s) => BigInt(s.filter(commutative).length)));
  });
});

describe("terms", () => {
  it("are exact integers: numbers, bigints and decimal text", () => {
    assert.deepEqual(toTerms([1, 2n, " 3 ", "-4", "123456789012345678901234567890"]), [1n, 2n, 3n, -4n, 123456789012345678901234567890n]);
  });

  it("refuse what is not an integer, or not exactly one", () => {
    assert.throws(() => toTerms([1.5]), /term 0 is 1\.5, not a safe integer/);
    assert.throws(() => toTerms([2 ** 60]), /not a safe integer: pass a bigint or its text/);
    assert.throws(() => toTerms([1, "abc"]), /term 1 is "abc", not an integer/);
    assert.throws(() => toTerms(["1e3"]), /not an integer/);
  });
});

describe("identifying a sequence", () => {
  it("finds the Fibonacci numbers from their terms, starting wherever the terms start", () => {
    const found = identifySequence([1, 1, 2, 3, 5, 8, 13]);
    assert.equal(found.strength, "strong");
    const [first] = found.matches;
    assert.deepEqual(first, { id: "A000045", name: sequence("A000045").name, source: "local", offset: 0, start: 1, next: [21n, 34n, 55n, 89n, 144n], prefix: false });
    assert.deepEqual(found.query, [1n, 1n, 2n, 3n, 5n, 8n, 13n]);
  });

  it("puts the sequences whose first terms are the query before the others, and predicts the next terms", () => {
    const evens = identifySequence([0, 2, 4, 6, 8, 10]);
    assert.equal(evens.matches[0]?.id, "A005843");
    assert.equal(evens.matches[0]?.prefix, true);
    assert.deepEqual(evens.matches[0]?.next, [12n, 14n, 16n, 18n, 20n]);
    const counting = identifySequence([1, 2, 3, 4, 5]);
    assert.deepEqual(counting.matches[0] && [counting.matches[0].id, counting.matches[0].prefix, counting.matches[0].start], ["A000027", true, 1]);
    const nonnegative = counting.matches.find((m) => m.id === "A001477");
    assert.deepEqual(nonnegative && [nonnegative.prefix, nonnegative.offset, nonnegative.start], [false, 0, 1]);
    // Those that start with the query come first, then the rest.
    const flags = counting.matches.map((m) => m.prefix);
    assert.deepEqual(flags, [...flags].sort((a, b) => Number(b) - Number(a)));
    assert.ok(flags.includes(true) && flags.includes(false));
  });

  it("recognizes a long term beyond the safe integers, from text", () => {
    const found = identifySequence(["14472334024676221", "23416728348467685", "37889062373143906", "61305790721611591"]);
    assert.equal(found.matches[0]?.id, "A000045");
    assert.equal(found.matches[0]?.start, 79);
    assert.equal(found.strength, "weak");
  });

  it("recognizes a shorter table-wide count, a count of structures", () => {
    const groups = identifySequence([1, 1, 1, 2, 1, 2, 1, 5, 2, 2, 1, 5]);
    assert.equal(groups.matches[0]?.id, "A000001");
    assert.equal(groups.strength, "strong");
    const graphs = identifySequence([1, 2, 4, 11, 34, 156]);
    assert.equal(graphs.matches[0]?.id, "A000088");
  });

  it("calls a long varied query strong and a short or flat one weak", () => {
    assert.equal(strengthOf([1n, 2n, 3n, 4n, 5n, 6n]), "strong");
    assert.equal(strengthOf([1n, 2n, 3n, 4n, 5n]), "weak");
    assert.equal(strengthOf([1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n]), "weak");
    assert.equal(strengthOf([1n, 2n, 1n, 2n, 3n, 1n, 2n, 3n, 1n, 2n]), "strong");
    const flat = identifySequence([1, 1, 1, 1]);
    assert.equal(flat.matches[0]?.id, "A000012");
    assert.equal(flat.strength, "weak");
  });

  it("returns nothing, with a reason, for too few terms or for terms nobody has", () => {
    const short = identifySequence([1, 2, 3]);
    assert.deepEqual([short.matches, short.strength], [[], "none"]);
    assert.match(short.note ?? "", /3 terms is too few to identify a sequence: at least 4/);
    assert.equal(identifySequence([1, 2, 3], { minTerms: 3 }).matches[0]?.id, "A000027");
    const none = identifySequence([7, 7, 7, 8, 13, 100, 1]);
    assert.deepEqual([none.matches, none.strength], [[], "none"]);
    assert.match(none.note ?? "", /no sequence of the table/);
  });

  it("looks in the table it is given, and returns at most the matches asked", () => {
    const table: KnownSequence[] = [{ id: "A999999", name: "Made up.", offset: 7, terms: [3n, 1n, 4n, 1n, 5n, 9n] }];
    const found = identifySequence([1, 4, 1, 5], { table });
    assert.deepEqual(found.matches.map((m) => [m.id, m.offset, m.start, m.next]), [["A999999", 7, 8, [9n]]]);
    assert.equal(identifySequence([1, 2, 3, 4], { maxMatches: 2 }).matches.length, 2);
    assert.ok(identifySequence([1, 2, 3, 4]).matches.length > 2);
    assert.throws(() => identifySequence([1, 2, 3, 4], { maxMatches: 0 }), /maxMatches is a positive integer/);
    assert.throws(() => identifySequence([], { minTerms: 0 }), /minTerms is a positive integer/);
  });
});

describe("identifying a table", () => {
  it("reads Pascal's triangle by rows, and what its sums are", () => {
    const pascal = [[1], [1, 1], [1, 2, 1], [1, 3, 3, 1], [1, 4, 6, 4, 1]];
    const readings = identifyTable(pascal);
    const byReading = new Map(readings.map((r) => [r.reading, r.identification.matches.map((m) => m.id)]));
    assert.equal(byReading.get("by rows")?.[0], "A007318");
    assert.equal(byReading.get("row sums")?.[0], "A000079");
    assert.equal(byReading.get("first column")?.[0], "A000012");
    // The columns of a triangle are not the triangle.
    assert.ok(!byReading.has("by columns"));
  });

  it("reads a square array by antidiagonals", () => {
    const binomials = [
      [1, 1, 1, 1],
      [1, 2, 3, 4],
      [1, 3, 6, 10],
      [1, 4, 10, 20],
    ];
    const readings = identifyTable(binomials);
    const down = readings.find((r) => r.reading === "antidiagonals, from the first row");
    assert.deepEqual(down?.terms, [1n, 1n, 1n, 1n, 2n, 1n, 1n, 3n, 3n, 1n]);
    assert.equal(down?.identification.matches[0]?.id, "A007318");
    // The same terms as the table read from the first column down.
    const up = readings.find((r) => r.reading === "antidiagonals, from the first column");
    assert.equal(up?.identification.matches[0]?.id, "A007318");
    const diagonal = readings.find((r) => r.reading === "main diagonal");
    assert.deepEqual(diagonal?.terms, [1n, 2n, 6n, 20n]);
    assert.equal(diagonal?.identification.matches[0]?.id, "A000984");
  });

  it("returns only the readings that match, and none for a table of nothing known", () => {
    assert.deepEqual(identifyTable([[7, 7, 7, 8], [13, 100, 1, 9]]), []);
    assert.deepEqual(identifyTable([]), []);
  });
});

describe("recording an identification", () => {
  const open = () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-ident-"));
    return new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) }).withActor("line:M11");
  };

  it("makes a node and a cites edge from the claim, as computed, and decides nothing", async () => {
    const memory = open();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) (h : n % 2 = 0) : n < 5", origin: "test" });
    const identification = identifySequence([2, 4, 6, 8, 10]);
    const { node, edge } = recordIdentification(memory, { claimId, subject: "the numbers where the statement holds", identification });
    assert.equal(node.kind, "identification");
    assert.equal(node.claimId, claimId);
    assert.deepEqual(node.data, {
      subject: "the numbers where the statement holds",
      query: ["2", "4", "6", "8", "10"],
      strength: "weak",
      matches: [{ id: "A005843", name: sequence("A005843").name, source: "local", offset: 0, start: 1, next: ["12", "14", "16", "18", "20"], prefix: false }],
    });
    assert.deepEqual([edge.kind, edge.from, edge.to, edge.status], ["cites", claimId, [node.nodeId], "computed"]);
    assert.match(edge.note ?? "", /A005843 \(The even numbers: a\(n\) = 2n\.\), weak match/);
    assert.equal(memory.claim(claimId)?.status, "open");
    assert.deepEqual(memory.validations(claimId), []);
  });

  it("records the reading of a table, and a query that matched nothing", async () => {
    const memory = open();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n < 5", origin: "test" });
    const none = identifySequence([7, 7, 7, 8, 13, 100, 1]);
    const { node, edge } = recordIdentification(memory, { claimId, subject: "a table", identification: none, reading: "by rows" });
    assert.equal((node.data as { reading?: string }).reading, "by rows");
    assert.equal((node.data as { strength?: string }).strength, "none");
    assert.match((node.data as { note?: string }).note ?? "", /no sequence of the table/);
    assert.equal(edge.note, "a table: no match");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  abelianGroups,
  alternatingGroup,
  cyclicGroup,
  dicyclicGroup,
  dihedralGroup,
  directProduct,
  groupBattery,
  GROUPS_OF_ORDER,
  groupObject,
  groupProblem,
  type MagmaObject,
  smallGroups,
  symmetricGroup,
} from "../src/index.ts";

/** What tells two groups of small order apart: whether they commute, and how many elements have each order. */
function invariants(group: MagmaObject): string {
  const n = group.size;
  const at = (a: number, b: number) => group.table[a * n + b] as number;
  const abelian = group.table.every((v, i) => v === at(i % n, Math.floor(i / n)));
  const orders = Array.from({ length: n }, (_, a) => {
    let power = a;
    let order = 1;
    while (power !== group.identity) {
      power = at(power, a);
      order++;
    }
    return order;
  }).sort((x, y) => x - y);
  return `${abelian ? "abelian" : "non-abelian"} ${orders.join(",")}`;
}

describe("small groups built in TypeScript", () => {
  it("builds the cyclic, dihedral, dicyclic, symmetric and alternating groups with the right orders", () => {
    assert.deepEqual([cyclicGroup(6), dihedralGroup(4), dicyclicGroup(2), dicyclicGroup(3), symmetricGroup(4), alternatingGroup(4), symmetricGroup(5)].map((g) => g.size), [6, 8, 8, 12, 24, 12, 120]);
    assert.deepEqual([symmetricGroup(3), dihedralGroup(3)].map(invariants), ["non-abelian 1,2,2,2,3,3", "non-abelian 1,2,2,2,3,3"]);
    assert.equal(invariants(dicyclicGroup(2)), "non-abelian 1,2,4,4,4,4,4,4");
    assert.equal(dicyclicGroup(2).name, "Q8");
    assert.equal(invariants(cyclicGroup(6)), "abelian 1,2,3,3,6,6");
  });

  it("gives each group its identity and inverses", () => {
    for (const group of [cyclicGroup(5), dihedralGroup(5), dicyclicGroup(3), symmetricGroup(4)]) {
      const n = group.size;
      assert.ok(group.identity !== undefined && group.inverse !== undefined);
      for (let a = 0; a < n; a++) {
        assert.equal(group.table[a * n + (group.inverse?.[a] as number)], group.identity);
      }
    }
  });

  it("refuses a table that is not a group, and says why", () => {
    assert.equal(groupProblem({ size: 2, table: [0, 1, 1, 0] }), undefined);
    assert.match(groupProblem({ size: 2, table: [0, 0, 1, 1] }) ?? "", /no inverse|no identity/);
    assert.match(groupProblem({ size: 3, table: [1, 2, 0, 2, 0, 1, 0, 2, 1] }) ?? "", /not associative|no identity/);
    assert.throws(() => groupObject("bad", 2, [0, 0, 0, 0]), /bad is not a group/);
  });

  it("builds the direct product, and the abelian groups of an order", () => {
    const klein = directProduct(cyclicGroup(2), cyclicGroup(2));
    assert.equal(klein.name, "C2 x C2");
    assert.equal(invariants(klein), "abelian 1,2,2,2");
    assert.deepEqual(abelianGroups(8).map((g) => g.name), ["C8", "C4 x C2", "C2 x C2 x C2"]);
    assert.deepEqual(abelianGroups(12).map((g) => g.name), ["C12", "C3 x C2 x C2"]);
    assert.deepEqual(abelianGroups(1).map((g) => g.name), ["C1"]);
    assert.equal(abelianGroups(36).length, 4);
  });

  it("has every group of order 1 to 15, as many as OEIS A000001 says and none twice", () => {
    const groups = smallGroups(15);
    for (let order = 1; order <= 15; order++) {
      const ofOrder = groups.filter((g) => g.size === order);
      assert.equal(ofOrder.length, GROUPS_OF_ORDER[order - 1], `groups of order ${order}`);
      assert.equal(new Set(ofOrder.map(invariants)).size, ofOrder.length, `the groups of order ${order} are told apart`);
    }
  });

  it("has only some of the groups of order 16 and above", () => {
    const ofOrder16 = smallGroups(16).filter((g) => g.size === 16);
    assert.equal(ofOrder16.length, 7);
    assert.ok(ofOrder16.length < (GROUPS_OF_ORDER[15] as number));
    assert.deepEqual(smallGroups(24).filter((g) => g.size === 24).map((g) => g.name).includes("S4"), true);
  });
});

describe("the battery of groups", () => {
  it("holds the groups of order up to 12", () => {
    const battery = groupBattery(12);
    assert.equal(battery.id, "groups:12");
    assert.equal(battery.objects.length, GROUPS_OF_ORDER.slice(0, 12).reduce((a, b) => a + b, 0));
    assert.equal(new Set(battery.objects.map((g) => g.id)).size, battery.objects.length);
    assert.throws(() => groupBattery(0), /order from 1 to 120/);
  });
});

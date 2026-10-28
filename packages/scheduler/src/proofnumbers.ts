/**
 * Weighted proof numbers on an AND/OR graph of claims (Allis 1994; graphe-donnees.md section 5).
 *
 * A claim can be reached by its own proof (a leaf, whose price is the expected cost of getting
 * it) or by any one of its decompositions (OR); a decomposition needs all its parts (AND). The
 * proof number `pn` of a claim is the least total price of leaves that settles it; the disproof
 * number `dpn` is the least total price that shows every known way to it fails. For a claim with
 * options o1..ok, `pn = min pn(o)` and `dpn = sum dpn(o)`; for a decomposition, `pn = sum pn(part)`
 * and `dpn = min dpn(part)`. A settled claim has `pn = 0, dpn = Infinity`, a refuted or dead one the
 * reverse. A claim shared by several parents is counted in each parent's sum (the double
 * counting of a DAG is an overestimate, which is accepted), and a cycle is cut where it closes.
 */
export interface PnClaim {
  id: string;
  /** `true`: nothing is left to do for it (proved, or a candidate that passed the fast check). */
  settled?: boolean;
  /** `true`: it cannot be proved (refuted). */
  dead?: boolean;
  /** The expected cost of proving it directly: mean cost per attempt over the success rate. Absent: no direct way. */
  prove?: number;
  /** The expected cost of showing the direct way fails. Absent: the same as `prove`. */
  disprove?: number;
}

/** A decomposition: `parent` follows from all of `parts` (an AND node among the parent's alternatives). */
export interface PnGroup {
  parent: string;
  parts: readonly string[];
}

export interface PnNode {
  id: string;
  pn: number;
  dpn: number;
}

export class ProofNumbers {
  private readonly claims = new Map<string, PnClaim>();
  private readonly groups = new Map<string, PnGroup[]>();
  private readonly memo = new Map<string, PnNode>();

  constructor(claims: readonly PnClaim[], groups: readonly PnGroup[]) {
    for (const c of claims) this.claims.set(c.id, c);
    for (const g of groups) {
      const list = this.groups.get(g.parent) ?? [];
      list.push(g);
      this.groups.set(g.parent, list);
    }
  }

  /** The numbers of a claim. */
  of(id: string): PnNode {
    return this.compute(id, new Set());
  }

  private compute(id: string, path: Set<string>): PnNode {
    const known = this.memo.get(id);
    if (known !== undefined) return known;
    const claim = this.claims.get(id);
    if (claim === undefined) return { id, pn: Infinity, dpn: 0 };
    if (claim.settled) return this.keep({ id, pn: 0, dpn: Infinity });
    if (claim.dead) return this.keep({ id, pn: Infinity, dpn: 0 });
    // A cycle: the claim on the path counts as unreachable here; nothing is memoized under it.
    if (path.has(id)) return { id, pn: Infinity, dpn: 0 };
    path.add(id);
    let pn = Infinity;
    const dpns: number[] = [];
    let cut = false;
    if (claim.prove !== undefined) {
      pn = claim.prove;
      dpns.push(claim.disprove ?? claim.prove);
    }
    for (const group of this.groups.get(id) ?? []) {
      const parts = [...new Set(group.parts)];
      const nodes = parts.map((p) => {
        const n = this.compute(p, path);
        if (path.has(p)) cut = true;
        return n;
      });
      if (nodes.length === 0) continue;
      pn = Math.min(pn, nodes.reduce((s, n) => s + n.pn, 0));
      dpns.push(Math.min(...nodes.map((n) => n.dpn)));
    }
    const dpn = dpns.reduce((s, d) => s + d, 0);
    path.delete(id);
    const node: PnNode = { id, pn, dpn };
    return cut ? node : this.keep(node);
  }

  private keep(node: PnNode): PnNode {
    this.memo.set(node.id, node);
    return node;
  }

  /**
   * The most proving leaf under `root`: the claim whose own proof advances the root most for its
   * price. At a claim, follow the cheapest option (the direct leaf if it is as cheap as every
   * decomposition, else the decomposition with the least `pn`); in a decomposition, the part with
   * the least disproof number that is not settled (the one that fails soonest, so a bad
   * decomposition is found out early; ties go to the part with the larger `pn`, the harder one).
   * Undefined when the root is settled or dead.
   */
  mostProving(root: string): string | undefined {
    const seen = new Set<string>();
    let id = root;
    for (;;) {
      if (seen.has(id)) return undefined;
      seen.add(id);
      const claim = this.claims.get(id);
      const node = this.of(id);
      if (claim === undefined || node.pn === 0 || node.pn === Infinity) return undefined;
      const direct = claim.prove;
      let best: PnGroup | undefined;
      let bestPn = Infinity;
      for (const group of this.groups.get(id) ?? []) {
        const parts = [...new Set(group.parts)];
        const gpn = parts.reduce((s, p) => s + this.of(p).pn, 0);
        if (gpn < bestPn) {
          bestPn = gpn;
          best = group;
        }
      }
      if (best === undefined || (direct !== undefined && direct <= bestPn)) return direct === undefined ? undefined : id;
      const open = [...new Set(best.parts)].filter((p) => this.of(p).pn > 0 && this.of(p).pn < Infinity);
      if (open.length === 0) return undefined;
      open.sort((a, b) => this.of(a).dpn - this.of(b).dpn || this.of(b).pn - this.of(a).pn || (a < b ? -1 : 1));
      id = open[0] as string;
    }
  }
}

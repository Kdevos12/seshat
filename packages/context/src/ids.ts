import { ShortIds } from "@seshat/graph";

/**
 * The citable ids of a session (plan §4): `C17` for a claim, `E5` for an edge, `L4` for a premise or lemma of the packet, `A2` for
 * a lesson. They are numbered from 1 in the order they are first shown, so the same packet gets the same ids, and a name once
 * given never changes in the session. It is a `ShortIds`, so `graphQuery` and `connect` write their claims and edges with it.
 * `resolve` is the only way a model's id becomes an object: an id that was never given resolves to nothing.
 */
export type IdKind = "C" | "E" | "L" | "A";

export class CitableIds extends ShortIds {
  readonly #byObject = new Map<string, string>();
  readonly #byName = new Map<string, string>();
  readonly #counts: Record<IdKind, number> = { C: 0, E: 0, L: 0, A: 0 };
  readonly #isEdge: (id: string) => boolean;

  /** `isEdge` says whether an object id (not a premise or lesson) names an edge rather than a claim. */
  constructor(isEdge: (id: string) => boolean) {
    super();
    this.#isEdge = isEdge;
  }

  /** Gives `key` a name of kind `kind` (the same one when it has one). */
  name(kind: IdKind, key: string): string {
    const known = this.#byObject.get(`${kind}\u0000${key}`);
    if (known !== undefined) return known;
    this.#counts[kind] += 1;
    const name = `${kind}${this.#counts[kind]}`;
    this.#byObject.set(`${kind}\u0000${key}`, name);
    this.#byName.set(name, key);
    return name;
  }

  override shorten(id: string): string {
    return this.name(this.#isEdge(id) ? "E" : "C", id);
  }

  /** The object id a name stands for. A name is matched in capitals, so `c17` is `C17`. */
  override resolve(name: string): string | undefined {
    return this.#byName.get(name.trim().toUpperCase());
  }

  /** The kind of a name, when it was given. */
  kindOf(name: string): IdKind | undefined {
    const n = name.trim().toUpperCase();
    return this.#byName.has(n) ? (n[0] as IdKind) : undefined;
  }

  /** Every name given so far, in order of kind and number. */
  all(): string[] {
    return [...this.#byName.keys()];
  }
}

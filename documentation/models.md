# Small models, fingerprints, identification

`@seshat/models` is the package behind line M11 ([lines.md](lines.md)). It looks at a statement the
way an experimenter does: it tries it on small objects before anyone tries to prove it. It builds
batteries of small objects, evaluates statements on them, keeps the vector of verdicts (the
fingerprint) as a record, proposes relations between statements from fingerprints, and turns a
counter-model into a refutation that Lean decides. It also recognizes sequences and tables.

Nothing here makes a claim true or false. A verdict computed in TypeScript or by `decide` is a
test result; the only thing that changes a claim's status is a Lean proof submitted through
`validate` ([trust.md](trust.md)). The package has no network access of its own, and none of it has
run against a real Lean, a real SageMath or the real OEIS, FindStat and LMFDB yet
([what is not done](#what-is-not-done)).

## Batteries

A battery is a fixed list of small objects of one family, with the code that made it. Its `id`
says what it holds and how it was made, its `digest` is the hash of the objects' ids in order, and
its `generator` holds the name and the parameters that make it again. Two batteries with the same
`id` and `digest` hold the same objects in the same order, so fingerprints computed on them can be
compared position by position. A battery holds at most 20 000 objects: a fingerprint has one
verdict for each and goes into the journal.

| Battery | Call | Holds | `id` (example) |
|---|---|---|---|
| Magmas | `magmaBattery({exhaustive, sampleSize, samples, seed})` | All magmas up to isomorphism of size 1 to `exhaustive` (at most 3), then `samples` magmas of size `sampleSize` | `magmas:3+4x120@1` |
| Groups | `groupBattery(maxOrder)` | `smallGroups(maxOrder)` | `groups:12` |
| Graphs | `graphBattery(maxVertices, {connected})` | The graphs on 1 to `maxVertices` vertices (at most 8) up to isomorphism | `graphs:6`, `graphs:connected:5` |
| Integers | `integerBattery(max, {min})` | The integers from `min` (0) to `max` | `integers:0..40` |
| Graphs from nauty | `sageGraphBattery(run, {vertices, flags})` | What `geng` makes, through SageMath | `graphs:geng:7 -c` |
| Groups from GAP's library | `sageGroupBattery(run, orders)` | The groups of the SmallGroups library, through SageMath | `groups:sage:6,8` |

The default magma battery has 3 461 magmas: the 1, 10 and 3 330 classes of size 1, 2 and 3, and 120
sampled classes of size 4, all different, drawn with a seed.

### Magmas

A magma is a set `0..n-1` with a table `table[a * n + b]` for the product. Two magmas are
isomorphic when a renaming of the elements turns one table into the other; the canonical form of a
magma is the smallest table over all renamings (`canonicalMagma`, for sizes up to 6), and the
battery lists each class once, in canonical form.

| Size | Classes | How |
|---|---|---|
| 1, 2, 3 | 1, 10, 3 330 | Listed: every table is tried, and the canonical ones kept (`allMagmas`). Equals OEIS A001329. |
| 4 | 178 981 952 | Counted by Burnside's lemma (`countMagmas`, sizes 1 to 8, exact with BigInt); sampled, not listed. |

The sample (`sampleMagmas(size, count, seed)`) cycles through seven ways of drawing a table,
because a uniform table is almost never commutative, idempotent or a quasigroup, and a battery
that holds none of those cannot tell the laws about them apart: `uniform`, `commutative`,
`idempotent`, `affine` (`a*b = ua + vb + w` modulo the size), `latin`, `row-constant` and
`column-constant`. The generator is a seeded PRNG (`Rng`, mulberry32), so a seed gives the same
sample on every machine. Isomorphic samples are dropped, so the sample may be shorter than asked
only when the size has fewer classes.

### Groups

`smallGroups(maxOrder)` builds groups in TypeScript and checks each one (`groupObject` refuses a
table that is not associative or has no identity or inverses, and says which). A group object
carries its name, its identity and the inverse of each element.

| Family | Builder | Orders |
|---|---|---|
| Cyclic `C<n>` | `cyclicGroup(n)` | any |
| Dihedral `D<n>` | `dihedralGroup(n)` | 2n |
| Dicyclic `Dic<n>`, `Q8` | `dicyclicGroup(n)` | 4n |
| Symmetric `S<n>` | `symmetricGroup(n)`, n up to 5 | n! |
| Alternating `A<n>` | `alternatingGroup(n)`, n from 3 to 5 | n!/2 |
| Direct products | `directProduct(a, b)`; `abelianGroups(n)` lists every abelian group of order n | |

`smallGroups` is complete up to order 15 (a test counts them against OEIS A000001: 1, 1, 1, 2, 1,
2, 1, 5, 2, 2, 1, 5, 1, 2, 1, and tells the groups apart by whether they commute and the orders
of their elements). From order 16 it holds only some of the groups; `GROUPS_OF_ORDER` has the
numbers of groups of order 1 to 32, so a caller can see what is missing. The SmallGroups library
through SageMath (below) is the complete source.

### Graphs

A graph is `{n, edges, graph6}` on the vertices `0..n-1`, simple and undirected; its id is its
graph6 string (`toGraph6`, `fromGraph6`). `graphsUpToIso(n)` lists the graphs on n vertices (1 to
8) up to isomorphism by adding one vertex at a time to the classes of n-1 vertices and keeping the
canonical forms. The canonical form of a graph is the smallest adjacency key over the vertex
orderings that respect a colour refinement of the vertices (`canonicalGraph`).

| Vertices | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Graphs | 1 | 2 | 4 | 11 | 34 | 156 | 1 044 | 12 346 |
| Time here | | | | | | 50 ms | 0.3 s | 4.5 s |

The counts equal OEIS A000088, the connected ones (`isConnected`) A001349, and the counts for 1 to
6 vertices equal what nauty gave in the contract of `compute.sage` (a test reads
`capabilities/compute.sage/contract.json`).

### Integers

`integerBattery(max)` is the integers from 0 to `max`; it is the battery of the statements about
a natural number, such as `n * n + n` is even.

## Batteries from SageMath

The graphs of nauty and the SmallGroups library are reached through the capability `compute.sage`
([compute.md](compute.md)). The adapters take a `SageRun`, a function from Sage code to the text
of its last expression; `sageThroughRegistry(registry, {scope})` makes one from the registry, in a
Sage session of its own, and a test gives a stand-in.

- `sageGraphBattery` evaluates `[g.graph6_string() for g in graphs.nauty_geng("7")]` in slices of
  1 000 graphs, so that no answer is long, and reads the graph6 strings. `flags` are `geng`'s (`-c`
  connected, `-t` triangle-free); anything that is not a flag is refused before it reaches Sage.
- `sageGroupBattery` reads each `SmallPermutationGroup(n, k)` of the orders asked (1 to 32) as a
  Cayley table, and checks that it is a group.

The tests run both adapters against a stand-in that answers as Sage does, and check that the graphs
of `geng` and the TypeScript generator agree. A test against a real SageMath runs only when
`SAGEMATH_MCP_COMMAND` names the `sagemath-mcp` executable
([development.md](development.md#tests-that-use-real-data)); it has not been run here.

## What is not done

- The adapters for SageMath have not run against a real SageMath.
- Magmas of size 4 are sampled, never listed. Groups of order 16 and above are partly built.

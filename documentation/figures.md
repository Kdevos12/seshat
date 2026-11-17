# Figures

Every picture in `documentation/images/` except the screenshot of the interface is drawn by code: one TypeScript
function per figure in `packages/figures/src/figures/`, over a small SVG toolkit with no dependency
(`packages/figures/src/svg.ts`). A figure is reviewed as code, changes in the same commit as the page it illustrates,
and is the same file on every machine.

```sh
pnpm figures            # writes every figure to documentation/images/NAME.svg
pnpm figures trust      # one figure
pnpm figures --check    # writes nothing; fails when a file is not its figure's output
```

`packages/figures/test/figures.test.ts` fails when an SVG in the repository differs from its figure's output (the
figure was edited by hand, or its code changed without `pnpm figures`), when a text overflows its box (measured with
Helvetica's metrics, which Arial shares), or when a figure names a model.

## How to read them

One colour per role, in every figure:

| Colour | Role |
|---|---|
| green | Lean: the judge, its checks and its tools |
| violet | language models, through their APIs |
| blue | classical tools: tactics, SMT, ATPs, computer algebra, anything with no model |
| amber | the journal and what is rebuilt from it |
| slate | the orchestrator, budgets, ledgers and schedulers |
| rose | people: the research team, signatures, reviews |
| teal | third-party services, which `--private` turns off |
| white | inputs, outputs and files |

One border per state, where a figure marks it: **solid**, has run for real (on the owner's machine, with Lean 4.27.0
and a real model, or against the real program or service); **dashed**, built and tested with simulations only;
**dotted grey**, planned. [status.md](status.md) is the source of these marks, and a figure changes when it does.
Dashed amber arrows are writes to the journal.

Every figure carries Seshat's logo in its top right corner. The logo's source is `assets/logo/seshat.svg` (a trace of
the owner's drawing, `seshat-original.jpg` beside it); `packages/figures/src/logo.ts` reads it, so a new logo changes
every figure at the next `pnpm figures`. A title or subtitle that would run into it is reported as a problem, like a text
that overflows its box. The other uses of the logo (README, interface, social preview) are listed in
[`assets/logo/README.md`](../assets/logo/README.md).

## Adding or changing a figure

1. Write `packages/figures/src/figures/NAME.ts`, exporting one function that returns a `Figure`, and add it to
   `FIGURES` in `packages/figures/src/index.ts`.
2. Run `pnpm figures NAME` and look at the result (any SVG viewer or a browser).
3. Embed it in the page it illustrates and list it in the figure gallery of the documentation's home page
   ([README.md](README.md#figures)): a test fails when an image in `documentation/images/` is not listed there.

Rules: the facts come from the page the figure illustrates, in its words; a figure shows a mechanism (a flow, a
state machine, a timeline, a worked example), not a list of words; at most about twelve boxes, or panels (a), (b);
English only, and no model name. For a paper, convert an SVG to PDF with any vector tool (`rsvg-convert -f pdf`,
Inkscape, or a browser's print to PDF): the figures are vector drawings with no embedded fonts.

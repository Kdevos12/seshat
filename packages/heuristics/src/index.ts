/**
 * @seshat/heuristics: the bank of heuristic cards (documentation/heuristics.md). A heuristic is a
 * method of reasoning that says where to look, never a tool and never a fact. This package holds the
 * card format and its check, the closed vocabulary of families, the context features a card's `when`
 * reads (computed without a model), the built-in cards and the overlap check. The fleet draws the
 * cards (`@seshat/fleet`); packs add cards (`@seshat/registry`).
 */
export * from "./card.ts";
export * from "./features.ts";
export * from "./builtin.ts";
export * from "./bank.ts";

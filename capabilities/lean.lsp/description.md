Lean's language server on the file you are editing: the goals before and after a line, the expected type at a position, Lean's messages on the whole file, several tactics tried at one line, and searches of Mathlib. It answers quickly because it reads the file incrementally; `lean_check` stays the only judge, and nothing here is a proof.

The file is the sketch you edit with `lean_check`, with the regions of your last `lean_check` in it. Pass `aux` and `proof` (whole regions, as for `lean_check`) to look at other text without checking it. Lines count inside a region as `lean_check` counts them (`PROOF line 3`; give `region` for AUX). A column counts characters from 1 in the line as it stands in the file, where the proof's lines carry the indentation the harness adds (two spaces, usually); leave it out unless you need a position inside a line.

- `goal`: `line` alone gives the goals before and after that line; with `column`, the goals at that position. `complete` means the language server reports no goal left there (it is not a verdict); `no_goal_here` that the position has no proof state.
- `term_goal`: the type expected of the term at the position (the line's end without `column`).
- `diagnostics`: Lean's errors, warnings and messages on the whole file, or on one `region`; `severity` keeps one level.
- `multi_attempt`: `tactics` (up to 8) tried one by one at `line`. Each replaces the line from `column` (default: its first non-blank character) to its end, as many lines as it has lines, and must end inside the region; the characters of the line before `column` stay in front of it; nothing is saved. Each answer says `closed` (no goal left, no error), `open` (goals left, listed) or `error`. A tactic that Lean accepts here can still fail once it is part of the whole proof: check it with `lean_check`.
- `loogle`: Mathlib by name, type pattern or conclusion: `Nat.add_comm`, `(?a → ?b) → List ?a → List ?b`, `|- _ < _ → _ + 1 < _ + 1`.
- `leansearch`: Mathlib by what the lemma says, in English or in Lean.
- `state_search`: lemmas for the goal at the position (the line's first non-blank character without `column`), by Lean Finder. The goal's text is sent to it.
- `hammer_premise`: names of premises to try in `simp only [...]`, `aesop` or `grind` for the goal at the position.

The searches ask network sites (Loogle, LeanSearch, Lean Finder, a premise server) that limit their rate and are sometimes down: then the answer says `unavailable` and why, and the site is left alone for a minute; go on without it. Their indexes are snapshots of Mathlib and can name lemmas this project's Mathlib lacks, so try a name before you rely on it.

It refuses what `lean_check` refuses, for the regions and for the tactics, the tactics as the server will read them: joined to the characters of the line before `column`. It reads no other file, takes no path, builds nothing and runs no code.

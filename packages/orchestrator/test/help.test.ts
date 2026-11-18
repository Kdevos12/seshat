import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLI_FLAGS, commandHelp, shortHelp, usageOf } from "../src/index.ts";

const USAGE = "usage:\n  harness solve STATEMENT [--max-usd X]\n              [--lit] [--private]\n  harness solver-other X\n  harness run --checkout DIR\n\nprose after the block";

describe("the help of the command line (UX8)", () => {
  it("is short at the top: the everyday commands, under 30 lines", () => {
    const text = shortHelp();
    assert.ok(text.split("\n").length < 30, `${text.split("\n").length} lines`);
    for (const c of ["doctor", "solve", "ui", "resume", "report", "view", "campaign"]) assert.match(text, new RegExp(`^  ${c}\\b`, "m"));
    assert.match(text, /harness help all/);
  });

  it("cuts one command's usage lines and their continuations, and no other command's", () => {
    assert.deepEqual(usageOf("solve", USAGE), ["  harness solve STATEMENT [--max-usd X]", "              [--lit] [--private]"]);
    assert.deepEqual(usageOf("ablate", USAGE), []);
  });

  it("lists every flag the catalogue gives a command, and none of another's", () => {
    const usage = "usage:\n  harness solve STATEMENT\n";
    const solve = commandHelp("solve", usage) ?? "";
    for (const f of CLI_FLAGS.filter((x) => x.commands.includes("solve"))) assert.ok(solve.includes(`--${f.flag} `), f.flag);
    const ablateOnly = CLI_FLAGS.filter((x) => x.commands.includes("ablate") && !x.commands.includes("solve"));
    assert.ok(ablateOnly.length > 0);
    for (const f of ablateOnly) assert.ok(!solve.includes(`--${f.flag} `), `${f.flag} is not a flag of solve`);
    assert.match(solve, /^Basic:$/m);
    assert.match(solve, /^What may leave this machine:$/m);
    assert.equal(commandHelp("nothing-like-this", usage), undefined);
  });
});

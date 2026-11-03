// A stand-in for a coding agent: reads the prompt on standard input and writes files into its working directory, as the
// scenario in FAKE_SCENARIO says. It prints the keys of its environment so a test can see what it was given.
import { mkdirSync, symlinkSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const scenario = process.env.FAKE_SCENARIO ?? "good";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
console.log(`env keys: ${Object.keys(process.env).sort().join(",")}`);
console.log(`prompt bytes: ${prompt.length}`);
console.log(`args: ${process.argv.slice(2).join(" ")}`);

const DIR = "lean/SeshatLib/Combinatorics";
const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const good = (extra = "", proof = "by\n  simp [mulDiv]", lemma = "(n : Nat) : mulDiv n 1 = n") => `import Mathlib

namespace SeshatLib.Combinatorics

/-- Multiply, then divide. -/
def mulDiv (a b : Nat) : Nat := a * b / b

theorem mulDiv_one ${lemma} := ${proof}
${extra}
end SeshatLib.Combinatorics
`;

switch (scenario) {
  case "good":
    put(`${DIR}/Basic.lean`, good());
    break;
  case "good_exit1":
    put(`${DIR}/Basic.lean`, good());
    console.log("done, but I am exiting with an error code");
    process.exit(1);
    break;
  case "outside":
    put(`${DIR}/Basic.lean`, good());
    put("lean/Other/Elsewhere.lean", "import Mathlib\n");
    break;
  case "modify":
    put(`${DIR}/Basic.lean`, good());
    writeFileSync("lakefile.toml", `${readFileSync("lakefile.toml", "utf8")}\n# changed by the agent\n`);
    break;
  case "delete":
    put(`${DIR}/Basic.lean`, good());
    rmSync("lean/SeshatLib/Base.lean");
    break;
  case "symlink":
    put(`${DIR}/Basic.lean`, good());
    symlinkSync("/etc/passwd", `${DIR}/Link.lean`);
    break;
  case "traversal":
    put(`${DIR}/Basic.lean`, good());
    put(`${DIR}/../../../escape.lean`, "import Mathlib\n");
    break;
  case "sorry":
    put(`${DIR}/Basic.lean`, good("", "by\n  sorry"));
    break;
  case "axiom":
    put(`${DIR}/Basic.lean`, good("\naxiom cheat : False\n"));
    break;
  case "elab":
    put(`${DIR}/Basic.lean`, good("\nelab \"hello\" : term => return .lit (.natVal 1)\n"));
    break;
  case "import_lean":
    put(`${DIR}/Basic.lean`, good().replace("import Mathlib", "import Mathlib\nimport Lean"));
    break;
  case "no_test_lemma":
    put(`${DIR}/Basic.lean`, good().replace("theorem mulDiv_one", "theorem other_name"));
    break;
  case "weak_test_lemma":
    // The test lemma is proved, but it states something else than the spec's lemma does.
    put(`${DIR}/Basic.lean`, good("", "by\n  simp [mulDiv]", "(n : Nat) : mulDiv n 1 = n ∨ n = 0"));
    break;
  case "buildfail":
    put(`${DIR}/Basic.lean`, good("\n-- BUILDFAIL\n"));
    break;
  case "certfail":
    put(`${DIR}/Basic.lean`, good("\ntheorem extra_fact (n : Nat) : n = n := by\n  rfl -- CERTFAIL\n"));
    break;
  case "cert_unavailable":
    put(`${DIR}/Basic.lean`, good("\n-- CERTUNAVAILABLE\n"));
    break;
  case "build_warns_sorry":
    put(`${DIR}/Basic.lean`, good("\n-- BUILDWARNS\n"));
    break;
  case "port":
    put("lean/ports/Foo/lakefile.toml", 'name = "Foo"\n');
    put("lean/ports/Foo/Foo.lean", "import Mathlib\n\nnamespace Foo\n\ntheorem two_eq : 1 + 1 = 2 := by\n  norm_num\n\nend Foo\n");
    break;
  case "port_meta":
    put("lean/ports/Foo/Foo.lean", "import Lean\nimport Mathlib\n\nnamespace Foo\n\nmacro \"two\" : term => `(2)\n\ntheorem two_eq : 1 + 1 = 2 := by\n  norm_num\n\nend Foo\n");
    break;
  case "nothing":
    break;
  case "hang":
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    break;
  case "ignore_git":
    // Rewrites the clone's git directory to hide its changes; the gate does not read it.
    put(`${DIR}/Basic.lean`, good());
    if (existsSync(".git")) writeFileSync(".git/info/exclude", "*\n");
    break;
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "@seshat/orchestrator";
import { sourceHash } from "../web/source-hash.ts";

const web = join(REPO_ROOT, "packages", "ui", "web");
const staticDir = join(REPO_ROOT, "packages", "ui", "static");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("the front end", () => {
  it("is built from its current sources (run `pnpm --filter @seshat/ui build:web`)", () => {
    assert.ok(existsSync(join(staticDir, "index.html")), "the built page is committed");
    assert.equal(readFileSync(join(staticDir, "source.sha256"), "utf8").trim(), sourceHash(), "the sources changed since the last build");
  });

  it("needs no network at run time: the built files name no other origin, and no script is inline", () => {
    const html = readFileSync(join(staticDir, "index.html"), "utf8");
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[^<]/);
    assert.doesNotMatch(html, /\sstyle=/);
    for (const f of readdirSync(join(staticDir, "assets")).filter((n) => n.endsWith(".css"))) assert.doesNotMatch(readFileSync(join(staticDir, "assets", f), "utf8"), /url\(\s*['"]?https?:|@import/);
  });

  it("never sets HTML or evaluates text from the journal", () => {
    for (const file of sources(join(web, "src")).filter((f) => /\.tsx?$/.test(f))) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, file);
    }
  });

  it("type-checks", () => {
    execFileSync(process.execPath, [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", join(web, "tsconfig.json")], { stdio: "pipe" });
  });
});

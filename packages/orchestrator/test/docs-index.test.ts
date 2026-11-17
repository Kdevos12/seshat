import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "../src/index.ts";

const DOCS = join(REPO_ROOT, "documentation");
const index = readFileSync(join(DOCS, "README.md"), "utf8");

describe("the documentation's home page", () => {
  it("links every page of documentation/", () => {
    const pages = readdirSync(DOCS).filter((name) => name.endsWith(".md") && name !== "README.md");
    assert.ok(pages.length > 0);
    assert.deepEqual(
      pages.filter((name) => !new RegExp(`\\]\\(${name.replace(".", "\\.")}[#)]`).test(index)),
      [],
      "documentation/README.md must link every page (add it to the list of pages)",
    );
  });

  it("references only images that exist, and every image is used", () => {
    const used = [...index.matchAll(/\]\((images\/[^)]+)\)/g)].map((m) => m[1]!);
    assert.deepEqual(used.filter((path) => !existsSync(join(DOCS, path))), []);
    const images = readdirSync(join(DOCS, "images")).map((name) => `images/${name}`);
    assert.deepEqual(images.filter((path) => !used.includes(path)), [], "an image no page of the home lists");
  });
});

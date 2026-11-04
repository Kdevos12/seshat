import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "@seshat/orchestrator";
import { lockClosure, sourceHash } from "../web/source-hash.ts";

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

  it("makes no request to another origin: the bundle has no socket, beacon, event source or absolute fetch, and only namespace URLs", () => {
    for (const name of readdirSync(join(staticDir, "assets")).filter((n) => /\.(js|css)$/.test(n))) {
      const text = readFileSync(join(staticDir, "assets", name), "utf8");
      for (const api of ["XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "importScripts", "RTCPeerConnection"]) assert.equal(text.includes(api), false, `${name} uses ${api}`);
      const urls = new Set(text.match(/https?:\/\/[^\s"'`)\\]+/g) ?? []);
      const allowed = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml", "http://www.w3.org/1998/Math/MathML"]);
      for (const url of urls) assert.ok(allowed.has(url), `${name} names ${url}`);
      // Every fetch goes to a path on this server (a variable that api.ts only ever fills with "/api/...").
      for (const m of text.matchAll(/\bfetch\(([^,)]*)/g)) assert.doesNotMatch(m[1] as string, /^\s*["'`]\s*(https?:)?\/\//, `${name}: fetch(${m[1]})`);
    }
    const api = readFileSync(join(web, "src", "api.ts"), "utf8");
    for (const m of api.matchAll(/\b(?:fetch|follow|get|post)\(\s*[`"']([^`"']*)/g)) assert.match(m[1] as string, /^\/api\//, "front end calls only /api paths");
  });

  it("is the build of its sources, byte for byte (skipped when the build tool is absent)", (t) => {
    const vite = join(REPO_ROOT, "packages", "ui", "node_modules", "vite", "bin", "vite.js");
    if (!existsSync(vite)) return t.skip("vite is not installed");
    const out = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ui-rebuild-"));
    try {
      execFileSync(process.execPath, [vite, "build", "--config", join(web, "vite.config.ts"), "--outDir", out, "--emptyOutDir"], { cwd: join(REPO_ROOT, "packages", "ui"), stdio: "pipe" });
      const list = (dir: string) => sources(dir).map((f) => f.slice(dir.length)).sort();
      const built = list(out);
      assert.deepEqual(built, list(staticDir).filter((f) => f !== "/source.sha256"), "the same files");
      for (const f of built) assert.ok(readFileSync(join(out, f)).equals(readFileSync(join(staticDir, f))), `${f} differs from a fresh build`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("is pinned by the lockfile: the closure of the build libraries is read from it", () => {
    const closure = lockClosure(readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8"));
    for (const name of ["vite@8.3.5", "preact@10.29.8", "cytoscape@3.34.4"]) assert.ok(closure.includes(name), name);
    assert.match(closure, /integrity: sha512-/);
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

import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Journal } from "@seshat/core";
import { scriptedJournal } from "../../orchestrator/test/scripted-journal.ts";
import { tempDir } from "../../orchestrator/test/m0-helpers.ts";
import { FAKE_HARNESS, started, type Started, until } from "./helpers.ts";
import { STATIC_DIR } from "../src/index.ts";

/**
 * One smoke test in a real browser (headless Chromium through Playwright, when the machine has them): the page loads from the built files
 * under the content security policy, shows a recorded run and hostile text as text, and works at phone width in both colour schemes.
 * Screenshots go to SESHAT_UI_SHOTS (default a temporary directory).
 */
const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;

function playwright(): any {
  const require = createRequire(import.meta.url);
  try {
    return require("playwright");
  } catch {
    return undefined;
  }
}

const pw = playwright();
const open: Started[] = [];
after(async () => {
  for (const s of open) await s.server.close();
});

function hostileRun(runsDir: string): void {
  const dir = join(runsDir, "hostile");
  mkdirSync(dir, { recursive: true });
  const journal = Journal.open(dir, "run_hostile");
  journal.emit("run.started", { runId: "run_hostile", benchId: "hostile", problems: 1, host: "test", config: { budget: { problemUsd: 1, runUsd: 2 } } }, "orchestrator");
  journal.emit("claim.created", { claimId: "clm_hostile", statementId: "sid_h", statement: `${HOSTILE} (n : Nat) : n = n`, origin: "test", status: "open", kind: "formal" }, "memory");
  journal.close();
}

describe("the page in a real browser", { skip: pw === undefined ? "Playwright is not installed here" : false }, () => {
  it("loads under the policy, shows runs and hostile text as text, and fits a phone in light and dark", async () => {
    const shots = process.env.SESHAT_UI_SHOTS ?? tempDir("ui-shots-");
    mkdirSync(shots, { recursive: true });
    const s = await started({ staticDir: STATIC_DIR, env: { PATH: process.env.PATH ?? "", FAKE_HOSTILE: "1" } });
    open.push(s);
    const scripted = scriptedJournal();
    scripted.journal.close();
    cpSync(scripted.dir, join(s.runsDir, "recorded"), { recursive: true });
    hostileRun(s.runsDir);

    const browser = await pw.chromium.launch();
    const problems: string[] = [];
    try {
      for (const scheme of ["light", "dark"] as const) {
        for (const [name, viewport] of [["desktop", { width: 1100, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
          const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 1 });
          const page = await context.newPage();
          page.on("pageerror", (e: Error) => problems.push(`${name}/${scheme} page error: ${e.message}`));
          page.on("console", (m: any) => {
            if (m.type() === "error" || /content security policy/i.test(m.text())) problems.push(`${name}/${scheme} console: ${m.text()}`);
          });
          await page.goto(s.server.url);
          await page.waitForSelector("h1");
          assert.match(await page.textContent("h1"), /Give Seshat a problem/);
          await page.screenshot({ path: join(shots, `start-${name}-${scheme}.png`), fullPage: true });

          await page.goto(`${s.server.origin}/#/run/recorded`);
          await page.waitForSelector(".status .line");
          await page.waitForSelector("#graph canvas");
          const body = await page.textContent("body");
          assert.match(body, /Refuted/);
          assert.match(body, /Where it stands/);
          assert.match(body, /Research graph/);
          await page.screenshot({ path: join(shots, `run-${name}-${scheme}.png`), fullPage: true });
          const overflow = await page.evaluate("document.documentElement.scrollWidth - window.innerWidth");
          assert.ok(overflow <= 0, `${name}/${scheme}: the page scrolls sideways by ${overflow}px`);

          await page.goto(`${s.server.origin}/#/run/hostile`);
          await page.waitForSelector("text=Where it stands");
          await page.waitForSelector("#graph canvas");
          await page.click("summary:has-text('The same graph as tables')");
          assert.ok((await page.textContent("body")).includes("<img src=x onerror="), "the hostile text is on the page as text");
          assert.equal(await page.evaluate("window.__pwned"), undefined, "no script of the journal ran");
          assert.equal(await page.locator('img[src="x"]').count(), 0, "no element came out of the journal's text");
          assert.equal(await page.locator("body script").count(), 0);
          await page.screenshot({ path: join(shots, `hostile-${name}-${scheme}.png`), fullPage: true });

          await page.goto(`${s.server.origin}/#/doctor`);
          await page.waitForSelector(".check");
          await page.screenshot({ path: join(shots, `doctor-${name}-${scheme}.png`), fullPage: true });
          await page.goto(`${s.server.origin}/#/settings`);
          await page.waitForSelector("text=Model providers");
          await page.waitForSelector(".card li");
          await page.screenshot({ path: join(shots, `settings-${name}-${scheme}.png`), fullPage: true });
          assert.ok((await page.evaluate("document.documentElement.scrollWidth - window.innerWidth")) <= 0, `${name}/${scheme}: settings scroll sideways`);
          await context.close();
        }
      }

      // The whole road on a phone: write a statement, see it to sign beside its words, sign, watch it work, stop it.
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.on("pageerror", (e: Error) => problems.push(`road page error: ${e.message}`));
      await page.goto(s.server.url);
      await page.fill("#statement", "Every number equals itself.");
      await page.fill("#ceiling", "1.5");
      await page.click("button:has-text('Prepare the statement')");
      await page.waitForSelector("text=Does this say what you mean?", { timeout: 6000 }).catch(async (e: Error) => { await page.screenshot({ path: join(shots, "road-fail.png") }); throw new Error(`${e.message} at ${page.url()}: ${(await page.textContent("body"))?.slice(0, 300)}`); });
      await page.screenshot({ path: join(shots, "signature-phone.png"), fullPage: true });
      const text = await page.textContent("body");
      assert.ok(text.includes('<img src=x onerror="window.__pwned=1">'), "the words are shown as text");
      assert.match(text, /already charged to your allowance/);
      assert.equal(await page.evaluate("window.__pwned"), undefined);
      assert.equal(await page.locator('img[src="x"]').count(), 0);
      await page.click("button:has-text('Yes, sign it and start')");
      await page.waitForSelector("text=signed: working");
      await page.screenshot({ path: join(shots, "working-phone.png"), fullPage: true });
      await page.click("button:has-text('Stop')");
      await page.waitForSelector("text=Stopped by you");

      // A key is saved from the page and is never shown again.
      await page.goto(`${s.server.origin}/#/settings`);
      await page.waitForSelector(".card li");
      const KEY = "sk-browser-0123456789-never-shown";
      await page.locator("button:has-text('Add key')").first().click();
      await page.fill("input[type=password]", KEY);
      await page.click("button:has-text('Save')");
      await page.waitForSelector("button:has-text('Remove key')");
      assert.equal((await page.content()).includes(KEY), false);
      assert.equal(await page.locator("input[type=password]").count(), 0);
      await context.close();
    } finally {
      await browser.close();
    }
    assert.deepEqual(problems, []);
    const made = readdirSync(shots).filter((f) => f.endsWith(".png"));
    assert.ok(made.length >= 16);
    for (const f of made) assert.ok(statSync(join(shots, f)).size > 2000, `${f} is not blank`);
    void FAKE_HARNESS;
    void until;
    void writeFileSync;
  });
});

import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  it("draws the settings panel from the catalogue: a section per group, advanced ones behind a disclosure, badges, defaults as placeholders, and sends only what was filled in", async () => {
    const shots = process.env.SESHAT_UI_SHOTS ?? tempDir("ui-shots-");
    mkdirSync(shots, { recursive: true });
    const s = await started({ staticDir: STATIC_DIR });
    open.push(s);
    const catalogue = (await s.call("GET", "/api/parameters?command=solve")).json() as { groups: Array<{ id: string }>; parameters: Array<{ key: string; group: string; ui: string; status: string; default: string; solveFlag?: string; solveDefault?: string }> };
    const forSolve = catalogue.parameters.filter((p) => p.solveFlag === undefined);
    const groups = catalogue.groups.map((g) => g.id).filter((g) => forSolve.some((p) => p.group === g));
    const browser = await pw.chromium.launch();
    try {
      const page = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
      const problems: string[] = [];
      page.on("pageerror", (e: Error) => problems.push(e.message));
      // A stored key: the form says what the ceiling buys with the model solve would choose (UX10).
      assert.equal((await s.call("PUT", "/api/providers/deepseek/key", { key: "test-key-not-real-0001" })).status, 200);
      await page.goto(s.server.url);
      await page.waitForSelector("fieldset.group", { state: "attached" });
      await page.waitForSelector("#estimate", { timeout: 6000 });
      assert.match(await page.textContent("#estimate"), /^Estimate: \$2 buys about .* of deepseek\/.*The model chosen for you: deepseek\//);
      await page.fill("#ceiling", "4");
      await page.waitForSelector("#estimate:has-text('$4 buys')", { timeout: 6000 });
      assert.deepEqual(await page.locator("fieldset.group").evaluateAll((l: any[]) => l.map((e) => e.getAttribute("data-group"))), groups, "one section per group, in the catalogue's order");
      for (const p of forSolve) assert.equal(await page.locator(`#setting-${p.key}`).count(), 1, `${p.key} has a field`);
      assert.equal(await page.locator("#setting-budget").count(), 0, "a setting that solve takes from its own field is not offered");
      assert.equal(await page.locator("input[name=outside]").count(), 3, "what may leave the machine: three choices (UX6)");
      assert.equal(await page.locator("input[name=outside]").first().isChecked(), true, "the model's provider only, by default");
      // UX15: "Let it run for days" opens the pace and the end of a campaign.
      assert.equal(await page.locator("#usd-per-day").count(), 0);
      await page.check("#days");
      assert.equal((await page.locator("#usd-per-day").count()) + (await page.locator("#until").count()), 2);
      await page.uncheck("#days");
      const advanced = forSolve.filter((p) => p.ui === "advanced");
      assert.equal(await page.locator("details > .setting, details .setting").count() >= advanced.length, true);
      assert.ok((await page.locator(".badge.experimental").count()) >= 1 && (await page.locator(".badge.beta").count()) >= 1, "beta and experimental badges");
      // The panel configures a solve: the placeholder is what solve applies (budgetShare 2 under v2), marked, not the RunConfig default.
      assert.equal(forSolve.find((p) => p.key === "budgetShare")?.solveDefault, "2");
      assert.equal(await page.getAttribute("#setting-budgetShare", "placeholder"), "2", "the value solve applies is the placeholder");
      assert.match(await page.locator("label[for=setting-budgetShare] .solve-default").textContent(), /v2/, "and it is marked");
      // UX9: the whole panel is folded under one disclosure, the keys read as words, a flat JSON setting gets typed fields.
      assert.equal(await page.locator("details.settings-all").evaluate((e: any) => e.open), false, "the settings start folded");
      assert.match(await page.locator("details.settings-all > summary").textContent(), /^Advanced settings$/);
      assert.match(await page.locator("label[for=setting-budgetShare] .setting-name").textContent(), /^Budget share$/);
      // Open the panel and every "More", fill one number, one switch and one sub-field; the rest stay empty.
      await page.click("details.settings-all > summary");
      for (const d of await page.locator("fieldset.group details").all()) await d.evaluate((e: any) => (e.open = true));
      await page.fill("#setting-budgetShare", "3");
      await page.selectOption("#setting-triage", "true");
      await page.fill("#setting-sorryBattery-maxSorries", "4");
      assert.match(await page.locator("details.settings-all > summary").textContent(), /\(3 changed\)/, "the summary counts the changed settings");
      await page.screenshot({ path: join(shots, "settings-panel.png"), fullPage: false });
      await page.fill("#statement", "Every number equals itself.");
      await page.click("button:has-text('Prepare the statement')");
      await page.waitForSelector("text=Does this say what you mean?", { timeout: 6000 });
      const jobs = (await s.call("GET", "/api/jobs")).json().jobs as Array<{ command: string[] }>;
      const file = jobs[0]?.command.find((a) => a.startsWith("--settings="))?.slice("--settings=".length);
      assert.ok(file, "the start request carried the settings");
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { budgetShare: 3, triage: true, sorryBattery: { maxSorries: 4 } }, "only the filled-in fields, the sub-field as JSON");
      assert.deepEqual(problems, []);
    } finally {
      await browser.close();
    }
  });

  it("loads under the policy, shows runs and hostile text as text, and fits a phone in light and dark", async () => {
    const shots = process.env.SESHAT_UI_SHOTS ?? tempDir("ui-shots-");
    mkdirSync(shots, { recursive: true });
    const s = await started({ staticDir: STATIC_DIR, env: { PATH: process.env.PATH ?? "", FAKE_HOSTILE: "1" } });
    open.push(s);
    const scripted = scriptedJournal();
    scripted.journal.close();
    cpSync(scripted.dir, join(s.runsDir, "recorded"), { recursive: true });
    // UX15: a campaign's digest is shown on its run page, with "Continue the campaign".
    mkdirSync(join(s.runsDir, "recorded", "campaign"), { recursive: true });
    writeFileSync(join(s.runsDir, "recorded", "campaign", "digest.md"), "# Campaign digest\n\nTurn 3 ended: the frontier grew by one lemma.\n");
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
          assert.ok((await page.evaluate("document.documentElement.scrollWidth - window.innerWidth")) <= 0, `${name}/${scheme}: the start page, with its settings, scrolls sideways`);

          await page.goto(`${s.server.origin}/#/run/recorded`);
          await page.waitForSelector(".status .line");
          await page.waitForSelector("#graph canvas");
          const body = await page.textContent("body");
          assert.match(body, /Refuted/);
          assert.match(body, /Where it stands/);
          assert.match(body, /Research graph/);
          // UX4 and UX5: statements in place of claim ids, and the header with the phase.
          assert.match(await page.locator(".chip.phase").textContent(), /Paused: it waits for you/);
          assert.match(body, /Proof: Part A: the base case holds/);
          assert.match(body, /The campaign's digest[^]*Turn 3 ended: the frontier grew by one lemma\./);
          assert.equal(await page.locator("button:has-text('Continue the campaign')").count(), 1);
          assert.doesNotMatch(await page.locator("#hint-claim").textContent(), /clm_/, "the claim choices are words, not ids");
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
          // UX11: the doctor's marks are styles, not characters; a command has a copy button; a missing key links to the Providers page.
          assert.doesNotMatch(await page.locator(".card").textContent(), /\*\*|`/, "no literal ** or backtick on the Checklist");
          assert.ok((await page.locator(".check .command button:has-text('Copy')").count()) >= 1, "a command can be copied");
          assert.equal(await page.locator("a.button[href='#/settings']").count(), 1, "a missing key links to the Providers page");
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
      assert.match(await page.locator(".chip.phase").textContent(), /Waiting for your signature/, "the header says the phase");
      await page.click("button:has-text('Yes, sign it and start')");
      // The command's raw output is folded by default (UX5); it is still on the page.
      await page.waitForSelector("text=signed: working", { state: "attached" });
      await page.click("summary:has-text('What the command says')");
      await page.waitForSelector("text=signed: working");
      assert.doesNotMatch(await page.textContent("body"), /The run has not started yet/);
      await page.screenshot({ path: join(shots, "working-phone.png"), fullPage: true });
      await page.click("button:has-text('Stop')");
      await page.waitForSelector("text=Stopped by you");

      // UX11: a host profile that recommends a provider puts it first; the shipped ones recommend none (the doctor test checks them).
      const profilePath = join(s.dir, "config-dir", "hosts", "local.json");
      writeFileSync(profilePath, JSON.stringify({ ...JSON.parse(readFileSync(profilePath, "utf8")), recommended: ["deepseek/*"] }));
      // A key is saved from the page and is never shown again.
      await page.goto(`${s.server.origin}/#/settings`);
      await page.waitForSelector(".card li");
      assert.match(await page.locator("[data-part=recommended]").textContent(), /Recommended for cost[^]*deepseek[^]*From \$[\d.]+ per million tokens/);
      assert.equal(await page.locator("details[data-part=others]").evaluate((e: any) => e.open), false, "the other providers are folded");
      const KEY = "sk-browser-0123456789-never-shown";
      await page.locator("button:has-text('Add key')").first().click();
      await page.fill("input[type=password]", KEY);
      await page.click("button:has-text('Save')");
      await page.waitForSelector("button:has-text('Remove key')");
      assert.match(await page.locator("[data-part=ready]").textContent(), /With credentials[^]*deepseek/, "a provider with a key comes first");
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

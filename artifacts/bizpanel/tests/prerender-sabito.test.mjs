import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer";
import { serializePublicDocument } from "../prerender-sanitize.mjs";

test("SEO serialization removes visitor/member runtime widgets but preserves the app and SEO content", async () => {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
    execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
  const browser = await puppeteer.launch({
    executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", request => void request.abort());
    for (const mode of ['data-project-id="public-project"', 'data-session-url="/api/sabito/session"']) {
      await page.setContent(`<!DOCTYPE html><html><head>
        <title>Buzz Booster</title><meta name="description" content="SEO content">
        <script type="application/ld+json">{"@type":"Organization","name":"Buzz Booster"}</script>
        <script type="module" src="/assets/index.fixture.js"></script>
        </head><body><div id="root"><h1>Abonnés, likes et vues</h1></div>
        <script id="buzzbooster-sabito-widget" src="https://sabito.bizconnectacademy.com/widget/sabito-chat.js" ${mode}></script>
        <script src="https://sabito.bizconnectacademy.com/widget/sabito-chat.js?version=old"></script>
        <div data-sabito-widget><button>Sabito AI</button></div>
        <iframe src="https://sabito.bizconnectacademy.com/widget/chat?parentOrigin=https://example.test"></iframe>
        </body></html>`, { waitUntil: "domcontentloaded" });
      const html = await page.evaluate(serializePublicDocument, await page.evaluateHandle(() => document));
      assert.match(html, /<h1>Abonnés, likes et vues<\/h1>/);
      assert.match(html, /application\/ld\+json/);
      assert.match(html, /<script type="module" src="\/assets\/index.fixture.js"><\/script>/);
      assert.match(html, /<meta name="description" content="SEO content">/);
      assert.ok(!html.includes("sabito-chat.js"));
      assert.ok(!html.includes("data-sabito-widget"));
      assert.ok(!html.includes("buzzbooster-sabito-widget"));
      assert.ok(!html.includes("data-project-id"));
      assert.ok(!html.includes("data-session-url"));
      assert.ok(!html.includes("/widget/chat?"));
      // Serialization works on a copy, never mutating the live page.
      assert.equal(await page.$eval("#buzzbooster-sabito-widget", node => !!node), true);
    }
  } finally {
    await browser.close();
  }
});

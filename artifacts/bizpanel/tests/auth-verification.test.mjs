import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { createServer } from "vite";

// A private Vite instance, not the preview/API workflows: no request can send mail.
process.env.PORT ||= "3000";
process.env.BASE_PATH = "/";
const vite = await createServer({
  configFile: new URL("../vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0 },
});
await vite.listen();
after(() => vite.close());
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;

function chromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable"]) {
    try { return execFileSync("which", [name], { encoding: "utf8" }).trim(); } catch {}
  }
  // Replit's Nix Chromium can be installed without being on PATH.
  if (existsSync("/nix/store")) {
    const candidates = readdirSync("/nix/store")
      .filter(name => /-chromium-\d/.test(name))
      .sort((a, b) => Number(b.match(/-chromium-(\d+)/)[1]) - Number(a.match(/-chromium-(\d+)/)[1]));
    for (const name of candidates) {
      const binary = path.join("/nix/store", name, "bin/chromium");
      if (existsSync(binary)) return binary;
    }
  }
  return undefined; // Puppeteer's own Chromium on non-Nix hosts.
}

const executablePath = chromePath();
const browser = await puppeteer.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
after(() => browser.close());

const email = "fresh@example.com";
const password = "previously-entered-password";
const user = { id: "test-user", email, isAdmin: false, profile: { country: "CI", username: "newmember" } };

async function scenario({ failAutomaticLogin }) {
  const page = await browser.newPage();
  const calls = [];
  let confirmed = false;
  let authenticated = false;
  let loginAttempts = 0;
  try {
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.origin !== origin || !url.pathname.startsWith("/api/")) {
        request.continue();
        return;
      }
      const route = url.pathname;
      const body = request.postData() ? JSON.parse(request.postData()) : null;
      calls.push({ route, body, confirmedAtRequest: confirmed });
      let status = 200;
      let response = {};
      if (route === "/api/auth/me") {
        if (authenticated) response = { user };
        else { status = 401; response = { error: "Non connecté" }; }
      } else if (route === "/api/auth/login") {
        loginAttempts++;
        assert.deepEqual(body, { email, password }, "both login attempts use the entered credentials");
        if (!confirmed) {
          status = 403;
          response = { code: "EMAIL_VERIFICATION_REQUIRED", error: "Confirmez votre adresse" };
        } else if (failAutomaticLogin && loginAttempts === 2) {
          status = 401;
          response = { error: "Connexion impossible" };
        } else {
          authenticated = true;
          response = { user };
        }
      } else if (route === "/api/auth/verify-email") {
        assert.deepEqual(body, { email, code: "123456" });
        confirmed = true;
        response = { message: "Adresse vérifiée" };
      } else if (route === "/api/auth/resend-verification" || route === "/api/auth/register") {
        throw new Error(`Unexpected notification-producing request: ${route}`);
      }
      request.respond({ status, contentType: "application/json", body: JSON.stringify(response) });
    });
    await page.goto(`${origin}/auth`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[placeholder="Email"]');
    await page.type('input[placeholder="Email"]', email);
    await page.type('input[placeholder="Mot de passe"]', password);
    await page.locator('form:has(input[placeholder="Email"]) button[type="submit"]').click();
    await page.waitForSelector("#email-otp");
    assert.equal(page.url(), `${origin}/auth`, "the OTP screen must not navigate to the dashboard");
    assert.equal(authenticated, false, "denied login has no session");
    assert.equal(loginAttempts, 1);
    assert.ok(calls.some(call => call.route === "/api/auth/me"), "auth provider checks for a session");
    assert.deepEqual(
      await page.evaluate(() => [localStorage.getItem("password"), sessionStorage.getItem("password")]),
      [null, null],
      "the password stays out of browser storage",
    );
    await page.type("#email-otp", "123456");
    await page.locator('form:has(#email-otp) button[type="submit"]').click();
    await page.waitForFunction(() =>
      location.pathname === "/dashboard" || !!document.querySelector('input[placeholder="Email"]'),
    );
    assert.equal(confirmed, true, "verification remains successful independent of login");
    assert.deepEqual(
      calls.filter(call => ["/api/auth/login", "/api/auth/verify-email"].includes(call.route))
        .map(call => call.route),
      ["/api/auth/login", "/api/auth/verify-email", "/api/auth/login"],
      "verification must precede the second credential-based login",
    );
    if (failAutomaticLogin) {
      assert.equal(page.url(), `${origin}/auth`);
      assert.equal(authenticated, false);
      assert.match(await page.$eval('[role="status"]', element => element.textContent), /Adresse confirmée.*Connectez-vous/);
      assert.equal(await page.$eval('input[placeholder="Email"]', input => input.value), email);
      assert.equal(await page.$eval('input[placeholder="Mot de passe"]', input => input.value), "");
      await page.type('input[placeholder="Mot de passe"]', password);
      await page.locator('form:has(input[placeholder="Email"]) button[type="submit"]').click();
      await page.waitForFunction(() => location.pathname === "/dashboard");
      assert.equal(loginAttempts, 3, "the fallback login form can actually be submitted");
    } else {
      await page.waitForFunction(() => location.pathname === "/dashboard");
      assert.equal(loginAttempts, 2);
    }
    await page.waitForFunction(() => [...document.querySelectorAll("nav button")].some(button => button.textContent.includes("Tableau de bord")));
    assert.equal(authenticated, true);
    assert.ok(calls.some(call => call.route === "/api/auth/me" && call.confirmedAtRequest), "the session is refreshed after login");
  } finally {
    await page.close();
  }
}

test("unverified login shows OTP without session, then signs in with the original password", async () => {
  await scenario({ failAutomaticLogin: false });
});

test("failed automatic sign-in keeps email confirmed and offers a working login form", async () => {
  await scenario({ failAutomaticLogin: true });
});
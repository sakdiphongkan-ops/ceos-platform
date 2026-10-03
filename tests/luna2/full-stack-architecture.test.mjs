import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const baseUrl = process.env.LUNA_BASE_URL?.replace(/\/$/, "");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

async function get(pathname, init = {}) {
  if (!baseUrl) return null;
  return fetch(baseUrl + pathname, {
    redirect: "manual",
    ...init,
    headers: { "accept": "application/json", ...(init.headers ?? {}) },
  });
}

test("8. API integration: public contracts declare JSON responses and explicit error states", () => {
  const me = read("app/api/luna2/me/route.ts");
  const plans = read("app/api/luna2/plans/route.ts");
  const capabilities = read("app/api/luna2/capabilities/route.ts");
  const clientErrors = read("app/api/luna2/client-errors/route.ts");

  assert.match(me, /status:\s*401/);
  assert.match(me, /status:\s*503/);
  assert.match(me, /Cache-Control.*no-store/);
  assert.match(plans, /currency:\s*"THB"/);
  assert.match(plans, /liveMoney:\s*false/);
  assert.match(capabilities, /contractVersion/);
  assert.match(capabilities, /liveMoney:\s*false/);
  assert.match(clientErrors, /status:\s*400/);
  assert.match(clientErrors, /status:\s*413/);
  assert.match(clientErrors, /status:\s*429/);
  assert.match(clientErrors, /Retry-After/);
});

test("8. API integration: runtime smoke validates payloads and HTTP statuses when LUNA_BASE_URL is supplied", async (t) => {
  if (!baseUrl) return t.skip("Set LUNA_BASE_URL for live integration smoke.");
  const plans = await get("/api/luna2/plans");
  assert.equal(plans.status, 200);
  const plansJson = await plans.json();
  assert.equal(plansJson.ok, true);
  assert.equal(plansJson.currency, "THB");
  assert.ok(Array.isArray(plansJson.plans));
  assert.ok(plansJson.plans.every((p) => typeof p.code === "string" && typeof p.name === "string"));

  const capabilities = await get("/api/luna2/capabilities");
  assert.equal(capabilities.status, 200);
  const caps = await capabilities.json();
  assert.equal(caps.ok, true);
  assert.equal(caps.architecture, "LUNA 2.0");
  assert.equal(caps.execution.liveMoney, false);

  const me = await get("/api/luna2/me");
  assert.ok([401, 503].includes(me.status), "Unauthenticated access must fail closed.");

  const unsupportedMethod = await get("/api/luna2/plans", { method: "POST" });
  assert.ok([405, 404].includes(unsupportedMethod.status));

  const notFound = await get("/api/luna2/this-route-does-not-exist");
  assert.equal(notFound.status, 404);
});

test("8. API integration: rate-limit contract has an executable target hook", async (t) => {
  const target = process.env.LUNA_RATE_LIMIT_TEST_URL?.replace(/\/$/, "");
  if (!target) return t.skip("Set LUNA_RATE_LIMIT_TEST_URL to the endpoint under a rate-limit policy.");

  let saw429 = false;
  for (let i = 0; i < 30; i += 1) {
    const response = await fetch(target, {
      method: "POST",
      body: JSON.stringify({ source: "test", message: "rate-limit probe" }),
      headers: { "content-type": "application/json" },
    });
    if (response.status === 429) {
      saw429 = true;
      assert.ok(response.headers.get("retry-after"));
      break;
    }
  }
  assert.equal(saw429, true, "Rate-limited endpoints must eventually return 429 with Retry-After.");
});

test("9. Auth/session/RBAC: guest boundary and logout contracts are explicit", () => {
  const middleware = read("middleware.ts");
  const login = read("app/luna/login/page.tsx");
  const account = read("app/luna/account/page.tsx");
  const me = read("app/api/luna2/me/route.ts");
  const rbac = read("lib/luna2/rbac.ts");

  assert.match(middleware, /\/luna\/account/);
  assert.match(middleware, /\/luna\/login/);
  assert.match(login, /signInWithPassword/);
  assert.match(login, /signInWithOAuth/);
  assert.match(account, /auth\.signOut\(\{ scope: "global" \}\)/);
  assert.match(me, /authenticated:\s*false/);
  assert.match(rbac, /GUEST.*USER.*ADMIN/s);
  assert.match(rbac, /LIVE_MONEY_EXECUTE/);
  assert.match(rbac, /if \(permission === "LIVE_MONEY_EXECUTE"\) return false/);
});

test("9. Auth/session: production guest redirect is verified when LUNA_BASE_URL is supplied", async (t) => {
  if (!baseUrl) return t.skip("Set LUNA_BASE_URL for auth boundary smoke.");
  const response = await get("/luna/account");
  assert.ok([307, 308].includes(response.status), "Guest must be redirected by middleware.");
  const location = response.headers.get("location") ?? "";
  assert.match(location, /\/luna\/login/);
});

test("10. Cross-browser architecture: login avoids mobile viewport zoom and layout hazards", () => {
  const login = read("app/luna/login/page.tsx");
  assert.match(login, /min-h-\[calc\(100dvh-4rem\)\]/);
  assert.match(login, /text-\[16px\].*autoComplete="email"/s);
  assert.match(login, /text-\[16px\].*autoComplete=\{mode === "signin" \? "current-password" : "new-password"\}/s);
});

test("11. Observability: global handlers exist and error payload is sanitized", () => {
  const client = read("lib/luna2/observability-client.ts");
  const globalError = read("app/global-error.tsx");
  const boundary = read("app/error.tsx");
  const endpoint = read("app/api/luna2/client-errors/route.ts");

  assert.match(client, /unhandledrejection/);
  assert.match(client, /reportClientError/);
  assert.match(globalError, /reportClientError/);
  assert.match(boundary, /reportClientError/);
  assert.match(endpoint, /\[redacted\]/);
  assert.doesNotMatch(endpoint, /console\.log/);
});

test("11. Observability: source logging cannot directly print credential-bearing fields", () => {
  const bad = [];
  const sensitive = /(password|passcode|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|cookie|session_token)/i;

  function walk(dir) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        const text = read(relative);
        text.split(/\r?\n/).forEach((line, index) => {
          if (/console\.(log|error|warn|info|debug)\s*\(/.test(line) && sensitive.test(line)) {
            bad.push(relative + ":" + (index + 1) + " -> " + line.trim());
          }
        });
      }
    }
  }

  walk("app");
  walk("lib");
  assert.deepEqual(bad, []);
});


test("5. Security configuration: OAuth callback rejects cross-origin redirects", () => {
  const callback = read("app/auth/callback/route.ts");
  assert.match(callback, /candidate\.origin !== origin/);
  assert.match(callback, /new URL\(next, url\.origin\)/);
});

test("5. Security configuration: baseline response headers are defined", () => {
  const config = read("next.config.mjs");
  for (const header of [
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Strict-Transport-Security",
  ]) {
    assert.match(config, new RegExp(header));
  }
});

test("8. API integration/security: expensive backtests fail closed and rate limit", () => {
  const routes = [
    ["app/api/backtest/ceos-snapshot/route.ts", "ceos-snapshot"],
    ["app/api/backtest/multitimeframe/route.ts", "multitimeframe"],
    ["app/api/backtest/tournament100/route.ts", "tournament100"],
    ["app/api/backtest/walkforward60/route.ts", "walkforward60"],
    ["app/api/backtest/yahoo/route.ts", "yahoo"],
  ];

  for (const [file, bucket] of routes) {
    const source = read(file);
    assert.match(source, /requireBacktestAccess/);
    assert.match(source, new RegExp(bucket));
  }
});

test("11. Observability/security: client telemetry redacts common PII classes", () => {
  const endpoint = read("app/api/luna2/client-errors/route.ts");
  assert.match(endpoint, /email-redacted/);
  assert.match(endpoint, /phone-redacted/);
  assert.match(endpoint, /session/);
});


test("4. Accessibility source contract: interactive portfolio rows have keyboard activation", () => {
  const page = read("app/luna/page.tsx");
  assert.match(page, /tabIndex=\{0\}/);
  assert.match(page, /aria-selected=/);
  assert.match(page, /onKeyDown=\{\(event\)=>\{if\(event\.key==="Enter"\|\|event\.key===" "/);
});

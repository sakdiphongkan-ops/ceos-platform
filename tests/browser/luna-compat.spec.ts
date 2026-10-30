import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("LUNA cross-browser compatibility", () => {
  test("core pages render without horizontal overflow", async ({ page }) => {
    for (const route of ["/luna", "/luna/login"]) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.locator("body")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });

  test("login translates invalid credentials and callback failures into actionable messages", async ({ page }) => {
    await page.route(/\/auth\/v1\/token\?grant_type=password/, async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ code: "invalid_credentials", message: "Invalid login credentials" }),
      });
    });
    await page.goto("/luna/login", { waitUntil: "domcontentloaded" });
    await page.locator('input[autocomplete="email"]').fill("trader@example.com");
    await page.locator('input[autocomplete="current-password"]').fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator('main [role="alert"]')).toContainText("อีเมลหรือรหัสผ่านไม่ถูกต้อง");

    await page.goto("/luna/login?error=auth_callback_failed", { waitUntil: "domcontentloaded" });
    await expect(page.locator('main [role="alert"]')).toContainText("ยืนยันตัวตนไม่สำเร็จ");
  });

  test("login uses email/password only while Google sign-in is temporarily removed", async ({ page }) => {
    await page.goto("/luna/login", { waitUntil: "domcontentloaded" });

    await expect(page.locator('input[autocomplete="email"]')).toBeVisible();
    await expect(page.locator('input[autocomplete="current-password"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create a new LUNA account" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Google/i })).toHaveCount(0);
    await expect(page.getByText(" OR ", { exact: true })).toHaveCount(0);
  });

  test("email sign-up returns through the LUNA callback after confirmation", async ({ page }) => {
    let redirectTo: string | null = null;
    await page.route("**/auth/v1/signup**", async (route) => {
      redirectTo = new URL(route.request().url()).searchParams.get("redirect_to");
      const now = "2026-10-29T00:00:00.000Z";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "test-user-id",
          aud: "authenticated",
          role: "authenticated",
          email: "trader@example.com",
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: {},
          identities: [{
            identity_id: "test-user-identity",
            id: "trader@example.com",
            user_id: "test-user-id",
            identity_data: { email: "trader@example.com", sub: "test-user-id" },
            provider: "email",
            created_at: now,
            updated_at: now,
          }],
          created_at: now,
          updated_at: now,
        }),
      });
    });

    await page.goto("/luna/login?mode=signup&next=%2Fluna", { waitUntil: "domcontentloaded" });
    const appOrigin = new URL(page.url()).origin;
    await expect(page.getByRole("heading", { name: "Create your account." })).toBeVisible();
    await page.locator('input[autocomplete="email"]').fill("trader@example.com");
    await page.locator('input[autocomplete="new-password"]').fill("valid-test-password");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.locator('main [role="status"]')).toContainText("กรุณาตรวจสอบอีเมล");
    expect(redirectTo).not.toBeNull();
    const redirect = new URL(redirectTo!);
    expect(redirect.origin).toBe(appOrigin);
    expect(redirect.pathname).toBe("/auth/callback");
    expect(redirect.searchParams.get("next")).toBe("/luna");
  });

  test("historical candle authentication error offers the LUNA sign-in path", async ({ page }) => {
    await page.route("**/api/luna/market-bars**", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "AUTHENTICATION_REQUIRED" }),
      });
    });
    await page.goto("/luna", { waitUntil: "domcontentloaded" });
    const signIn = page.getByRole("link", { name: "Sign in to LUNA" });
    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveAttribute("href", "/luna/login?next=%2Fluna");
    const createAccount = page.getByRole("link", { name: "Create a LUNA account" });
    await expect(createAccount).toBeVisible();
    await expect(createAccount).toHaveAttribute("href", "/luna/login?mode=signup&next=%2Fluna");
  });

  test("login controls remain touch-friendly and keyboard-safe", async ({ page }) => {
    await page.goto("/luna/login", { waitUntil: "domcontentloaded" });
    const inputs = page.locator("input");
    await expect(inputs).toHaveCount(2);

    for (const i of [0, 1]) {
      const input = inputs.nth(i);
      const fontSize = await input.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
      expect(fontSize).toBeGreaterThanOrEqual(16);
    }

    const buttons = page.locator("button");
    for (let i = 0; i < await buttons.count(); i += 1) {
      const box = await buttons.nth(i).boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(44);
    }

    await inputs.first().focus();
    await expect(inputs.first()).toBeFocused();
  });

  test("client error telemetry sanitizes exception details", async ({ page }) => {
    const reports = [];
    await page.route("**/api/luna2/client-errors", async (route) => {
      reports.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true, accepted: true }) });
    });

    await page.goto("/luna", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as Window & { __lunaObservabilityReady?: boolean }).__lunaObservabilityReady === true);
    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent("error", { message: "password=super-secret access_token=should-not-leak" }));
      const rejection = new Event("unhandledrejection");
      Object.defineProperty(rejection, "reason", { value: new Error("refresh_token=should-not-leak") });
      window.dispatchEvent(rejection);
    });

    await page.waitForTimeout(250);
    expect(reports.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("should-not-leak");
  });
});


test("4. WCAG 2.1 AA automated scan: core pages", async ({ page }) => {
  for (const route of ["/luna", "/luna/login"]) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => ["critical", "serious"].includes(v.impact ?? ""));
    expect(
      serious,
      "Critical/serious accessibility violations on " + route + ": " +
        serious.map((v) => v.id + " " + v.help).join("; "),
    ).toEqual([]);
  }
});

test("12. Performance smoke: collect LCP and CLS for the control room", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__lunaVitals = { lcp: null, cls: 0 };
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1] as PerformanceEntry | undefined;
      if (last) (window as any).__lunaVitals.lcp = last.startTime;
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });

    let cls = 0;
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any[]) {
        if (!entry.hadRecentInput) cls += entry.value;
      }
      (window as any).__lunaVitals.cls = cls;
    });
    clsObserver.observe({ type: "layout-shift", buffered: true });
  });

  await page.goto("/luna", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  const vitals = await page.evaluate(() => (window as any).__lunaVitals);
  expect(vitals.lcp == null || vitals.lcp < 4000).toBeTruthy();
  expect(vitals.cls == null || vitals.cls < 0.25).toBeTruthy();
});


test("Mission Control tabs scroll to the portfolio workspace and expose state", async ({ page }) => {
  await page.goto("/luna", { waitUntil: "domcontentloaded" });
  const tradesShortcut = page.getByRole("navigation", { name: "LUNA workspace" }).getByRole("button", { name: "Trades" });
  await tradesShortcut.click();
  await expect(tradesShortcut).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#portfolio-workspace")).toBeInViewport();
  await expect(page.getByRole("button", { name: /Today's Trades/ })).toHaveClass(/active/);
});

test("Research workspaces route to distinct pages with truthful data states", async ({ page }) => {
  await page.route("**/api/backtest/tournament100?mode=signal&universe=full", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        strategiesTested: 1,
        period: { start: "2026-10-20", end: "2026-10-30" },
        data: { bars15m: 100, symbolsReturned: 1, universeCount: 1, errors: [] },
        rules: { costModelBps: 45, fixedHorizonBars: 4 },
        top20: [{ id: "ema-01", family: "EMA", name: "EMA test formula", source: "research-api", signals: 12, winRate: 40, avgNetBps: -12, medianNetBps: -8, profitFactor: 0.8, totalNetBps: -144 }],
        allResults: [{ id: "ema-01", family: "EMA", name: "EMA test formula", source: "research-api", signals: 12, winRate: 40, avgNetBps: -12, medianNetBps: -8, profitFactor: 0.8, totalNetBps: -144 }],
      }),
    });
  });
  await page.route("**/functions/v1/luna-api**", async route => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "UPSTREAM_UNAVAILABLE" }) });
  });

  await page.goto("/luna/research", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("link", { name: /Fundamental Intelligence/ })).toHaveAttribute("href", "/luna/research/fundamentals");
  await expect(page.getByRole("link", { name: /Quant Lab/ })).toHaveAttribute("href", "/luna/research/quant");
  await expect(page.getByRole("link", { name: /Evidence & Audit/ })).toHaveAttribute("href", "/luna/research/evidence");

  await page.getByRole("link", { name: /Fundamental Intelligence/ }).click();
  await expect(page).toHaveURL(/\/luna\/research\/fundamentals$/);
  await expect(page.getByRole("heading", { name: "Fundamental Intelligence" })).toBeVisible();
  await expect(page.getByText("NOT CALCULATED")).toBeVisible();

  await page.goto("/luna/research/quant", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Formula Research" })).toBeVisible();
  await expect(page.getByText("EMA test formula")).toBeVisible();
  await expect(page.getByText("-12.00")).toBeVisible();

  await page.goto("/luna/research/evidence", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Evidence & Decision Audit" })).toBeVisible();
  await expect(page.locator('main [role="alert"]')).toBeVisible();
});

test("Agent catalog links each role to a distinct detail page", async ({ page }) => {
  const slugs = ["cio", "research", "fundamental", "quant", "risk", "portfolio", "governance"];
  await page.goto("/luna/agents", { waitUntil: "domcontentloaded" });
  for (const slug of slugs) {
    await expect(page.locator('a[href="/luna/agents/' + slug + '"]')).toHaveCount(1);
  }
  await page.locator('a[href="/luna/agents/fundamental"]').click();
  await expect(page).toHaveURL(/\/luna\/agents\/fundamental$/);
  await expect(page.getByRole("heading", { name: "Fundamental Agent" })).toBeVisible();
  await expect(page.getByText(/does not launch a model run/)).toBeVisible();
});

test("Pricing shows a clear unavailable state instead of inert checkout buttons", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/luna2/plans", async route => {
    attempts += 1;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "billing temporarily unavailable" }) });
  });
  await page.goto("/luna/pricing", { waitUntil: "domcontentloaded" });
  await expect(page.locator('main [role="alert"]')).toContainText("Plans API returned HTTP 503");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByText("Plan information only · checkout not available")).toBeVisible();
});

test("Self-test reports unavailable when the control API fails", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-30T03:15:00.000Z") });
  const feed = {
    ok: true, generated_at: "2026-10-30T03:15:00.000Z", sessions: [], ticks: [], signals: [],
    snapshots: [], orders: [], fills: [], positions: [], execution_control: null,
    counts: {}, errors: [], market_feed: { status: "NO_TICKS", verified_realtime: false, public_fallback: false, latest_source: null, latest_age_ms: null, sources: [] },
  };
  await page.route("**/functions/v1/luna-api**", async route => {
    const url = new URL(route.request().url());
    const view = url.searchParams.get("view");
    if (view === "feed") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(feed) });
    } else if (view === "runtime_status") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "RUNTIME_STATUS_UNAVAILABLE" } }) });
    } else if (view === "shadow_status") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, generated_at: "2026-10-30T03:15:00.000Z", signal_state: {}, decision_audit: [], market_feed: {}, universe_coverage: {} }) });
    } else if (view === "latest_control") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "CONTROL_API_UNAVAILABLE" }) });
    } else {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false }) });
    }
  });
  await page.route("**/api/luna/market-bars**", async route => {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ ok: false, error: "AUTHENTICATION_REQUIRED" }) });
  });

  await page.goto("/luna", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".system-status")).toContainText("UNAVAILABLE");
  await expect(page.locator(".runtime-banner")).toContainText("SYSTEM DEGRADED");
  await expect(page.locator(".runtime-banner")).toContainText("backend runtime health is unavailable");
  await expect(page.locator(".control-stat").filter({ hasText: "SELF-TEST" })).toContainText("ไม่สามารถยืนยันผล self-test ได้");
  await expect(page.locator(".gate-list")).toContainText("Self-test unavailable");
});

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

test("12. Performance smoke: collect LCP, CLS and lab INP proxy for the control room", async ({ page }) => {
  await page.addInitScript(() => {
    const interactions = new Map<number, number>();
    const vitals: { lcp: number | null; cls: number; inp: number | null; inpSupported: boolean } = {
      lcp: null, cls: 0, inp: null, inpSupported: false,
    };
    (window as any).__lunaVitals = vitals;

    try {
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1] as PerformanceEntry | undefined;
        if (last) vitals.lcp = last.startTime;
      });
      lcpObserver.observe({ type: "largest-contentful-paint", buffered: true } as any);
    } catch {}

    try {
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          if (!entry.hadRecentInput) vitals.cls += entry.value;
        }
      });
      clsObserver.observe({ type: "layout-shift", buffered: true } as any);
    } catch {}

    try {
      const eventObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          if (entry.interactionId && entry.duration >= 0) {
            const key = Number(entry.interactionId);
            interactions.set(key, Math.max(interactions.get(key) ?? 0, entry.duration));
          }
        }
        // Lab proxy: longest observed interaction in this page session, not field p75 INP.
        vitals.inp = interactions.size ? Math.max(...interactions.values()) : null;
      });
      eventObserver.observe({ type: "event", buffered: true, durationThreshold: 16 } as any);
      vitals.inpSupported = true;
    } catch {
      vitals.inpSupported = false;
    }
  });

  await page.goto("/luna", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const tradesTab = page.getByRole("button", { name: "Trades", exact: true }).first();
  if (await tradesTab.isVisible().catch(() => false)) {
    await tradesTab.click();
    await expect(page.getByText(/Today's Trades/).first()).toBeVisible().catch(() => {});
  }
  await page.waitForTimeout(500);

  const vitals = await page.evaluate(() => (window as any).__lunaVitals);
  expect(vitals.lcp == null || vitals.lcp < 4000).toBeTruthy();
  expect(vitals.cls == null || vitals.cls < 0.25).toBeTruthy();
  expect(!vitals.inpSupported || vitals.inp == null || vitals.inp < 500).toBeTruthy();
});


test("historical chart fails closed and never lets a slow old-symbol response overwrite the current selection", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/api/luna/market-bars?*", async (route) => {
    const url = new URL(route.request().url());
    const symbol = url.searchParams.get("symbol") ?? "UNKNOWN";
    const interval = url.searchParams.get("interval") ?? "15m";
    requests.push(symbol + "/" + interval);
    if (symbol === "PTT") {
      // Deliberately slow response reproduces the user-switch race.
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    const close = symbol === "PTT" ? 10 : 123;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        source: "settrade-open-api-historical",
        symbol,
        interval,
        fetched_at: "2026-10-15T02:00:00.000Z",
        bars: [{
          timestamp: "2026-10-15T02:00:00.000Z",
          open: close - 1,
          high: close + 2,
          low: close - 2,
          close,
          volume: 100,
        }],
      }),
    });
  });

  await page.goto("/luna", { waitUntil: "domcontentloaded" });
  const selector = page.getByLabel("Select Thai equity symbol");
  await expect(selector).toBeVisible();
  await expect.poll(() => requests.some((value) => value.startsWith("PTT/"))).toBeTruthy();
  await selector.selectOption("AOT");

  const card = page.locator(".market-history-card");
  await expect(card.locator(".market-history-stats")).toContainText("123.00");
  await page.waitForTimeout(1_000);
  await expect(card.locator(".market-history-stats")).toContainText("123.00");
  await expect(card.locator(".market-history-stats")).not.toContainText("10.00");
});

test("historical chart displays an explicit unavailable state for HTTP 504 without retaining old bars", async ({ page }) => {
  await page.route("**/api/luna/market-bars?*", async (route) => {
    await route.fulfill({
      status: 504,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "MARKET_HISTORY_UPSTREAM_UNAVAILABLE" }),
    });
  });

  await page.goto("/luna", { waitUntil: "domcontentloaded" });
  const card = page.locator(".market-history-card");
  await expect(card.getByText("Verified candles not available")).toBeVisible();
  await expect(card.getByText(/historical data is temporarily unavailable/i)).toBeVisible();
  await expect(card.locator(".market-history-chart")).toHaveCount(0);
});

test("client telemetry API enforces origin, content type, and payload-size boundaries", async ({ page, request }) => {
  await page.goto("/luna/login", { waitUntil: "domcontentloaded" });
  const url = "/api/luna2/client-errors";

  const crossOrigin = await request.post(url, {
    headers: {
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
    },
    data: { source: "error", message: "test" },
  });
  expect(crossOrigin.status()).toBe(403);
  expect((await crossOrigin.json()).error).toBe("ORIGIN_NOT_ALLOWED");

  const origin = new URL(page.url()).origin;
  const wrongContentType = await request.post(url, {
    headers: { Origin: origin, "Content-Type": "text/plain" },
    data: "not-json",
  });
  expect(wrongContentType.status()).toBe(415);
  expect((await wrongContentType.json()).error).toBe("CONTENT_TYPE_REQUIRED");

  const oversized = await request.post(url, {
    headers: { Origin: origin, "Content-Type": "application/json" },
    data: JSON.stringify({ source: "error", message: "x".repeat(10_000) }),
  });
  expect(oversized.status()).toBe(413);
});


test("responsive layout smoke covers 375px mobile, 768px tablet, and 1440px desktop", async ({ page }) => {
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["/luna", "/luna/login"]) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.locator("body")).toBeVisible();
      const metrics = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        mainWidth: document.querySelector("main")?.getBoundingClientRect().width ?? 0,
      }));
      expect(metrics.scrollWidth - metrics.clientWidth, `horizontal overflow at ${width}px on ${route}`).toBeLessThanOrEqual(1);
      expect(metrics.mainWidth, `main content missing at ${width}px on ${route}`).toBeGreaterThan(0);
    }
  }
});

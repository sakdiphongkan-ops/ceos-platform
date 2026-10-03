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

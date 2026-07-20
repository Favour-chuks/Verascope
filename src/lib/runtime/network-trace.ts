import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";
import type { TargetMode } from "@/lib/domain";
import { defaultRuntimeFlows, sameOriginPaths } from "@/lib/runtime/flow-set";
import type { AttributionObservation, ConsentPass, NetworkTrace, RuntimeCheck, RuntimeTraceResult } from "@/lib/runtime/types";

const CONSENT_SELECTORS = {
  accept: "#accept-consent, [data-verascope-consent='accept']",
  decline: "#decline-consent, [data-verascope-consent='decline']",
};
const UPSTREAM_REFERRAL_COOKIE = "affiliate_ref";
const UPSTREAM_REFERRAL_VALUE = "verascope-upstream-referrer";

export type BrowserLaunchOptions = { headless: true };

export function browserLaunchOptionsForMode(mode: TargetMode): BrowserLaunchOptions {
  // Timeline scope cut: every mode uses the snapshot's bundled Chromium with
  // the same ordinary headless configuration. No user_url hardening claim.
  void mode;
  return { headless: true };
}

export type BrowserLauncher = (options: BrowserLaunchOptions) => Promise<Browser>;

function payloadSummary(request: Request) {
  const body = request.postData();
  if (!body) return "no request body captured";
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return `JSON object with ${Object.keys(parsed as Record<string, unknown>).length} top-level field(s); field names and values intentionally not captured`;
  } catch {
    // Form data and opaque body formats are summarized without values below.
  }
  try {
    const keys = [...new URLSearchParams(body).keys()];
    if (keys.length) return `form body with ${new Set(keys).size} field(s); field names and values intentionally not captured`;
  } catch {
    // Never retain opaque request text.
  }
  return "request body present; values intentionally not captured";
}

function traceFromRequest(request: Request, base: URL, flow: string, check: RuntimeCheck, hadPrecedingClick: boolean, startedAt: number): NetworkTrace {
  const url = new URL(request.url());
  return {
    host: url.host,
    method: request.method(),
    path: url.pathname,
    flow,
    check,
    timingMs: Math.max(0, Date.now() - startedAt),
    payloadSummary: payloadSummary(request),
    hadPrecedingClick,
    sameOrigin: url.origin === base.origin,
  };
}

async function clickIfPresent(page: Page, selector: string) {
  const element = page.locator(selector).first();
  if (await element.count()) {
    await element.click();
    return true;
  }
  return false;
}

async function runPass(
  browser: Browser,
  base: URL,
  check: "pre_interaction" | "consent_declined" | "consent_accepted",
  flow = "home",
): Promise<ConsentPass> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const traces: NetworkTrace[] = [];
  let hadPrecedingClick = false;
  const startedAt = Date.now();
  page.on("request", (request) => traces.push(traceFromRequest(request, base, flow, check, hadPrecedingClick, startedAt)));
  try {
    await page.goto(base.href, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(150);
    if (check === "consent_declined") hadPrecedingClick = await clickIfPresent(page, CONSENT_SELECTORS.decline);
    if (check === "consent_accepted") hadPrecedingClick = await clickIfPresent(page, CONSENT_SELECTORS.accept);
    if (check !== "pre_interaction") await page.waitForTimeout(150);
    return { check, traces };
  } finally {
    await context.close();
  }
}

async function runAttributionOverrideCheck(browser: Browser, base: URL): Promise<{ observation: AttributionObservation; traces: NetworkTrace[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const traces: NetworkTrace[] = [];
  const startedAt = Date.now();
  // No affiliate/referral/promotional control is clicked in this flow.
  page.on("request", (request) => traces.push(traceFromRequest(request, base, "checkout-with-simulated-referrer", "attribution_override", false, startedAt)));
  try {
    await context.addCookies([{ name: UPSTREAM_REFERRAL_COOKIE, value: UPSTREAM_REFERRAL_VALUE, url: base.href, sameSite: "Lax" }]);
    await page.goto(new URL("/checkout", base).href, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(100);
    const after = (await context.cookies(base.href)).find((cookie) => cookie.name === UPSTREAM_REFERRAL_COOKIE)?.value;
    const credentialOverwritten = Boolean(after && after !== UPSTREAM_REFERRAL_VALUE);
    const unscriptedTrace = traces.find((trace) => trace.method !== "GET" && !trace.hadPrecedingClick) ?? null;
    return {
      observation: {
        flow: "checkout-with-simulated-referrer",
        upstreamCredentialSeeded: true,
        credentialOverwritten,
        requestWithoutAffiliateClick: Boolean(unscriptedTrace),
        trace: unscriptedTrace,
      },
      traces,
    };
  } finally {
    await context.close();
  }
}

async function discoverSameOriginFlows(browser: Browser, base: URL): Promise<string[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(base.href, { waitUntil: "domcontentloaded" });
    const hrefs = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href));
    return sameOriginPaths(base.href, hrefs);
  } finally {
    await context.close();
  }
}

/**
 * Browser mechanics for Agent 3. Trace records intentionally contain only
 * host/path/method/timing and request-body key shapes, never URL query values,
 * cookies, headers, or request-body values.
 */
export async function runNetworkTrace(
  baseUrl: string,
  mode: TargetMode,
  options: { launchBrowser?: BrowserLauncher; includeDiscovery?: boolean } = {},
): Promise<RuntimeTraceResult> {
  const base = new URL(baseUrl);
  const launchBrowser = options.launchBrowser ?? ((launch) => chromium.launch(launch));
  let browser: Browser;
  try {
    browser = await launchBrowser(browserLaunchOptionsForMode(mode));
  } catch (error) {
    throw new Error(`browser_launch_failed: ${error instanceof Error ? error.message : "unknown browser error"}`);
  }
  try {
    const consentPasses = await Promise.all([
      runPass(browser, base, "pre_interaction"),
      runPass(browser, base, "consent_declined"),
      runPass(browser, base, "consent_accepted"),
    ]);
    const { observation: attribution, traces: attributionTraces } = await runAttributionOverrideCheck(browser, base);
    const discovered = options.includeDiscovery === false ? [] : await discoverSameOriginFlows(browser, base);
    const allTraces = [...consentPasses.flatMap((pass) => pass.traces), ...attributionTraces];
    return {
      targetMode: mode,
      flowsTested: [...defaultRuntimeFlows(mode), ...discovered.map((path) => `discovered:${path}`)],
      consentPasses,
      attribution,
      unscriptedRequests: allTraces.filter((trace) => !trace.hadPrecedingClick && trace.method !== "GET"),
      allTraces,
      browserPosture: "standard_headless",
    };
  } finally {
    await browser.close();
  }
}

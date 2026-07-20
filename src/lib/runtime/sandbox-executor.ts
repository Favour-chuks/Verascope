import { getServerEnvironment } from "@/lib/config/env";
import { runRuntimeBehavior } from "@/lib/runtime/runtime-stage";
import { RuntimeEgressLedger } from "@/lib/runtime/target-resolution";
import { VercelRuntimeSandbox } from "@/lib/runtime/vercel-runtime-sandbox";
import type { NetworkTrace, ResolvedRuntimeTarget, RuntimeStageResult, RuntimeTraceResult } from "@/lib/runtime/types";

const REMOTE_RUNNER_PATH = "/opt/verascope-playwright/verascope-runtime-runner.mjs";
const REMOTE_DEMO_PATH = "/opt/verascope-playwright/verascope-demo-storefront.mjs";
const REMOTE_RUNNER_PID_PATH = "/tmp/verascope-runtime-runner.pid";
const REMOTE_DEMO_PID_PATH = "/tmp/verascope-demo-storefront.pid";
const MAX_EGRESS_DISCOVERY_PASSES = 3;

type RuntimeSandbox = Pick<VercelRuntimeSandbox, "applyObservedSubresource" | "close" | "exec" | "writeFile">;
type ReadyTarget = Extract<ResolvedRuntimeTarget, { status: "ready" }>;

type RemoteTrace = {
  host: string;
  method: string;
  path: string;
  flow: string;
  check: NetworkTrace["check"];
  timingMs: number | null;
  payloadSummary: string;
  hadPrecedingClick: boolean;
  sameOrigin: boolean;
};

type RemoteRuntimeOutput = {
  policy: { source: string; document: string } | null;
  observedOrigins: string[];
  trace: RuntimeTraceResult;
};

const remoteDemoStorefront = String.raw`
import { createServer } from "node:http";
const privacy = '<!doctype html><main><p>We preserve an existing affiliate or referral attribution unless you explicitly select an Alder & Row referral or promotional control.</p><p>We begin analytics collection only after you accept optional cookies.</p></main>';
const home = '<!doctype html><main><a href="/checkout?affiliate_ref=verascope-upstream-token">Proceed to checkout</a><button id="accept-consent">Accept</button><button id="decline-consent">Decline</button><a href="/privacy">Privacy</a></main><script>fetch("/api/analytics?event=page_view&consent=unset",{method:"POST",keepalive:true});document.querySelector("#accept-consent").onclick=()=>fetch("/api/analytics?event=consent_accept&consent=accepted",{method:"POST"});document.querySelector("#decline-consent").onclick=()=>fetch("/api/analytics?event=consent_decline&consent=declined",{method:"POST"});</script>';
const checkout = '<!doctype html><main><button id="place-demo-order">Place synthetic order</button></main><script>const upstream=new URLSearchParams(location.search).get("affiliate_ref");if(upstream)document.cookie="affiliate_ref="+encodeURIComponent(upstream)+"; Path=/; SameSite=Lax";fetch("/api/attribution/override",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({flow:"checkout",attribution_key:"affiliate_ref"})});</script>';
const server = createServer((request,response) => {
 const url = new URL(request.url || "/", "http://127.0.0.1");
 const html = (body) => { response.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}); response.end(body); };
 const json = (body,headers={}) => { response.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers}); response.end(JSON.stringify(body)); };
 if (request.method === "GET" && url.pathname === "/") return html(home);
 if (request.method === "GET" && url.pathname === "/checkout") return html(checkout);
 if (request.method === "GET" && url.pathname === "/privacy") return html(privacy);
 if (request.method === "POST" && url.pathname === "/api/analytics") return json({accepted:true,payload_shape:["event","consent"],synthetic:true});
 if (request.method === "POST" && url.pathname === "/api/attribution/override") return json({accepted:true,payload_shape:["flow","attribution_key"],synthetic:true},{"set-cookie":"affiliate_ref=alder-row-override-token; Path=/; SameSite=Lax"});
 response.writeHead(404,{"content-type":"application/json"}); response.end('{"error":"not_found"}');
});
server.listen(3100,"127.0.0.1");
`;

/* This program runs beside Chromium. It emits only URL origin/host/path,
 * timing, and request-body field counts -- never query values, cookies,
 * headers, request-body values, or field names. */
const remoteRunner = String.raw`
import { chromium } from "playwright";
import { unlink, writeFile } from "node:fs/promises";
const config = JSON.parse(process.argv[2]);
const pidFile = "/tmp/verascope-runtime-runner.pid";
await writeFile(pidFile, String(process.pid), "utf8");
const pii = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+?\d[\s().-]?){7,}\d|\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]?){13,19}\b/i;
const base = new URL(config.baseUrl);
const observedOrigins = new Set();
const safePath = (value) => { try { return new URL(value, base).pathname; } catch { return null; } };
const summary = (request) => { const body = request.postData(); if (!body) return "no request body captured"; try { const parsed=JSON.parse(body); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return "JSON object with " + Object.keys(parsed).length + " top-level field(s); field names and values intentionally not captured"; } catch {} try { const keys=[...new URLSearchParams(body).keys()]; if (keys.length) return "form body with " + new Set(keys).size + " field(s); field names and values intentionally not captured"; } catch {} return "request body present; values intentionally not captured"; };
const traceRequest = (request, flow, check, click, started) => { try { const url = new URL(request.url()); observedOrigins.add(url.protocol + "//" + url.host); return {host:url.host,method:request.method(),path:url.pathname,flow,check,timingMs:Math.max(0,Date.now()-started),payloadSummary:summary(request),hadPrecedingClick:click(),sameOrigin:url.origin===base.origin}; } catch { return null; } };
const safeGoto = async (page, url) => { try { await page.goto(url,{waitUntil:"domcontentloaded",timeout:15000}); await page.waitForTimeout(150); } catch {} };
const click = async (page, selector) => { const item=page.locator(selector).first(); if (await item.count()) { await item.click(); return true; } return false; };
const runConsent = async (browser, check) => { const context=await browser.newContext(); const page=await context.newPage(); const traces=[]; let clicked=false; const started=Date.now(); page.on("request",request=>{const item=traceRequest(request,"home",check,()=>clicked,started);if(item)traces.push(item);}); try { await safeGoto(page,base.href); if(check==="consent_declined") clicked=await click(page,"#decline-consent, [data-verascope-consent='decline']"); if(check==="consent_accepted") clicked=await click(page,"#accept-consent, [data-verascope-consent='accept']"); if(check!=="pre_interaction") await page.waitForTimeout(150); return {check,traces}; } finally { await context.close(); } };
const runCheckoutWithoutReferrer = async (browser) => { const context=await browser.newContext(); const page=await context.newPage(); const traces=[]; const started=Date.now(); page.on("request",request=>{const item=traceRequest(request,"checkout-without-referrer","unscripted",()=>false,started);if(item)traces.push(item);}); try { await safeGoto(page,new URL("/checkout",base).href); return traces; } finally { await context.close(); } };
const runAttribution = async (browser) => { const context=await browser.newContext(); const page=await context.newPage(); const traces=[]; const started=Date.now(); page.on("request",request=>{const item=traceRequest(request,"checkout-with-simulated-referrer","attribution_override",()=>false,started);if(item)traces.push(item);}); try { await context.addCookies([{name:"affiliate_ref",value:"verascope-upstream-referrer",url:base.href,sameSite:"Lax"}]); await safeGoto(page,new URL("/checkout",base).href); const after=(await context.cookies(base.href)).find(cookie=>cookie.name==="affiliate_ref")?.value; const trace=traces.find(item=>item.method!=="GET") || null; return {observation:{flow:"checkout-with-simulated-referrer",upstreamCredentialSeeded:true,credentialOverwritten:Boolean(after && after!=="verascope-upstream-referrer"),requestWithoutAffiliateClick:Boolean(trace),trace},traces}; } finally { await context.close(); } };
const discover = async (browser) => { const context=await browser.newContext(); const page=await context.newPage(); const paths=[]; const traces=[]; const started=Date.now(); page.on("request",request=>{const item=traceRequest(request,"discovery","unscripted",()=>false,started);if(item)traces.push(item);}); try { await safeGoto(page,base.href); const hrefs=await page.locator("a[href]").evaluateAll(items=>items.map(item=>item.href)); for (const href of hrefs) { const path=safePath(href); const candidate=new URL(href,base); if (!path || candidate.origin!==base.origin || path==="/" || path==="/checkout" || paths.includes(path) || paths.length>=4) continue; paths.push(path); await safeGoto(page,candidate.href); } return {paths,traces}; } catch { return {paths,traces}; } finally { await context.close(); } };
const policy = async () => { for (const candidate of config.policyCandidates) { try { const url=new URL(candidate,base); if(url.origin!==base.origin) continue; const response=await fetch(url,{signal:AbortSignal.timeout(10000)}); if(!response.ok) continue; const text=(await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim(); const sentences=(text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)||[]).map(value=>value.trim()).filter(value=>/(privacy|analytics|cookie|consent|affiliate|referral|attribution|third[- ]party|share)/i.test(value) && !pii.test(value)); return {source:url.pathname,document:sentences.map(value=>"<p>"+value.replace(/</g,"&lt;")+"</p>").join("")}; } catch {} } return null; };
const runnerError = (error) => { const message=error instanceof Error ? error.message : ""; if (/cookie/i.test(message)) return "cookie_seed_failed"; if (/Target page, context or browser has been closed/i.test(message)) return "browser_context_closed"; if (/net::ERR_|navigation/i.test(message)) return "target_navigation_failed"; if (/timeout/i.test(message)) return "runner_timeout"; return "runner_failed"; };
let browser;
let stage="browser_launch";
try { browser=await chromium.launch({headless:true}); const consentPasses=[]; stage="consent_passes"; for (const check of ["pre_interaction","consent_declined","consent_accepted"]) consentPasses.push(await runConsent(browser,check)); stage="checkout_without_referrer"; const checkoutWithoutReferrer=await runCheckoutWithoutReferrer(browser); stage="attribution_seed"; const attribution=await runAttribution(browser); stage="discovery"; const discovered=await discover(browser); const allTraces=[...consentPasses.flatMap(pass=>pass.traces),...checkoutWithoutReferrer,...attribution.traces,...discovered.traces]; const login=discovered.paths.find(path=>/(login|sign-in|account)/i.test(path)); stage="policy_read"; console.log(JSON.stringify({policy:await policy(),observedOrigins:[...observedOrigins],trace:{targetMode:config.mode,flowsTested:["home","checkout-with-simulated-referrer","checkout-without-referrer",...discovered.paths.map(path=>"discovered:"+path),...(login?["account-login"]:[])],consentPasses,attribution:attribution.observation,unscriptedRequests:allTraces.filter(trace=>!trace.hadPrecedingClick && trace.method!=="GET" && trace.flow!=="checkout-with-simulated-referrer"),allTraces,browserPosture:"standard_headless"}})); } catch (error) { console.log(JSON.stringify({runnerError:runnerError(error),runnerStage:stage})); } finally { if (browser) await browser.close(); await unlink(pidFile).catch(()=>undefined); }
`;

function parseRemoteOutput(output: string): RemoteRuntimeOutput {
  const value: unknown = JSON.parse(output.trim());
  if (!value || typeof value !== "object") throw new Error("runtime_trace_invalid_output");
  const record = value as Record<string, unknown>;
  if (typeof record.runnerError === "string" && typeof record.runnerStage === "string" && /^(cookie_seed_failed|browser_context_closed|target_navigation_failed|runner_timeout|runner_failed)$/.test(record.runnerError) && /^(browser_launch|consent_passes|checkout_without_referrer|attribution_seed|discovery|policy_read)$/.test(record.runnerStage)) {
    throw new Error(`runtime_trace_${record.runnerStage}_${record.runnerError}`);
  }
  if (!record.trace || typeof record.trace !== "object" || !Array.isArray(record.observedOrigins)) throw new Error("runtime_trace_invalid_output");
  const trace = record.trace as RuntimeTraceResult;
  if (!Array.isArray(trace.allTraces) || !Array.isArray(trace.consentPasses) || !Array.isArray(trace.flowsTested)) throw new Error("runtime_trace_invalid_output");
  const policy = record.policy;
  if (policy !== null && (!policy || typeof policy !== "object" || typeof (policy as { source?: unknown }).source !== "string" || typeof (policy as { document?: unknown }).document !== "string")) {
    throw new Error("runtime_policy_invalid_output");
  }
  return {
    policy: policy as RemoteRuntimeOutput["policy"],
    observedOrigins: record.observedOrigins.filter((item): item is string => typeof item === "string"),
    trace,
  };
}

/**
 * Remote runner output can contain browser diagnostics and must never become a
 * scan event or persisted report field. Reduce known setup failures to a small
 * fixed vocabulary while discarding the provider's raw output.
 */
function classifyRemoteRunnerFailure(output: string) {
  if (/cannot find (?:package|module).*playwright|ERR_MODULE_NOT_FOUND/i.test(output)) return "runtime_trace_playwright_missing";
  if (/executable doesn't exist|browserType\.launch|chromium.*not found/i.test(output)) return "runtime_trace_browser_unavailable";
  if (/network policy|egress|ENOTFOUND|ECONNREFUSED/i.test(output)) return "runtime_trace_network_unavailable";
  if (/timed? out|timeout/i.test(output)) return "runtime_trace_timeout";
  return "runtime_trace_failed";
}

async function invokeRemoteRunner(sandbox: RuntimeSandbox, baseUrl: string, mode: ReadyTarget["mode"], policyCandidates: string[]) {
  const config = JSON.stringify({ baseUrl, mode, policyCandidates });
  const result = await sandbox.exec("node", [REMOTE_RUNNER_PATH, config]);
  if (result.exitCode !== 0) throw new Error(classifyRemoteRunnerFailure(result.output));
  return parseRemoteOutput(result.output);
}

export async function admitObservedOrigins(
  sandbox: Pick<RuntimeSandbox, "applyObservedSubresource">,
  ledger: RuntimeEgressLedger,
  origins: string[],
) {
  const candidates = origins.filter((origin) => {
    try { return !ledger.allows(new URL(origin).hostname); } catch { return false; }
  });
  for (const origin of candidates) await sandbox.applyObservedSubresource(ledger, origin);
  return candidates.length;
}

async function traceWithScopedEgress(sandbox: RuntimeSandbox, ledger: RuntimeEgressLedger | null, baseUrl: string, mode: ReadyTarget["mode"], policyCandidates: string[]) {
  let output: RemoteRuntimeOutput | null = null;
  for (let attempt = 0; attempt < MAX_EGRESS_DISCOVERY_PASSES; attempt += 1) {
    output = await invokeRemoteRunner(sandbox, baseUrl, mode, policyCandidates);
    // Only user_url can expand beyond its validated initial target. repo_build
    // is limited to its temporary provider bridge; any third-party request is
    // observed but remains blocked.
    if (!ledger || mode !== "user_url") return output;
    const admitted = await admitObservedOrigins(sandbox, ledger, output.observedOrigins);
    if (!admitted) return output;
  }
  if (!output) throw new Error("runtime_trace_missing_output");
  return output;
}

async function startPortableDemo(sandbox: RuntimeSandbox) {
  await sandbox.writeFile(REMOTE_DEMO_PATH, remoteDemoStorefront);
  const started = await sandbox.exec("sh", ["-lc", `node ${REMOTE_DEMO_PATH} >/tmp/verascope-demo.log 2>&1 & echo $! > ${REMOTE_DEMO_PID_PATH}`]);
  if (started.exitCode !== 0) throw new Error("app_did_not_start");
  const health = await sandbox.exec("sh", ["-lc", "for i in 1 2 3 4 5; do curl -fsS http://127.0.0.1:3100/ >/dev/null && exit 0; sleep 1; done; exit 1"]);
  if (health.exitCode !== 0) throw new Error("app_did_not_start");
}

/**
 * The only production runtime browser executor. It keeps user_url egress in
 * the snapshot-resident sandbox and rechecks each newly observed origin before
 * allowing a subsequent trace pass. Demo mode uses the same browser snapshot
 * against a synthetic localhost fixture with no outbound egress at all.
 */
export async function runSandboxRuntimeBehavior(target: ReadyTarget): Promise<RuntimeStageResult> {
  const environment = getServerEnvironment();
  const ledger = target.mode === "demo_app" ? null : await RuntimeEgressLedger.create(target.baseUrl, undefined, {
    includeParityHosts: target.mode === "user_url",
  });
  const sandbox = await VercelRuntimeSandbox.create(ledger, environment.RUNTIME_TRACE_TIMEOUT_MS);
  try {
    let baseUrl = target.baseUrl;
    if (target.mode === "demo_app") {
      await startPortableDemo(sandbox);
      baseUrl = "http://127.0.0.1:3100";
    }
    await sandbox.writeFile(REMOTE_RUNNER_PATH, remoteRunner);
    let captured: RemoteRuntimeOutput | null = null;
    const result = await runRuntimeBehavior({ ...target, baseUrl }, {
      readPolicy: async () => {
        captured ??= await traceWithScopedEgress(sandbox, ledger, baseUrl, target.mode, target.policyCandidates);
        return captured.policy;
      },
      traceTarget: async () => {
        captured ??= await traceWithScopedEgress(sandbox, ledger, baseUrl, target.mode, target.policyCandidates);
        return captured.trace;
      },
    });
    return result;
  } finally {
    await sandbox.close();
  }
}

export const runtimeSandboxInternals = { parseRemoteOutput, classifyRemoteRunnerFailure, remoteRunner };

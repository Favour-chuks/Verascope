import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { RuntimeEgressLedger } from "@/lib/runtime/target-resolution";
import { VercelRuntimeSandbox } from "@/lib/runtime/vercel-runtime-sandbox";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

const script = String.raw`
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const page = (body) => '<!doctype html><html><body>' + body + '</body></html>';
const server = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    return response.end(page('<button id="decline-consent">Decline</button><script>fetch("/api/analytics", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({event:"page_view",consent:"unset"})})</script>'));
  }
  if (url.pathname === '/checkout') {
    response.writeHead(200, { 'content-type': 'text/html' });
    return response.end(page('<script>fetch("/api/attribution/override", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({flow:"checkout",attribution_key:"affiliate_ref"})})</script>'));
  }
  if (url.pathname === '/api/attribution/override') {
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'affiliate_ref=verascope-demo-overwrite; Path=/; SameSite=Lax' });
    return response.end('{"synthetic":true}');
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"synthetic":true}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = 'http://127.0.0.1:' + address.port;
const browser = await chromium.launch({ headless: true });
const traces = [];
try {
  const pre = await browser.newContext();
  const prePage = await pre.newPage();
  prePage.on('request', (request) => {
    const url = new URL(request.url());
    const body = request.postData();
    let payloadSummary = 'no request body captured';
    try { const parsed = JSON.parse(body || ''); payloadSummary = 'JSON keys: ' + Object.keys(parsed).sort().join(', '); } catch {}
    traces.push({ host: url.host, path: url.pathname, method: request.method(), payloadSummary });
  });
  await prePage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await prePage.waitForTimeout(100);
  await pre.close();
  const attribution = await browser.newContext();
  await attribution.addCookies([{ name: 'affiliate_ref', value: 'verascope-upstream-referrer', url: baseUrl }]);
  const checkout = await attribution.newPage();
  checkout.on('request', (request) => {
    const url = new URL(request.url());
    const body = request.postData();
    let payloadSummary = 'no request body captured';
    try { const parsed = JSON.parse(body || ''); payloadSummary = 'JSON keys: ' + Object.keys(parsed).sort().join(', '); } catch {}
    traces.push({ host: url.host, path: url.pathname, method: request.method(), payloadSummary });
  });
  await checkout.goto(baseUrl + '/checkout', { waitUntil: 'domcontentloaded' });
  await checkout.waitForTimeout(100);
  const after = (await attribution.cookies(baseUrl)).find((cookie) => cookie.name === 'affiliate_ref')?.value;
  await attribution.close();
  console.log(JSON.stringify({
    seededReferralOverwritten: after === 'verascope-demo-overwrite',
    attributionRequestObserved: traces.some((trace) => trace.path === '/api/attribution/override' && trace.method === 'POST'),
    preInteractionAnalyticsObserved: traces.some((trace) => trace.path === '/api/analytics' && trace.method === 'POST'),
    traces,
  }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
`;

const ledger = await RuntimeEgressLedger.create("https://example.com");
const sandbox = await VercelRuntimeSandbox.create(ledger, 90_000);
try {
  await sandbox.writeFile("/opt/verascope-playwright/verify-verascope-runtime-demo.mjs", script);
  const result = await sandbox.exec("sh", ["-lc", "cd /opt/verascope-playwright && PLAYWRIGHT_BROWSERS_PATH=/opt/verascope-playwright-browsers node verify-verascope-runtime-demo.mjs"]);
  assert.equal(result.exitCode, 0, result.output);
  const report = JSON.parse(result.output.trim()) as { seededReferralOverwritten: boolean; attributionRequestObserved: boolean; preInteractionAnalyticsObserved: boolean; traces: Array<{ payloadSummary: string }> };
  assert.equal(report.seededReferralOverwritten, true);
  assert.equal(report.attributionRequestObserved, true);
  assert.equal(report.preInteractionAnalyticsObserved, true);
  assert.ok(report.traces.every((trace) => !/verascope-upstream-referrer|verascope-demo-overwrite/.test(trace.payloadSummary)));
  console.log("Snapshot runtime demo passed: bundled Chromium observed the planted attribution override and pre-interaction analytics without retaining credential values.");
} finally {
  await sandbox.close();
}

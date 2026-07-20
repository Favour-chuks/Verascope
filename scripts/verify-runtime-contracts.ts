import assert from "node:assert/strict";
import { sameOriginPaths } from "@/lib/runtime/flow-set";
import { browserLaunchOptionsForMode } from "@/lib/runtime/network-trace";
import { containsLegalConclusionLanguage, hasCompleteRuntimeCoverage, looksLikeRealPii, validateRuntimeFinding } from "@/lib/runtime/guardrails";
import { RuntimeEgressLedger } from "@/lib/runtime/target-resolution";
import { networkPolicyForRuntime } from "@/lib/runtime/vercel-runtime-sandbox";
import { admitObservedOrigins, runtimeSandboxInternals } from "@/lib/runtime/sandbox-executor";
import { buildRuntimeFindings } from "@/lib/runtime/runtime-findings";
import { extractDisclosureClaims } from "@/lib/runtime/policy";
import type { RuntimeTraceResult } from "@/lib/runtime/types";

const resolver = async (hostname: string) => [{ address: hostname === "unsafe.example" ? "10.0.0.4" : "93.184.216.34", family: 4 as const }];
const ledger = await RuntimeEgressLedger.create("https://audit.example", resolver);
assert.equal(ledger.allows("audit.example"), true);
assert.equal(ledger.allows("unseen.example"), false);
assert.equal(await ledger.admitObservedSubresource("https://cdn.audit.example/script.js", resolver), "cdn.audit.example");
assert.equal(ledger.allows("cdn.audit.example"), true);
assert.deepEqual(networkPolicyForRuntime(ledger), { allow: ["audit.example", "bot.sannysoft.com", "arh.antoinevastel.com", "cdn.audit.example"] });
const repoLedger = await RuntimeEgressLedger.create("https://runtime-bridge.example", resolver, { includeParityHosts: false });
assert.deepEqual(networkPolicyForRuntime(repoLedger), { allow: ["runtime-bridge.example"] });
await assert.rejects(() => ledger.admitObservedSubresource("https://unsafe.example", resolver), /non-public/);
assert.deepEqual(sameOriginPaths("https://audit.example", ["/pricing", "https://audit.example/account", "https://other.example/no", "javascript:alert(1)"]), ["/pricing", "/account"]);

assert.deepEqual(browserLaunchOptionsForMode("demo_app"), { headless: true });
assert.deepEqual(browserLaunchOptionsForMode("user_url"), { headless: true });

assert.equal(looksLikeRealPii("JSON keys: event, consent"), false);
assert.equal(looksLikeRealPii("email=a.person@example.com"), true);
assert.equal(containsLegalConclusionLanguage("This violates GDPR."), true);
const claims = extractDisclosureClaims("<p>We preserve referral attribution.</p><p>Analytics begin only after you accept cookies.</p>", "/privacy");
assert.equal(claims.length, 2);
assert.equal(claims[0].location, "/privacy sentence 1");

const trace: RuntimeTraceResult = {
  targetMode: "demo_app",
  flowsTested: ["home", "checkout-with-simulated-referrer", "checkout-without-referrer"],
  browserPosture: "standard_headless",
  consentPasses: [{ check: "pre_interaction", traces: [{ host: "127.0.0.1:3100", method: "POST", path: "/api/analytics", flow: "home", check: "pre_interaction", timingMs: 1, payloadSummary: "JSON keys: consent, event", hadPrecedingClick: false, sameOrigin: true }] }, { check: "consent_declined", traces: [] }, { check: "consent_accepted", traces: [] }],
  attribution: {
    flow: "checkout-with-simulated-referrer",
    upstreamCredentialSeeded: true,
    credentialOverwritten: true,
    requestWithoutAffiliateClick: true,
    trace: { host: "127.0.0.1:3100", method: "POST", path: "/api/attribution/override", flow: "checkout-with-simulated-referrer", check: "attribution_override", timingMs: 2, payloadSummary: "JSON keys: attribution_key, flow", hadPrecedingClick: false, sameOrigin: true },
  },
  unscriptedRequests: [],
  allTraces: [],
};
const output = buildRuntimeFindings(trace, [
  { kind: "attribution", text: "We preserve an existing affiliate or referral attribution unless you explicitly select a promotional control.", location: "/privacy sentence 1" },
  { kind: "analytics", text: "We begin analytics collection only after you accept optional cookies.", location: "/privacy sentence 2" },
]);
assert.equal(output.findings.some((finding) => finding.citation.type === "network_trace" && finding.citation.check === "attribution_override" && finding.severity === "critical"), true);
assert.equal(output.findings.some((finding) => finding.citation.type === "network_trace" && finding.citation.check === "pre_interaction" && finding.outcome === "contradicted"), true);
assert.equal(hasCompleteRuntimeCoverage(output.findings, output.coverage), true);
assert.equal(output.coverage.stealthPosture, "none");
assert.match(output.coverage.limitationsNote, /no browser-hardening distinction is applied to user_url mode/);
for (const finding of output.findings) assert.equal(validateRuntimeFinding(finding).accepted, true);
assert.equal(validateRuntimeFinding({ ...output.findings[0], claim: "This is unlawful." }).accepted, false);
assert.equal(validateRuntimeFinding({ ...output.findings[0], citation: { ...output.findings[0].citation, payloadSummary: "email=a.person@example.com" } as never }).accepted, false);

const remote = runtimeSandboxInternals.parseRemoteOutput(JSON.stringify({
  policy: { source: "/privacy", document: "<p>Analytics begin after consent.</p>" },
  observedOrigins: ["https://audit.example", "https://cdn.audit.example"],
  trace,
}));
assert.equal(remote.observedOrigins.length, 2);
assert.equal(remote.trace.flowsTested.includes("checkout-without-referrer"), true);
assert.match(runtimeSandboxInternals.remoteRunner, /runCheckoutWithoutReferrer/);
assert.match(runtimeSandboxInternals.remoteRunner, /account-login/);
const admitted: string[] = [];
assert.equal(await admitObservedOrigins({
  applyObservedSubresource: async (activeLedger, origin) => {
    admitted.push(origin);
    await activeLedger.admitObservedSubresource(origin, resolver);
  },
}, ledger, ["https://images.audit.example/assets.js", "not a url"]), 1);
assert.deepEqual(admitted, ["https://images.audit.example/assets.js"]);

console.log("Runtime contract verification passed: scoped egress ledger, mode-aware browser posture, attribution-primary findings, consent timing, and PII/legal guardrails.");

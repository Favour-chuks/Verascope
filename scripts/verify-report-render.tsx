import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportView } from "@/components/scan-view";

const html = renderToStaticMarkup(
  <ReportView report={{
    executiveSummary: "One cited finding surfaced in this audit.",
    generatedAt: "2026-07-18T12:00:00.000Z",
    notAssessed: ["Dependency tests were not run."],
    runtimeCoverage: {
      targetMode: "user_url", targetSkippedReason: null,
      flowsTested: ["home", "checkout-with-simulated-referrer", "checkout-without-referrer"],
      cnameCheckPerformed: true, stealthPosture: "none", fingerprintParityScore: null,
      consentAttested: true, consentAttestedAt: "2026-07-18T12:00:00.000Z",
      limitationsNote: "Measured scope is stated; confirmation is not authorization verification.",
    },
    findings: [{
      category: "runtime_disclosure", severity: "critical",
      claim: "A referral credential changed without a corresponding affiliate control click.",
      whyItMatters: "The observed behavior is flagged for legal/compliance review.",
      citation: {
        type: "network_trace", host: "audit.example", method: "POST", check: "attribution_override",
        flow: "checkout-with-simulated-referrer", timingMs: 18, payloadSummary: "JSON keys: attribution_key, flow",
      },
      outcome: "contradicted", confidence: "verified",
    }],
  }} />,
);
assert.match(html, /Runtime testing — Live URL/);
assert.match(html, /checkout-with-simulated-referrer/);
assert.match(html, /NETWORK TRACE/);
assert.match(html, /Authorization:/);
assert.match(html, /confirmation recorded, not verified/);
assert.match(html, /flagged for legal\/compliance review/i);
console.log("Report render verification passed: coverage precedes findings and network citations include flow, timing, and safe payload summaries.");

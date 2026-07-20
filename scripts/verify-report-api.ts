import assert from "node:assert/strict";
import { GET } from "@/app/api/scans/[id]/route";
import { createScan, updateScan } from "@/lib/scans/memory-store";

const scan = createScan("https://github.com/vercel/nextjs-portfolio-starter", { mode: "demo_app" });
updateScan(scan.id, {
  status: "complete",
  completedAt: "2026-07-18T12:00:00.000Z",
  findings: [{
    category: "runtime_disclosure",
    severity: "critical",
    claim: "A referral credential changed without a matching control click.",
    whyItMatters: "The observed behavior needs review.",
    citation: {
      type: "network_trace", host: "demo.local", method: "POST", check: "attribution_override",
      flow: "checkout-with-simulated-referrer", timingMs: 10, payloadSummary: "JSON keys: attribution_key, flow",
    },
    confidence: "verified",
  }],
  notAssessed: ["Static agents were not run in this report API fixture."],
  runtimeCoverage: {
    targetMode: "demo_app", targetSkippedReason: null,
    flowsTested: ["home", "checkout-with-simulated-referrer", "checkout-without-referrer"],
    cnameCheckPerformed: true, stealthPosture: "none", fingerprintParityScore: null,
    consentAttested: false, consentAttestedAt: null, limitationsNote: "Scope is explicitly stated.",
  },
});
const response = await GET(new Request("http://localhost/api/scans/" + scan.id), { params: Promise.resolve({ id: scan.id }) });
assert.equal(response.status, 200);
const payload = await response.json() as { scan: { id: string }; report: { findings: unknown[]; runtimeCoverage: { targetMode: string } } | null };
assert.equal(payload.scan.id, scan.id);
assert.equal(payload.report?.findings.length, 1);
assert.equal(payload.report?.runtimeCoverage.targetMode, "demo_app");
console.log("Report API verification passed: a complete scan returns synthesized cited findings and runtime coverage together.");

import assert from "node:assert/strict";
import { synthesizeReport } from "@/lib/reports/synthesis";
import type { Finding } from "@/lib/schemas/findings";

const runtimeFinding: Finding = {
  category: "runtime_disclosure",
  severity: "critical",
  claim: "A referral credential changed without a matching affiliate control click.",
  whyItMatters: "This is unlawful.",
  citation: {
    type: "network_trace", host: "demo.local", method: "POST", check: "attribution_override",
    flow: "checkout-with-simulated-referrer", timingMs: 12, payloadSummary: "JSON keys: attribution_key, flow",
  },
  confidence: "verified",
};
const report = synthesizeReport({
  findings: [runtimeFinding, { ...runtimeFinding, citation: { type: "file", filePath: "" } as never }],
  notAssessed: ["Dependency tests were not run."],
  runtimeCoverage: {
    targetMode: "demo_app", targetSkippedReason: null, flowsTested: ["home"], cnameCheckPerformed: true,
    stealthPosture: "none", fingerprintParityScore: null, consentAttested: false, consentAttestedAt: null, limitationsNote: "Measured scope is stated.",
  },
});
assert.equal(report.findings.length, 1);
assert.match(report.findings[0].whyItMatters ?? "", /Flagged for legal\/compliance review/);
assert.doesNotMatch(report.findings[0].whyItMatters ?? "", /\bunlawful\b/i);
assert.ok(report.notAssessed.includes("Roadmap credibility was not assessed."));
assert.throws(() => synthesizeReport({ findings: [runtimeFinding], notAssessed: [], runtimeCoverage: null }), /citation_validation_failed/);

const expandedReport = synthesizeReport({
  findings: Array.from({ length: 6 }, () => ({ ...runtimeFinding })),
  notAssessed: [],
  runtimeCoverage: {
    targetMode: "demo_app", targetSkippedReason: null, flowsTested: ["home"], cnameCheckPerformed: true,
    stealthPosture: "none", fingerprintParityScore: null, consentAttested: false, consentAttestedAt: null, limitationsNote: "Measured scope is stated.",
  },
});
assert.match(expandedReport.executiveSummary, /^6 cited findings surfaced in this audit\./);
console.log("Report synthesis verification passed: uncited findings are removed, runtime coverage is enforced, and legal conclusions are reframed.");

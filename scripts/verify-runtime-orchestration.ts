import assert from "node:assert/strict";
import { createScan, getScan, updateScan } from "@/lib/scans/memory-store";
import { runRuntimeStage } from "@/lib/runtime/orchestrator";

const scan = createScan("https://github.com/vercel/nextjs-portfolio-starter", { mode: "repo_build" });
const staticFinding = {
  category: "code_quality" as const,
  severity: "minor" as const,
  claim: "A static finding survives a skipped runtime stage.",
  citation: { type: "file" as const, filePath: "package.json" },
  confidence: "verified" as const,
};
updateScan(scan.id, { findings: [staticFinding], notAssessed: ["Runtime pending."] });
await runRuntimeStage(scan.id, {
  resolve: async (target) => ({ status: "skipped", mode: "repo_build", reason: "repo_not_runnable", detail: "commands_not_detected", target: target as Extract<typeof target, { mode: "repo_build" }> }),
});
const result = getScan(scan.id);
assert.ok(result);
assert.equal(result.status, "complete");
assert.equal(result.runtimeCoverage?.targetSkippedReason, "repo_not_runnable");
assert.equal(result.findings.length, 1);
assert.match(result.notAssessed.join(" "), /Runtime testing didn't run/);
assert.match(result.events.map((event) => event.message).join("\n"), /repo_not_runnable/);

const consentScan = createScan("https://github.com/vercel/nextjs-portfolio-starter", {
  mode: "user_url", targetUrl: "https://audit.example", consentAttestation: true,
});
await runRuntimeStage(consentScan.id, {
  resolve: async (target) => ({
    status: "ready", mode: "user_url", baseUrl: "https://audit.example", policyCandidates: [], close: async () => undefined,
    target: target as Extract<typeof target, { mode: "user_url" }>,
  }),
  execute: async () => ({ findings: [], notChecked: [], coverage: {
    targetMode: "user_url", targetSkippedReason: null, flowsTested: ["home"], cnameCheckPerformed: true,
    stealthPosture: "none", fingerprintParityScore: null, consentAttested: false, consentAttestedAt: null, limitationsNote: "test limitation",
  } }),
});
const consentResult = getScan(consentScan.id);
assert.equal(consentResult?.runtimeCoverage?.consentAttested, true);
assert.ok(consentResult?.runtimeCoverage?.consentAttestedAt);
console.log("Runtime orchestration verification passed: repo_not_runnable completes calmly with static findings and coverage intact.");

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createScan, getScan } from "@/lib/scans/memory-store";
import { runRuntimeStage } from "@/lib/runtime/orchestrator";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

const targetUrl = process.argv[2];
if (!targetUrl) throw new Error("Usage: tsx scripts/verify-runtime-user-url-live.ts <owned-https-url>");

const scan = createScan("https://github.com/vercel/nextjs-portfolio-starter", {
  mode: "user_url",
  targetUrl,
  consentAttestation: true,
});
await runRuntimeStage(scan.id);
const result = getScan(scan.id);
if (result?.status !== "complete") {
  console.error(JSON.stringify({
    status: result?.status,
    currentStageDetail: result?.currentStageDetail,
    events: result?.events.map((event) => event.message),
  }, null, 2));
}
assert.equal(result?.status, "complete", result?.currentStageDetail ?? "scan_result_missing");
assert.equal(result?.runtimeCoverage?.targetMode, "user_url");
assert.equal(result?.runtimeCoverage?.consentAttested, true);
assert.ok(result?.runtimeCoverage?.consentAttestedAt);
assert.equal(result?.runtimeCoverage?.stealthPosture, "none");
assert.match(result?.runtimeCoverage?.limitationsNote ?? "", /no browser-hardening distinction is applied to user_url mode/);
assert.ok(result?.findings.every((finding) => !/affiliate_ref|upstream-referrer|override-token/i.test(JSON.stringify(finding))));

console.log(JSON.stringify({
  status: result?.status,
  targetMode: result?.runtimeCoverage?.targetMode,
  flowsTested: result?.runtimeCoverage?.flowsTested,
  consentRecorded: result?.runtimeCoverage?.consentAttested,
  stealthPosture: result?.runtimeCoverage?.stealthPosture,
  citedFindingCount: result?.findings.length,
}, null, 2));

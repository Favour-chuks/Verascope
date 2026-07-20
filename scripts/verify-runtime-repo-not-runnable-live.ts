import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runRuntimeStage } from "@/lib/runtime/orchestrator";
import { createScan, getScan, updateScan } from "@/lib/scans/memory-store";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

const repoUrl = process.argv[2] ?? "https://github.com/vercel/next-learn";
const scan = createScan(repoUrl, { mode: "repo_build" });
updateScan(scan.id, {
  findings: [{
    category: "code_quality",
    severity: "minor",
    claim: "A cited static finding is retained when runtime startup is unavailable.",
    citation: { type: "file", filePath: "package.json" },
    confidence: "verified",
  }],
});
await runRuntimeStage(scan.id);
const result = getScan(scan.id);
assert.equal(result?.status, "complete");
assert.equal(result?.runtimeCoverage?.targetSkippedReason, "repo_not_runnable");
assert.equal(result?.findings.length, 1);
assert.match(result?.notAssessed.join("\n") ?? "", /Runtime testing didn't run/);
console.log(`Live repo_not_runnable runtime path passed for ${repoUrl}: static findings were retained and the scan completed without a failure state.`);

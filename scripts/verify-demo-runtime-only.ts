import assert from "node:assert/strict";
import { runDemoRuntimeOnly } from "@/lib/agents/orchestrator";
import { createScan, getScan, updateScan } from "@/lib/scans/memory-store";

const scan = createScan("https://github.com/vercel/nextjs-portfolio-starter", { mode: "demo_app" });
let called = false;
await runDemoRuntimeOnly(scan.id, {
  runRuntime: async (scanId) => {
    called = true;
    updateScan(scanId, { status: "complete", completedAt: new Date().toISOString() });
  },
});
const result = getScan(scan.id);
assert.equal(called, true);
assert.equal(result?.status, "complete");
assert.match(result?.notAssessed.join("\n") ?? "", /Static-agent analysis was not run/);
assert.match(result?.events.map((event) => event.message).join("\n") ?? "", /Quick demo runs the controlled runtime fixture/);
console.log("Quick demo runtime-only verification passed: static analysis is explicitly not assessed before runtime execution.");

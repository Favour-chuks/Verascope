import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runSandboxRuntimeBehavior } from "@/lib/runtime/sandbox-executor";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

const result = await runSandboxRuntimeBehavior({
  status: "ready",
  mode: "demo_app",
  baseUrl: "http://127.0.0.1:3100",
  policyCandidates: ["/privacy"],
  close: async () => undefined,
  target: { mode: "demo_app" },
});

assert.equal(result.coverage.targetMode, "demo_app");
assert.equal(result.coverage.flowsTested.includes("checkout-without-referrer"), true);
assert.equal(result.findings.some((finding) => finding.citation.type === "network_trace" && finding.citation.check === "attribution_override" && finding.severity === "critical"), true);
assert.equal(result.findings.some((finding) => finding.citation.type === "network_trace" && finding.citation.check === "pre_interaction"), true);
assert.equal(result.findings.every((finding) => JSON.stringify(finding).includes("verascope-upstream-referrer") === false), true);
console.log("Snapshot-resident runtime executor passed: the controlled demo produced cited attribution and consent-timing findings with no credential values retained.");

import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";
import { createDemoStorefront } from "@/lib/demo-storefront/server";
import { validateRuntimeFinding } from "@/lib/runtime/guardrails";
import { runRuntimeBehavior } from "@/lib/runtime/runtime-stage";

const server = createDemoStorefront();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Demo fixture did not bind a TCP port.");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  // Development fallback for fixture mechanics only. Production runs from the
  // browser snapshot's bundled Chromium configuration.
  const output = await runRuntimeBehavior({
    status: "ready", mode: "demo_app", baseUrl, policyCandidates: ["/privacy"], target: { mode: "demo_app" }, close: async () => undefined,
  }, {
    traceTarget: async (traceBaseUrl) => (await import("@/lib/runtime/network-trace")).runNetworkTrace(traceBaseUrl, "demo_app", {
      includeDiscovery: false,
      launchBrowser: async () => chromium.launch({ headless: true }),
    }),
  });
  const attribution = output.findings.find((finding) => finding.citation.type === "network_trace" && finding.citation.check === "attribution_override");
  assert.ok(attribution, "Expected a planted attribution-override finding.");
  assert.equal(attribution.severity, "critical");
  assert.equal(attribution.citation.type, "network_trace");
  assert.equal(attribution.citation.flow, "checkout-with-simulated-referrer");
  assert.equal(validateRuntimeFinding(attribution).accepted, true);
  assert.ok(output.findings.some((finding) => finding.citation.type === "network_trace" && finding.citation.check === "pre_interaction"), "Expected a planted consent-timing finding.");
  console.log(`Runtime demo mechanics passed at ${baseUrl}: planted attribution override and consent timing were both observed with cited request metadata.`);
} finally {
  server.close();
  await once(server, "close");
}

import { createRequire } from "node:module";
import { RuntimeEgressLedger } from "@/lib/runtime/target-resolution";
import { VercelRuntimeSandbox } from "@/lib/runtime/vercel-runtime-sandbox";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());
const ledger = await RuntimeEgressLedger.create("https://example.com");
console.log("Runtime sandbox preflight: acquiring the named snapshot sandbox.");
const sandbox = await VercelRuntimeSandbox.create(ledger, 60_000);
try {
  console.log("Runtime sandbox preflight: lease acquired; launching bundled Chromium.");
  const preflight = await sandbox.exec("sh", ["-lc", "cd /opt/verascope-playwright && PLAYWRIGHT_BROWSERS_PATH=/opt/verascope-playwright-browsers node --input-type=module -e \"import { chromium } from 'playwright'; const browser = await chromium.launch({ headless: true }); await browser.close(); console.log('Bundled Chromium launch passed from snapshot.');\""]);
  console.log("Scoped Vercel snapshot-based runtime sandbox created with an exact-host deny-by-default network policy.");
  if (preflight.exitCode !== 0) throw new Error(`Snapshot browser preflight failed: ${preflight.output}`);
  console.log(`Runtime browser preflight: ${preflight.output.trim()}`);
} finally {
  console.log("Runtime sandbox preflight: restoring deny-all egress and stopping the lease.");
  await sandbox.close();
  console.log("Scoped Vercel snapshot-based runtime sandbox stopped; no target fetch was performed.");
}

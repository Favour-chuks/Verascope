import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportView } from "@/components/scan-view";
import { synthesizeReport } from "@/lib/reports/synthesis";
import { runSandboxRuntimeBehavior } from "@/lib/runtime/sandbox-executor";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

const runtime = await runSandboxRuntimeBehavior({
  status: "ready",
  mode: "demo_app",
  baseUrl: "http://127.0.0.1:3100",
  policyCandidates: ["/privacy"],
  close: async () => undefined,
  target: { mode: "demo_app" },
});
const report = synthesizeReport({
  findings: runtime.findings,
  notAssessed: [
    ...runtime.notChecked,
    "Static-agent analysis was not run for this runtime-only controlled-demo proof.",
  ],
  runtimeCoverage: runtime.coverage,
});
const html = renderToStaticMarkup(<ReportView report={report} />);
assert.match(html, /Runtime testing — Quick demo/);
assert.match(html, /attribution override/i);
assert.match(html, /NETWORK TRACE/);
assert.match(html, /Static-agent analysis was not run/);
assert.equal(/verascope-upstream-referrer|alder-row-override-token/.test(html), false);
console.log("Live demo report verification passed: a snapshot-observed demo finding rendered with coverage, citations, and explicit static-analysis limits.");

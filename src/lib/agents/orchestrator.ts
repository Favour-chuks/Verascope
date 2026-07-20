import { memoryScanStore, type ScanStore } from "@/lib/scans/scan-store";
import {
  buildStaticAuditDefinition,
  resolveStaticSandboxClient,
  runStaticAgent,
  stageStaticAuditEvidence,
} from "@/lib/agents/static-agents";
import { getGeminiAuditEnvironment } from "@/lib/config/env";
import { runRuntimeStage } from "@/lib/runtime/orchestrator";

function extractErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : "unknown_error";
  try {
    const parsed = JSON.parse(detail);
    if (parsed && typeof parsed === "object") {
      if (parsed.error && typeof parsed.error.message === "string") return parsed.error.message;
      if (typeof parsed.message === "string") return parsed.message;
    }
  } catch {
    // Not JSON, fall through
  }
  return detail;
}

/**
 * Quick demo is deliberately useful without a reasoning-model call. It runs
 * only the controlled runtime fixture and labels Agents 1–2 as not assessed;
 * it never represents this as a full repository audit.
 */
export async function runDemoRuntimeOnly(
  scanId: string,
  options: { runRuntime?: typeof runRuntimeStage; store?: ScanStore } = {},
) {
  const store = options.store ?? memoryScanStore;
  const scan = await store.getScan(scanId);
  if (!scan) throw new Error("scan_not_found");
  if (scan.runtimeTarget.mode !== "demo_app") throw new Error("demo_runtime_only_requires_demo_target");
  await store.updateScan(scanId, {
    notAssessed: [...scan.notAssessed, "Static-agent analysis was not run for this controlled runtime-only demo."],
    currentStageDetail: "Starting the controlled demo runtime check.",
  });
  await store.appendScanEvent(scanId, "Quick demo runs the controlled runtime fixture; static-agent analysis is explicitly not assessed.");
  await (options.runRuntime ?? runRuntimeStage)(scanId, { store });
}

export async function runStaticStages(scanId: string, options: { store?: ScanStore } = {}) {
  const store = options.store ?? memoryScanStore;
  const scan = await store.getScan(scanId);
  if (!scan) throw new Error("scan_not_found");
  try {
    // Fail before staging a public repository if the required reasoning model
    // is not configured. When it is configured, Agents 1 and 2 share this
    // single, immutable sandbox evidence snapshot.
    getGeminiAuditEnvironment();
    await store.appendScanEvent(scanId, "Static evidence passes: find (file/module map); git --no-pager shortlog -s -n HEAD; rg (secret and AI-provider path signals); package-manager audit and license inventory.");
    const evidence = await stageStaticAuditEvidence(
      buildStaticAuditDefinition("code_health", scan.repoUrl),
      resolveStaticSandboxClient(),
    );

    await store.updateScan(scanId, { status: "running_code_health", currentStageDetail: "Running Code Health Agent" });
    await store.appendScanEvent(scanId, "Gemini pass: Code Health + team/key-person risk.");
    const codeHealth = await runStaticAgent("code_health", scan.repoUrl, { evidence });

    await store.updateScan(scanId, { status: "running_security", currentStageDetail: "Running Security, License & Static AI-Vendor Exposure Agent" });
    await store.appendScanEvent(scanId, "Gemini pass: Security, license, and static AI-vendor exposure.");
    const security = await runStaticAgent("security_license_ai", scan.repoUrl, { evidence });

    await store.updateScan(scanId, {
      currentStageDetail: "Static audit complete; starting runtime stage.",
      findings: [...codeHealth.findings, ...security.findings],
      notAssessed: [...codeHealth.notChecked, ...security.notChecked],
    });
    await store.appendScanEvent(scanId, "Static passes complete; entering runtime passes.");
    await runRuntimeStage(scanId, { store });
  } catch (error) {
    const detail = extractErrorMessage(error);
    await store.updateScan(scanId, { status: "failed", currentStageDetail: detail, completedAt: new Date().toISOString() });
    await store.appendScanEvent(scanId, `Static audit failed: ${detail}`);
  }
}

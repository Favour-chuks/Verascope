import type { Finding } from "@/lib/schemas/findings";
import { memoryScanStore, type ScanStore } from "@/lib/scans/scan-store";
import { RUNTIME_LIMITATIONS } from "@/lib/runtime/guardrails";
import { runSandboxRuntimeBehavior } from "@/lib/runtime/sandbox-executor";
import { resolveRuntimeTarget } from "@/lib/runtime/target-resolution";
import type { ResolvedRuntimeTarget, RuntimeStageResult } from "@/lib/runtime/types";

export type RuntimeExecutor = (target: Extract<ResolvedRuntimeTarget, { status: "ready" }>) => Promise<RuntimeStageResult>;
export type RuntimeResolution = (target: Parameters<typeof resolveRuntimeTarget>[0], options: Parameters<typeof resolveRuntimeTarget>[1]) => Promise<ResolvedRuntimeTarget>;

function skippedCoverage() {
  return {
    targetMode: "repo_build" as const,
    targetSkippedReason: "repo_not_runnable",
    flowsTested: [],
    cnameCheckPerformed: false,
    stealthPosture: "none" as const,
    fingerprintParityScore: null,
    consentAttested: false,
    consentAttestedAt: null,
    limitationsNote: RUNTIME_LIMITATIONS,
  };
}

function runtimeStartMessage(target: Parameters<typeof resolveRuntimeTarget>[0]) {
  if (target.mode === "demo_app") return "Testing runtime behavior against the demo storefront...";
  if (target.mode === "repo_build") return "Testing runtime behavior against your repository build...";
  try {
    return "Testing runtime behavior against " + new URL(target.targetUrl).hostname + "...";
  } catch {
    return "Testing runtime behavior against the selected live URL...";
  }
}

/**
 * Enters the runtime state only after static stages. repo_not_runnable takes
 * the calm skipped path; it never becomes a failed scan or discards findings.
 */
export async function runRuntimeStage(scanId: string, options: { resolve?: RuntimeResolution; execute?: RuntimeExecutor; store?: ScanStore } = {}) {
  const store = options.store ?? memoryScanStore;
  const scan = await store.getScan(scanId);
  if (!scan) throw new Error("scan_not_found");
  const resolve = options.resolve ?? resolveRuntimeTarget;
  try {
    await store.updateScan(scanId, { status: "running_runtime_behavior", currentStageDetail: "Resolving the selected runtime target." });
    await store.appendScanEvent(scanId, runtimeStartMessage(scan.runtimeTarget));
    const target = await resolve(scan.runtimeTarget, { repoUrl: scan.repoUrl });
    if (target.status === "skipped") {
      const coverage = skippedCoverage();
      await store.updateScan(scanId, {
        status: "synthesizing",
        currentStageDetail: "Runtime target unavailable; preparing static-only report.",
        runtimeCoverage: coverage,
        notAssessed: [...scan.notAssessed, `Runtime testing didn't run — ${target.detail}. Static findings are unaffected.`],
      });
      await store.appendScanEvent(scanId, `Runtime stage skipped: repo_not_runnable (${target.detail}).`);
      await store.updateScan(scanId, { status: "complete", currentStageDetail: "Static-only report complete.", completedAt: new Date().toISOString() });
      await store.appendScanEvent(scanId, "Scan complete with runtime stage skipped.");
      return;
    }
    try {
      // The snapshot-resident executor is mandatory for every runnable runtime
      // check. repo_build reaches only its short-lived provider bridge; it
      // cannot dynamically admit third-party subresources.
      const execute = options.execute ?? ((readyTarget: Extract<ResolvedRuntimeTarget, { status: "ready" }>) => {
        return runSandboxRuntimeBehavior(readyTarget);
      });
      const runtime = await execute(target);
      const coverage = target.mode === "user_url"
        ? { ...runtime.coverage, consentAttested: true, consentAttestedAt: scan.consentAttestedAt }
        : runtime.coverage;
      const survivors: Finding[] = runtime.findings;
      await store.updateScan(scanId, {
        status: "synthesizing",
        currentStageDetail: "Preparing report with runtime coverage.",
        findings: [...scan.findings, ...survivors],
        runtimeCoverage: coverage,
        notAssessed: [...scan.notAssessed, ...runtime.notChecked],
      });
      await store.appendScanEvent(scanId, `Runtime passes: ${coverage.flowsTested.join(", ") || "none completed"}.`);
      await store.updateScan(scanId, { status: "complete", currentStageDetail: "Scan complete.", completedAt: new Date().toISOString() });
      await store.appendScanEvent(scanId, "Scan complete.");
    } finally {
      await target.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "runtime_stage_failed";
    await store.updateScan(scanId, { status: "failed", currentStageDetail: detail, completedAt: new Date().toISOString() });
    await store.appendScanEvent(scanId, `Runtime stage failed: ${detail}`);
  }
}

import { checkCnameCloaking, cnameFinding } from "@/lib/runtime/cname-check";
import { validateRuntimeFinding } from "@/lib/runtime/guardrails";
import { runNetworkTrace } from "@/lib/runtime/network-trace";
import { extractDisclosureClaims } from "@/lib/runtime/policy";
import { buildRuntimeFindings } from "@/lib/runtime/runtime-findings";
import type { ResolvedRuntimeTarget, RuntimeStageResult, RuntimeTraceResult } from "@/lib/runtime/types";

export type RuntimeStageOptions = {
  /** Required for repo_build/user_url so policy fetching stays in the same runtime sandbox as the target. */
  readPolicy?: (candidates: string[]) => Promise<{ source: string; document: string } | null>;
  traceTarget?: (baseUrl: string, mode: ResolvedRuntimeTarget extends { mode: infer M } ? M : never) => Promise<RuntimeTraceResult>;
};

function relatedHost(targetHost: string, candidateHost: string) {
  return candidateHost === targetHost || candidateHost.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${candidateHost}`);
}

async function readDemoPolicy(target: Extract<ResolvedRuntimeTarget, { status: "ready" }>) {
  for (const candidate of target.policyCandidates) {
    const url = new URL(candidate, target.baseUrl);
    if (url.origin !== new URL(target.baseUrl).origin) continue;
    const response = await fetch(url);
    if (response.ok) return { source: url.pathname, document: await response.text() };
  }
  return null;
}

/** Runs the five deterministic Agent 3 sub-stages over a resolved target. */
export async function runRuntimeBehavior(target: Extract<ResolvedRuntimeTarget, { status: "ready" }>, options: RuntimeStageOptions = {}): Promise<RuntimeStageResult> {
  // User URL traffic is never sent through the app host. A caller must provide
  // a sandbox-resident trace and policy reader backed by the scoped egress adapter.
  if (target.mode === "user_url" && (!options.traceTarget || !options.readPolicy)) {
    throw new Error("runtime_egress_executor_missing");
  }
  const policySource = options.readPolicy
    ? await options.readPolicy(target.policyCandidates)
    : await readDemoPolicy(target);
  const policy = policySource ? extractDisclosureClaims(policySource.document, policySource.source) : [];
  const trace = options.traceTarget
    ? await options.traceTarget(target.baseUrl, target.mode)
    : await runNetworkTrace(target.baseUrl, target.mode);
  const result = buildRuntimeFindings(trace, policy);

  const baseHost = new URL(target.baseUrl).hostname;
  const cnameTraces = trace.allTraces.filter((entry) => relatedHost(baseHost, entry.host.split(":")[0]));
  const cnameResults = await checkCnameCloaking(cnameTraces.map((entry) => entry.host.split(":")[0]));
  for (const cname of cnameResults) {
    const entry = cnameTraces.find((traceEntry) => traceEntry.host.split(":")[0] === cname.host);
    if (!entry) continue;
    const finding = cnameFinding(cname, entry);
    if (finding) result.findings.push(finding);
  }
  result.coverage.cnameCheckPerformed = true;
  result.notChecked = result.notChecked.filter((item) => item !== "CNAME cloaking cross-check has not run yet.");

  const survivors = [];
  for (const finding of result.findings) {
    const guarded = validateRuntimeFinding(finding);
    if (guarded.accepted) survivors.push(guarded.finding);
    else if (target.mode === "user_url" && guarded.reason === "real_user_data") {
      throw new Error("runtime_real_user_data_detected");
    }
  }
  result.findings = survivors;
  return result;
}

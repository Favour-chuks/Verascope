import type { Finding } from "@/lib/schemas/findings";
import { RUNTIME_LIMITATIONS } from "@/lib/runtime/guardrails";
import type { DisclosedClaim, RuntimeCoverage, RuntimeStageResult, RuntimeTraceResult } from "@/lib/runtime/types";

function networkCitation(trace: RuntimeTraceResult["allTraces"][number], check = trace.check): Finding["citation"] {
  return {
    type: "network_trace",
    host: trace.host,
    method: trace.method,
    check,
    flow: trace.flow,
    timingMs: trace.timingMs,
    payloadSummary: trace.payloadSummary,
  };
}

function policyMentions(policy: DisclosedClaim[], expression: RegExp) {
  return policy.find((claim) => expression.test(claim.text)) ?? null;
}

export function buildRuntimeCoverage(trace: RuntimeTraceResult, consentAttested = false, consentAttestedAt: string | null = null): RuntimeCoverage {
  return {
    targetMode: trace.targetMode,
    targetSkippedReason: null,
    flowsTested: trace.flowsTested,
    cnameCheckPerformed: false,
    stealthPosture: "none",
    fingerprintParityScore: null,
    consentAttested,
    consentAttestedAt,
    limitationsNote: RUNTIME_LIMITATIONS,
  };
}

/** Converts deterministic, cited observations into factual runtime findings. */
export function buildRuntimeFindings(trace: RuntimeTraceResult, policy: DisclosedClaim[]): RuntimeStageResult {
  const findings: Finding[] = [];
  const notChecked: string[] = [
    "CNAME cloaking cross-check has not run yet.",
    "Fingerprint-parity self-test has not run yet.",
  ];
  const attribution = trace.attribution;
  if (attribution?.credentialOverwritten && attribution.requestWithoutAffiliateClick && attribution.trace) {
    const policyClaim = policyMentions(policy, /preserve.*(?:affiliate|referral)|(?:affiliate|referral).*preserve/i);
    findings.push({
      category: "runtime_disclosure",
      severity: "critical",
      claim: "A pre-set upstream referral credential changed during checkout even though no affiliate or promotional control was clicked.",
      whyItMatters: "This observed attribution replacement can misattribute a referral and is flagged for legal/compliance review.",
      citation: networkCitation(attribution.trace, "attribution_override"),
      disclosedClaim: policyClaim?.text ?? null,
      disclosedClaimLocation: policyClaim?.location ?? null,
      outcome: policyClaim ? "contradicted" : "undisclosed",
      confidence: "verified",
    });
  }

  for (const unscripted of trace.unscriptedRequests) {
    if (unscripted.flow === "checkout-with-simulated-referrer") continue;
    findings.push({
      category: "runtime_disclosure",
      severity: "minor",
      claim: "A request was observed without a preceding user click in the tested flow.",
      whyItMatters: "This broader signal can be ordinary analytics or initialization behavior; it does not by itself establish attribution replacement.",
      citation: networkCitation(unscripted, "unscripted"),
      outcome: "undisclosed",
      confidence: "heuristic",
    });
  }

  const analyticsPolicy = policyMentions(policy, /analytics.*(?:only after|after).*accept|begin analytics.*accept/i);
  const preInteractionAnalytics = trace.consentPasses.find((pass) => pass.check === "pre_interaction")?.traces
    .find((request) => /analytics/i.test(request.path));
  if (analyticsPolicy && preInteractionAnalytics) {
    findings.push({
      category: "runtime_disclosure",
      severity: "notable",
      claim: "An analytics request was observed before any consent interaction in the tested flow.",
      whyItMatters: "The observed timing differs from the policy statement and is flagged for legal/compliance review.",
      citation: networkCitation(preInteractionAnalytics, "pre_interaction"),
      disclosedClaim: analyticsPolicy.text,
      disclosedClaimLocation: analyticsPolicy.location,
      outcome: "contradicted",
      confidence: "verified",
    });
  }

  return { findings, coverage: buildRuntimeCoverage(trace), notChecked };
}

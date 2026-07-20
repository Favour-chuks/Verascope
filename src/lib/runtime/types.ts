import type { RuntimeTarget, TargetMode } from "@/lib/domain";
import type { Finding } from "@/lib/schemas/findings";

export type RuntimeCheck =
  | "attribution_override"
  | "unscripted"
  | "pre_interaction"
  | "consent_declined"
  | "consent_accepted"
  | "cname";

export type NetworkTrace = {
  host: string;
  method: string;
  path: string;
  flow: string;
  check: RuntimeCheck;
  timingMs: number | null;
  payloadSummary: string;
  hadPrecedingClick: boolean;
  sameOrigin: boolean;
};

export type AttributionObservation = {
  flow: "checkout-with-simulated-referrer";
  upstreamCredentialSeeded: boolean;
  credentialOverwritten: boolean;
  requestWithoutAffiliateClick: boolean;
  trace: NetworkTrace | null;
};

export type ConsentPass = {
  check: "pre_interaction" | "consent_declined" | "consent_accepted";
  traces: NetworkTrace[];
};

export type RuntimeTraceResult = {
  targetMode: TargetMode;
  flowsTested: string[];
  consentPasses: ConsentPass[];
  attribution: AttributionObservation | null;
  unscriptedRequests: NetworkTrace[];
  allTraces: NetworkTrace[];
  browserPosture: "standard_headless";
};

export type DisclosedClaim = {
  text: string;
  location: string;
  kind: "attribution" | "consent" | "analytics" | "general";
};

export type RuntimeCoverage = {
  targetMode: TargetMode;
  targetSkippedReason: string | null;
  flowsTested: string[];
  cnameCheckPerformed: boolean;
  stealthPosture: "none";
  fingerprintParityScore: string | null;
  consentAttested: boolean;
  consentAttestedAt: string | null;
  limitationsNote: string;
};

export type RuntimeStageResult = {
  findings: Finding[];
  coverage: RuntimeCoverage;
  notChecked: string[];
};

export type ResolvedRuntimeTarget =
  | {
      status: "ready";
      mode: TargetMode;
      baseUrl: string;
      policyCandidates: string[];
      close: () => Promise<void>;
      target: RuntimeTarget;
    }
  | {
      status: "skipped";
      mode: "repo_build";
      reason: "repo_not_runnable";
      detail: string;
      target: RuntimeTarget;
    };

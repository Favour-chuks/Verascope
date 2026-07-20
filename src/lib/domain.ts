export const TARGET_MODES = ["demo_app", "repo_build", "user_url"] as const;
export type TargetMode = (typeof TARGET_MODES)[number];

export type RuntimeTarget =
  | { mode: "demo_app" }
  | { mode: "repo_build"; buildCommand?: string; startCommand?: string }
  | { mode: "user_url"; targetUrl: string; consentAttestation: true };

export type ScanStatus =
  | "queued"
  | "running_code_health"
  | "running_security"
  | "running_runtime_behavior"
  | "synthesizing"
  | "complete"
  | "failed";

export type CitationCheck =
  | "attribution_override"
  | "unscripted"
  | "pre_interaction"
  | "consent_declined"
  | "consent_accepted"
  | "cname";

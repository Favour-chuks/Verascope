import type { Finding } from "@/lib/schemas/findings";
import type { RuntimeCoverage } from "@/lib/runtime/types";

const LEGAL_CONCLUSION = /\b(illegal|unlawful|violates?\s+(?:the\s+)?(?:law|gdpr|ccpa|regulation)|non[-\s]?compliant|in\s+breach\s+of)\b/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE = /(?:\+?\d[\s().-]?){7,}\d/;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const CARD = /\b(?:\d[ -]?){13,19}\b/;

export type RuntimeFindingGuardResult =
  | { accepted: true; finding: Finding }
  | { accepted: false; reason: "missing_network_citation" | "real_user_data" | "legal_conclusion" };

/** A deliberately conservative detector: it protects stored trace summaries, not a substitute for a DLP system. */
export function looksLikeRealPii(value: string) {
  return EMAIL.test(value) || PHONE.test(value) || SSN.test(value) || CARD.test(value);
}

export function containsLegalConclusionLanguage(value: string) {
  return LEGAL_CONCLUSION.test(value);
}

export function validateRuntimeFinding(finding: Finding): RuntimeFindingGuardResult {
  if (finding.citation.type !== "network_trace" || !finding.citation.host || !finding.citation.method || !finding.citation.flow) {
    return { accepted: false, reason: "missing_network_citation" };
  }
  if (looksLikeRealPii(finding.citation.payloadSummary)) return { accepted: false, reason: "real_user_data" };
  if (containsLegalConclusionLanguage(finding.claim) || containsLegalConclusionLanguage(finding.whyItMatters ?? "")) {
    return { accepted: false, reason: "legal_conclusion" };
  }
  return { accepted: true, finding };
}

export function hasCompleteRuntimeCoverage(findings: Finding[], coverage: RuntimeCoverage | null | undefined) {
  return !findings.some((finding) => finding.category === "runtime_disclosure") || Boolean(coverage?.limitationsNote.trim());
}

export const RUNTIME_LIMITATIONS = "All target modes currently use the same standard, non-hardened headless bundled Chromium configuration; no browser-hardening distinction is applied to user_url mode. Clean runtime behavior across the tested flows is evidence, not certification. This checks observable behavior against disclosure, not lawful basis, data retention, DPAs, or the full scope of a regulator's review.";

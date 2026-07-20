import type { Finding } from "@/lib/schemas/findings";
import { hasCompleteRuntimeCoverage } from "@/lib/runtime/guardrails";
import type { RuntimeCoverage } from "@/lib/runtime/types";

export type SynthesizedReport = {
  executiveSummary: string;
  findings: Finding[];
  notAssessed: string[];
  runtimeCoverage: RuntimeCoverage | null;
  generatedAt: string;
};

const severityRank: Record<Finding["severity"], number> = { critical: 0, notable: 1, minor: 2 };
const baselineNotAssessed = [
  "Architecture beyond basic module mapping was not assessed.",
  "Roadmap credibility was not assessed.",
];

function hasCitation(finding: Finding) {
  const citation = finding.citation;
  if (citation.type === "file") return Boolean(citation.filePath);
  if (citation.type === "command") return Boolean(citation.command && citation.output);
  return Boolean(citation.host && citation.method && citation.check && citation.flow);
}

function runtimeFraming(finding: Finding) {
  if (finding.category !== "runtime_disclosure") return finding;
  const whyItMatters = (finding.whyItMatters ?? "The observed behavior is presented for review.")
    .replace(/\b(?:illegal|unlawful|non[-\s]?compliant|in breach)\b/gi, "concerning")
    .replace(/\bviolates?\s+(?:the\s+)?(?:law|gdpr|ccpa|regulation)\b/gi, "differs from the stated expectation");
  return {
    ...finding,
    whyItMatters: whyItMatters.endsWith("flagged for legal/compliance review.")
      ? whyItMatters
      : whyItMatters.replace(/[. ]+$/, "") + ". Flagged for legal/compliance review.",
  };
}

export function synthesizeReport(input: {
  findings: Finding[];
  notAssessed: string[];
  runtimeCoverage: RuntimeCoverage | null;
  generatedAt?: string;
}): SynthesizedReport {
  const cited = input.findings.filter(hasCitation).map(runtimeFraming)
    .sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);
  const hasRuntimeFindings = cited.some((finding) => finding.category === "runtime_disclosure");
  if (hasRuntimeFindings && !hasCompleteRuntimeCoverage(cited, input.runtimeCoverage)) {
    throw new Error("citation_validation_failed");
  }
  const lead = cited.slice(0, 5);
  const executiveSummary = lead.length
    ? String(cited.length) + " cited finding" + (cited.length === 1 ? "" : "s") + " surfaced in this audit. " + lead.map((finding) => finding.claim).join(" ")
    : "No cited findings are available in this report. The coverage and not-assessed sections describe what did and did not run.";
  return {
    executiveSummary,
    findings: cited,
    notAssessed: [...new Set([...input.notAssessed, ...baselineNotAssessed])],
    runtimeCoverage: input.runtimeCoverage,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

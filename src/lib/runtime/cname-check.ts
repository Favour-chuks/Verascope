import { resolveCname } from "node:dns/promises";
import type { Finding } from "@/lib/schemas/findings";
import type { NetworkTrace } from "@/lib/runtime/types";

// A deliberately small, reviewable list. This detects classic CNAME cloaking
// only; generic cloud endpoints and direct server-side tracking are not covered.
const TRACKING_CNAME_SUFFIXES = ["2o7.net", "omtrdc.net", "demdex.net", "go-mpulse.net", "pardot.com"];

function hasDomainSuffix(host: string, suffix: string) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export type CnameCheckResult = { host: string; chain: string[]; matchedProvider: string | null };

export async function checkCnameCloaking(hosts: string[]): Promise<CnameCheckResult[]> {
  const results: CnameCheckResult[] = [];
  for (const host of [...new Set(hosts)]) {
    try {
      const chain = await resolveCname(host);
      const matchedProvider = chain.find((value) => TRACKING_CNAME_SUFFIXES.some((suffix) => hasDomainSuffix(value, suffix))) ?? null;
      results.push({ host, chain, matchedProvider });
    } catch {
      results.push({ host, chain: [], matchedProvider: null });
    }
  }
  return results;
}

export function cnameFinding(result: CnameCheckResult, trace: NetworkTrace): Finding | null {
  if (!result.matchedProvider) return null;
  return {
    category: "runtime_disclosure",
    severity: "notable",
    claim: `A same-site request host resolved through a known tracking-provider CNAME pattern (${result.matchedProvider}).`,
    whyItMatters: "This detects the classic CNAME-cloaked subset of tracking; generic cloud endpoints and direct server-side tracking can evade this check.",
    citation: {
      type: "network_trace",
      host: trace.host,
      method: trace.method,
      check: "cname",
      flow: trace.flow,
      timingMs: trace.timingMs,
      payloadSummary: `CNAME chain: ${result.chain.join(" -> ")}`,
    },
    outcome: "undisclosed",
    confidence: "verified",
  };
}

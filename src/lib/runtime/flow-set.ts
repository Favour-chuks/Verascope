import type { TargetMode } from "@/lib/domain";

export const DEFAULT_RUNTIME_FLOWS = [
  "home",
  "checkout-with-simulated-referrer",
  "checkout-without-referrer",
] as const;

export type RuntimeFlowName = (typeof DEFAULT_RUNTIME_FLOWS)[number] | "account-login" | `discovered:${string}`;

export function defaultRuntimeFlows(_mode: TargetMode): RuntimeFlowName[] {
  return [...DEFAULT_RUNTIME_FLOWS];
}

/** Never accepts an external URL: discovery may add only routes owned by the resolved target host. */
export function sameOriginPaths(baseUrl: string, hrefs: string[], maximum = 4): string[] {
  const base = new URL(baseUrl);
  const paths = new Set<string>();
  for (const href of hrefs) {
    try {
      const candidate = new URL(href, base);
      if (candidate.origin !== base.origin || candidate.protocol !== base.protocol) continue;
      if (candidate.pathname === "/" || candidate.pathname === "/checkout") continue;
      paths.add(candidate.pathname + candidate.search);
      if (paths.size >= maximum) break;
    } catch {
      // A malformed link is not a flow and never becomes a fetch target.
    }
  }
  return [...paths];
}

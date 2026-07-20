import type { RuntimeTarget } from "@/lib/domain";
import { tryBuildAndStartInVercelSandbox } from "@/lib/sandbox/network-trace/try-build-start";
import { checkExternalUrl, type HostResolver } from "@/lib/sandbox/target-safety/ssrf-guard";
import type { ResolvedRuntimeTarget } from "@/lib/runtime/types";

/** Fixed, reviewed fingerprint-parity pages. They are the only non-target hosts that a user_url runtime may permit. */
export const FINGERPRINT_PARITY_HOSTS = ["bot.sannysoft.com", "arh.antoinevastel.com"] as const;

export type RuntimeEgressPolicy = { allow: string[] };

/**
 * Keeps user_url egress exact-host only. A subresource is admitted only after
 * it was observed by the browser and independently passed the same SSRF guard
 * used at submission time. It deliberately never accepts wildcards.
 */
export class RuntimeEgressLedger {
  private readonly allowedHosts: Set<string>;

  private constructor(initialHost: string, includeParityHosts: boolean) {
    this.allowedHosts = new Set([initialHost, ...(includeParityHosts ? FINGERPRINT_PARITY_HOSTS : [])]);
  }

  static async create(targetUrl: string, resolver?: HostResolver, options: { includeParityHosts?: boolean } = {}) {
    const result = await checkExternalUrl(targetUrl, resolver);
    return new RuntimeEgressLedger(result.url.hostname, options.includeParityHosts ?? true);
  }

  async admitObservedSubresource(url: string, resolver?: HostResolver) {
    const result = await checkExternalUrl(url, resolver);
    this.allowedHosts.add(result.url.hostname);
    return result.url.hostname;
  }

  policy(): RuntimeEgressPolicy {
    return { allow: [...this.allowedHosts] };
  }

  allows(host: string) {
    return this.allowedHosts.has(host);
  }
}

export type RuntimeResolutionOptions = {
  repoUrl: string;
  resolver?: HostResolver;
};

/**
 * Resolves exactly the selected mode. This function never falls back from a
 * failed repo build or rejected live URL to the demo storefront.
 */
export async function resolveRuntimeTarget(target: RuntimeTarget, options: RuntimeResolutionOptions): Promise<ResolvedRuntimeTarget> {
  if (target.mode === "demo_app") {
    // The controlled fixture starts inside the browser snapshot, not on the
    // application host. This placeholder loopback URL is never fetched by the
    // host; sandbox-executor replaces it with the isolated fixture target.
    return {
      status: "ready",
      mode: "demo_app",
      baseUrl: "http://127.0.0.1:3100",
      policyCandidates: ["/privacy"],
      close: async () => undefined,
      target,
    };
  }

  if (target.mode === "repo_build") {
    const build = await tryBuildAndStartInVercelSandbox(options.repoUrl, {
      buildCommand: target.buildCommand,
      startCommand: target.startCommand,
      installDependencies: true,
    });
    if (build.status === "repo_not_runnable") {
      return { status: "skipped", mode: "repo_build", reason: "repo_not_runnable", detail: build.reason, target };
    }
    return {
      status: "ready",
      mode: "repo_build",
      baseUrl: build.baseUrl,
      policyCandidates: ["/privacy", "/legal/privacy", "/PRIVACY.md"],
      close: build.stop,
      target,
    };
  }

  // This is intentionally the second, independent SSRF evaluation. The POST
  // route validates earlier; target resolution must not reuse that decision.
  await checkExternalUrl(target.targetUrl, options.resolver);
  return {
    status: "ready",
    mode: "user_url",
    baseUrl: target.targetUrl,
    policyCandidates: ["/privacy", "/privacy-policy", "/legal/privacy"],
    close: async () => undefined,
    target,
  };
}

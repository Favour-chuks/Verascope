import { VercelSandboxClient, type VercelSandboxClientOptions } from "@openai/agents-extensions/sandbox/vercel";

type LeaseableSession = {
  close?: () => Promise<void>;
  execCommand?: (args: { cmd: string; workdir?: string; maxOutputTokens?: number }) => Promise<string>;
  applyManifest?: (manifest: any) => Promise<void>;
};

type SessionCreateArgs = { manifest?: unknown };

/**
 * Reuses only sessions created by this process. Listing and attaching to an
 * arbitrary Vercel sandbox would not prove it is empty or exclusively ours,
 * which could leak one scan's repository/output into another scan.
 */
type VercelClientFactory = (options: VercelSandboxClientOptions) => Pick<VercelSandboxClient, "create">;

export class ManagedVercelPool {
  private readonly idle: LeaseableSession[] = [];

  constructor(private readonly clientFactory: VercelClientFactory = (options) => new VercelSandboxClient(options)) {}

  getClient(options: VercelSandboxClientOptions) {
    // Create a fresh client each call so every session uses the correct options
    // (exposedPorts, timeoutMs, etc.). Sessions are pooled separately; the
    // lightweight client factory object is not worth caching across calls.
    const backend = this.clientFactory(options);
    return {
      create: async (args?: SessionCreateArgs) => {
        const existing = this.idle.pop();
        if (!existing) return this.wrap(await backend.create(args as never));
        try {
          await this.reset(existing);
          if (!args?.manifest || !existing.applyManifest) throw new Error("sandbox_pool_manifest_unavailable");
          await existing.applyManifest(args.manifest);
          return this.wrap(existing);
        } catch (error) {
          await existing.close?.().catch(() => undefined);
          throw error;
        }
      },
    } as Pick<VercelSandboxClient, "create">;
  }

  private async reset(session: LeaseableSession) {
    if (!session.execCommand) throw new Error("sandbox_pool_exec_unavailable");
    // Repository paths are fixed by Verascope manifests. This never evaluates
    // target-controlled text and leaves no staged checkout or start logs.
    const output = await session.execCommand({
      cmd: "pkill -f '/workspace/repo' 2>/dev/null || true; rm -rf /workspace/repo /workspace/.verascope-*; test ! -e /workspace/repo; printf '__VERASCOPE_POOL_RESET_OK__'",
      maxOutputTokens: 200,
    });
    if (!output.includes("__VERASCOPE_POOL_RESET_OK__")) throw new Error("sandbox_pool_reset_unverified");
  }

  private wrap(session: LeaseableSession) {
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await this.reset(session);
        this.idle.push(session);
      } catch {
        await session.close?.().catch(() => undefined);
      }
    };
    return new Proxy(session, {
      get(target, key, receiver) {
        if (key === "close") return release;
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

/**
 * Separate pool instances per exposedPorts signature so that sessions created
 * without an exposed port (static agent staging) are never given to callers
 * that need resolveExposedPort(3000) (repo_build health bridge).
 */
const managedVercelPools = new Map<string, ManagedVercelPool>();

export function getManagedVercelSandboxClient(options: VercelSandboxClientOptions) {
  const poolKey = JSON.stringify((options.exposedPorts ?? []).slice().sort());
  if (!managedVercelPools.has(poolKey)) managedVercelPools.set(poolKey, new ManagedVercelPool());
  return managedVercelPools.get(poolKey)!.getClient(options);
}

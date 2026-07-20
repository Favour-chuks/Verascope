import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { getServerEnvironment, getVercelSandboxEnvironment } from "@/lib/config/env";
import { requireRuntimeBrowserSnapshotId, RUNTIME_BROWSER_SNAPSHOT } from "@/lib/runtime/browser-snapshot";
import type { RuntimeEgressLedger } from "@/lib/runtime/target-resolution";

export function networkPolicyForRuntime(ledger: RuntimeEgressLedger): NetworkPolicy {
  // Vercel's object-form policy is deny-by-default: no wildcard or broad
  // subnet is present. `RuntimeEgressLedger` owns every allow-list addition.
  return { allow: ledger.policy().allow };
}

/** A demo fixture is served inside the runtime sandbox and needs no egress. */
export function isolatedRuntimeNetworkPolicy(): NetworkPolicy {
  return { allow: [] };
}

type RuntimeSandboxSession = Pick<Sandbox, "updateNetworkPolicy" | "runCommand" | "stop" | "delete"> & {
  fs: Pick<Sandbox["fs"], "writeFile">;
  sourceSnapshotId?: string;
  tags?: Record<string, string>;
};

type RuntimeSandboxBackend = {
  getOrCreate(params: Parameters<typeof Sandbox.getOrCreate>[0]): Promise<RuntimeSandboxSession>;
  get(params: Parameters<typeof Sandbox.get>[0]): Promise<RuntimeSandboxSession>;
};

type RuntimeSandboxInventoryEntry = {
  name: string;
  tags?: Record<string, string>;
  currentSnapshotId?: string;
};

type RuntimeSandboxInventory = () => Promise<AsyncIterable<RuntimeSandboxInventoryEntry>>;

type RuntimeSandboxCreateOptions = {
  /** Test seam only. Production uses the configured named persistent sandbox. */
  backend?: RuntimeSandboxBackend;
  /** Test seam only. Production reads the provider's sandbox inventory. */
  listRuntimeSandboxes?: RuntimeSandboxInventory;
  sandboxName?: string;
};

const RUNTIME_SANDBOX_ROLE = "verascope-runtime";
const RESET_MARKER = "__VERASCOPE_RUNTIME_RESET_OK__";
const RUNTIME_RESET_COMMAND = [
  // PID files are written only by Verascope's two background-capable runtime
  // programs. Validate /proc before sending a signal so cleanup cannot affect
  // an unrelated process in a persistent sandbox.
  "stop_verascope_pid() { pidfile=\"$1\"; expected=\"$2\"; if [ -r \"$pidfile\" ]; then pid=$(tr -cd '0-9' < \"$pidfile\"); if [ -n \"$pid\" ] && [ -r \"/proc/$pid/cmdline\" ] && tr '\\000' ' ' < \"/proc/$pid/cmdline\" | grep -F -q \"$expected\"; then kill \"$pid\" 2>/dev/null || true; fi; fi; rm -f \"$pidfile\"; }",
  "stop_verascope_pid /tmp/verascope-runtime-runner.pid /opt/verascope-playwright/verascope-runtime-runner.mjs",
  "stop_verascope_pid /tmp/verascope-demo-storefront.pid /opt/verascope-playwright/verascope-demo-storefront.mjs",
  "rm -f /opt/verascope-playwright/verascope-runtime-runner.mjs /opt/verascope-playwright/verascope-demo-storefront.mjs /tmp/verascope-demo.log",
  "rm -rf /tmp/verascope-runtime-*",
  "test ! -e /opt/verascope-playwright/verascope-runtime-runner.mjs",
  "test ! -e /opt/verascope-playwright/verascope-demo-storefront.mjs",
  `printf '${RESET_MARKER}'`,
].join("; ");

function runtimeTags() {
  return {
    "verascope-role": RUNTIME_SANDBOX_ROLE,
    "verascope-snapshot": requireRuntimeBrowserSnapshotId(),
  };
}

function hasExpectedRuntimeMetadata(sandbox: RuntimeSandboxInventoryEntry | undefined) {
  return sandbox?.tags?.["verascope-role"] === RUNTIME_SANDBOX_ROLE
    && sandbox.tags["verascope-snapshot"] === requireRuntimeBrowserSnapshotId();
}

async function namedRuntimeSandbox(inventory: RuntimeSandboxInventory, name: string) {
  for await (const sandbox of await awaitProviderLease(inventory())) {
    if (sandbox.name === name) return sandbox;
  }
  return undefined;
}

function identityError(sandbox: RuntimeSandboxInventoryEntry | undefined) {
  const expectedSnapshotId = requireRuntimeBrowserSnapshotId();
  return new Error([
    "runtime_sandbox_identity_unverified",
    `found=${String(Boolean(sandbox))}`,
    `role_tag_match=${String(sandbox?.tags?.["verascope-role"] === RUNTIME_SANDBOX_ROLE)}`,
    `snapshot_tag_match=${String(sandbox?.tags?.["verascope-snapshot"] === expectedSnapshotId)}`,
  ].join(":"));
}

/**
 * The Vercel SDK can use unref'd transport handles. A CLI verifier has no
 * other active work while awaiting acquisition, so preserve the event loop
 * until the provider resolves or rejects. Server requests already have active
 * handles; this is still a no-op outside the pending operation.
 */
async function awaitProviderLease<T>(operation: Promise<T>) {
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    return await operation;
  } finally {
    clearInterval(keepAlive);
  }
}

/**
 * Runtime sessions are deliberately reused by a stable, named Vercel sandbox.
 * Each lease is scrubbed before use and returned to deny-all egress before it
 * is stopped. If either scrub cannot be verified, the named sandbox is deleted
 * rather than carrying a prior scan into a future one.
 */
export class VercelRuntimeSandbox {
  private constructor(private readonly sandbox: RuntimeSandboxSession) {}

  static async create(ledger: RuntimeEgressLedger | null, timeoutMs: number, options: RuntimeSandboxCreateOptions = {}) {
    const credentials = getVercelSandboxEnvironment();
    const environment = getServerEnvironment();
    const backend = options.backend ?? {
      getOrCreate: Sandbox.getOrCreate.bind(Sandbox),
      get: Sandbox.get.bind(Sandbox),
    } satisfies RuntimeSandboxBackend;
    const name = options.sandboxName ?? environment.VERCEL_RUNTIME_SANDBOX_NAME;
    const inventory = options.listRuntimeSandboxes ?? (() => Sandbox.list({
      token: credentials.token,
      projectId: credentials.projectId,
      teamId: credentials.teamId,
      namePrefix: name,
      sortBy: "name",
      limit: 50,
    }));
    const existing = await namedRuntimeSandbox(inventory, name);
    if (existing && !hasExpectedRuntimeMetadata(existing)) {
      // Preserve the historical fail-closed behavior for a colliding name:
      // stop it, but do not alter its files, policy, tags, or lifecycle.
      const unverified = await awaitProviderLease(backend.get({
        name, token: credentials.token, projectId: credentials.projectId, teamId: credentials.teamId,
      }));
      await unverified.stop().catch(() => undefined);
      throw identityError(existing);
    }
    const sandbox = await awaitProviderLease(backend.getOrCreate({
      name,
      token: credentials.token,
      projectId: credentials.projectId,
      teamId: credentials.teamId,
      source: { type: "snapshot", snapshotId: requireRuntimeBrowserSnapshotId() },
      timeout: timeoutMs,
      // Persistence reuses the reviewed browser snapshot while resetRuntime
      // ensures no scan-specific files/processes become reusable state.
      persistent: true,
      keepLastSnapshots: { count: 1 },
      tags: runtimeTags(),
      env: { CI: "1", PLAYWRIGHT_BROWSERS_PATH: RUNTIME_BROWSER_SNAPSHOT.browsersDirectory },
      networkPolicy: ledger ? networkPolicyForRuntime(ledger) : isolatedRuntimeNetworkPolicy(),
    }));
    // `Sandbox.get` can omit tags from its single-sandbox response even though
    // the provider inventory exposes them. Re-read the inventory after first
    // creation, and use its tags as the durable ownership/lineage marker.
    const verified = existing ?? await namedRuntimeSandbox(inventory, name);
    if (!hasExpectedRuntimeMetadata(verified)
      || (!existing && sandbox.sourceSnapshotId !== requireRuntimeBrowserSnapshotId())) {
      await sandbox.stop().catch(() => undefined);
      throw identityError(verified);
    }
    const runtime = new VercelRuntimeSandbox(sandbox);
    try {
      await sandbox.updateNetworkPolicy(ledger ? networkPolicyForRuntime(ledger) : isolatedRuntimeNetworkPolicy());
      await runtime.resetRuntimeSession();
      return runtime;
    } catch (error) {
      await sandbox.delete().catch(() => undefined);
      throw error;
    }
  }

  private async resetRuntimeSession() {
    const result = await this.sandbox.runCommand({ cmd: "sh", args: ["-lc", RUNTIME_RESET_COMMAND] });
    const output = await result.output("both");
    if (result.exitCode !== 0 || !output.includes(RESET_MARKER)) {
      // The reset command neither reads scan data nor target files. Keeping a
      // short normalized diagnostic here makes provider/runtime incompatibility
      // actionable without weakening the fail-closed reuse rule.
      const diagnostic = output.replace(/[\r\n]+/g, " ").trim().slice(0, 500) || "<empty>";
      throw new Error(`runtime_sandbox_reset_unverified:exit=${String(result.exitCode)}:output=${diagnostic}`);
    }
  }

  async applyObservedSubresource(ledger: RuntimeEgressLedger, url: string) {
    await ledger.admitObservedSubresource(url);
    await this.sandbox.updateNetworkPolicy(networkPolicyForRuntime(ledger));
  }

  async exec(command: string, args: string[] = []) {
    const result = await this.sandbox.runCommand({ cmd: command, args });
    return { exitCode: result.exitCode, output: await result.output("both") };
  }

  async writeFile(path: string, content: string) {
    await this.sandbox.fs.writeFile(path, content);
  }

  async close() {
    try {
      await this.resetRuntimeSession();
      // A stored persistent snapshot must never retain a previous target's
      // dynamic egress additions between scans.
      await this.sandbox.updateNetworkPolicy(isolatedRuntimeNetworkPolicy());
      await this.sandbox.stop();
    } catch (error) {
      await this.sandbox.delete().catch(() => undefined);
      throw error;
    }
  }
}

export const runtimeSandboxInternals = {
  RUNTIME_SANDBOX_ROLE,
  RESET_MARKER,
  RUNTIME_RESET_COMMAND,
  hasExpectedRuntimeMetadata,
};

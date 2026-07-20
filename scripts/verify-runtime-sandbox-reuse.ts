import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { NetworkPolicy } from "@vercel/sandbox";
import { RUNTIME_BROWSER_SNAPSHOT } from "@/lib/runtime/browser-snapshot";
import { VercelRuntimeSandbox } from "@/lib/runtime/vercel-runtime-sandbox";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());
process.env.VERCEL_PROJECT_ID ??= "prj_runtime_pool_fixture";
process.env.VERCEL_TEAM_ID ??= "team_runtime_pool_fixture";
process.env.VERCEL_TOKEN ??= "runtime_pool_fixture_token";

const calls: Array<{ cmd: string; args?: string[] }> = [];
const policies: unknown[] = [];
let getOrCreateCount = 0;
let stopped = 0;
let deleted = 0;
const session = {
  sourceSnapshotId: RUNTIME_BROWSER_SNAPSHOT.snapshotId,
  tags: {
    "verascope-role": "verascope-runtime",
    "verascope-snapshot": RUNTIME_BROWSER_SNAPSHOT.snapshotId,
  },
  fs: { writeFile: async () => undefined },
  updateNetworkPolicy: async (policy: NetworkPolicy) => { policies.push(policy); return policy; },
  runCommand: async ({ cmd, args }: { cmd: string; args?: string[] }) => {
    calls.push({ cmd, args });
    return { exitCode: 0, output: async () => "__VERASCOPE_RUNTIME_RESET_OK__" };
  },
  stop: async () => { stopped += 1; return {} as never; },
  delete: async () => { deleted += 1; },
};
const backend = {
  getOrCreate: async () => {
    getOrCreateCount += 1;
    return session;
  },
  get: async () => session,
} as never;

function inventory(entries: Array<{ name: string; tags?: Record<string, string>; currentSnapshotId?: string }>) {
  return Promise.resolve((async function* () { yield* entries; })());
}

const verifiedInventory = () => inventory([{
  name: "verascope-runtime-fixture",
  tags: session.tags,
}]);

const first = await VercelRuntimeSandbox.create(null, 60_000, { backend, listRuntimeSandboxes: verifiedInventory, sandboxName: "verascope-runtime-fixture" });
await first.close();
const second = await VercelRuntimeSandbox.create(null, 60_000, { backend, listRuntimeSandboxes: verifiedInventory, sandboxName: "verascope-runtime-fixture" });
await second.close();

assert.equal(getOrCreateCount, 2, "the same named sandbox is resumed through getOrCreate, not recreated with Sandbox.create");
assert.equal(stopped, 2);
assert.equal(deleted, 0);
assert.equal(calls.filter((call) => call.args?.some((argument) => argument.includes("__VERASCOPE_RUNTIME_RESET_OK__"))).length, 4, "each lease is scrubbed at acquire and release");
assert.deepEqual(policies.at(-1), { allow: [] }, "the persistent snapshot is stored with deny-all egress");

let unverifiedDeleted = 0;
let unverifiedStopped = 0;
const unverified = {
  ...session,
  sourceSnapshotId: "snap_unverified",
  delete: async () => { unverifiedDeleted += 1; },
  stop: async () => { unverifiedStopped += 1; return {} as never; },
};
await assert.rejects(
  VercelRuntimeSandbox.create(null, 60_000, {
    backend: { getOrCreate: async () => unverified, get: async () => unverified } as never,
    listRuntimeSandboxes: () => inventory([{ name: "user-owned-sandbox", tags: {} }]),
    sandboxName: "user-owned-sandbox",
  }),
  /runtime_sandbox_identity_unverified/,
);
assert.equal(unverifiedDeleted, 0, "an unverified same-name sandbox is never deleted");
assert.equal(unverifiedStopped, 1, "an unverified resumed sandbox is stopped without touching its filesystem");

let createdCount = 0;
let createdInventoryReads = 0;
const createdSession = { ...session, sourceSnapshotId: RUNTIME_BROWSER_SNAPSHOT.snapshotId };
const created = await VercelRuntimeSandbox.create(null, 60_000, {
  backend: {
    getOrCreate: async () => { createdCount += 1; return createdSession; },
    get: async () => createdSession,
  } as never,
  listRuntimeSandboxes: () => {
    createdInventoryReads += 1;
    return createdInventoryReads === 1
      ? inventory([])
      : inventory([{ name: "new-runtime-sandbox", tags: session.tags }]);
  },
  sandboxName: "new-runtime-sandbox",
});
await created.close();
assert.equal(createdCount, 1, "a missing named sandbox is created only once");
assert.equal(createdInventoryReads, 2, "a newly created sandbox is verified through provider inventory before use");
console.log("Runtime sandbox reuse verification passed: named persistent lease, verified reset before/after use, and deny-all egress at rest.");

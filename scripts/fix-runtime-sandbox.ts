/**
 * One-time recovery script: deletes the stale `verascope-runtime-v1` sandbox
 * so VercelRuntimeSandbox.create can recreate it from the reviewed browser
 * snapshot. Safe to run because the sandbox is stopped and its tags confirm
 * Verascope ownership before deletion.
 */
import { createRequire } from "node:module";
import { Sandbox } from "@vercel/sandbox";
import { getVercelSandboxEnvironment, getServerEnvironment } from "@/lib/config/env";
import { RUNTIME_BROWSER_SNAPSHOT } from "@/lib/runtime/browser-snapshot";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

const credentials = getVercelSandboxEnvironment();
const environment = getServerEnvironment();
const sandboxName = environment.VERCEL_RUNTIME_SANDBOX_NAME;

const RUNTIME_SANDBOX_ROLE = "verascope-runtime";
const expectedSnapshotId = RUNTIME_BROWSER_SNAPSHOT.snapshotId;

console.log(`Looking for sandbox named "${sandboxName}"...`);
const inventory = await Sandbox.list({
  token: credentials.token,
  teamId: credentials.teamId,
  projectId: credentials.projectId,
  namePrefix: sandboxName,
  sortBy: "name",
  limit: 50,
});

let found: { name: string; tags?: Record<string, string>; currentSnapshotId?: string } | undefined;
for await (const s of inventory) {
  if (s.name === sandboxName) {
    found = s;
    break;
  }
}

if (!found) {
  console.log("No sandbox found with that name — nothing to delete. Ready for fresh creation.");
  process.exit(0);
}

console.log(JSON.stringify({
  name: found.name,
  tags: found.tags,
  currentSnapshotId: found.currentSnapshotId,
  expectedSnapshotId,
}, null, 2));

// Verify ownership before deleting
const roleMatch = found.tags?.["verascope-role"] === RUNTIME_SANDBOX_ROLE;
const snapshotTagMatch = found.tags?.["verascope-snapshot"] === expectedSnapshotId;

if (!roleMatch || !snapshotTagMatch) {
  console.error("ABORT: Sandbox does not have expected Verascope ownership tags. Will not delete.");
  console.error(`  role_tag_match=${String(roleMatch)}, snapshot_tag_match=${String(snapshotTagMatch)}`);
  process.exit(1);
}

const snapshotDrift = found.currentSnapshotId !== expectedSnapshotId;
if (!snapshotDrift) {
  console.log("Sandbox snapshot is current — no deletion needed.");
  process.exit(0);
}

console.log(`Deleting stale sandbox (currentSnapshotId=${found.currentSnapshotId ?? "unknown"} ≠ expected)...`);
const sandbox = await Sandbox.get({
  name: sandboxName,
  token: credentials.token,
  projectId: credentials.projectId,
  teamId: credentials.teamId,
});
await sandbox.delete();
console.log(`Deleted "${sandboxName}". VercelRuntimeSandbox.create will now recreate it from snapshot ${expectedSnapshotId}.`);

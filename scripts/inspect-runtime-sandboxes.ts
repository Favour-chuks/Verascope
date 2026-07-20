import { createRequire } from "node:module";
import { Sandbox } from "@vercel/sandbox";
import { getVercelSandboxEnvironment } from "@/lib/config/env";
import { RUNTIME_BROWSER_SNAPSHOT } from "@/lib/runtime/browser-snapshot";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

const credentials = getVercelSandboxEnvironment();
const inventory = await Sandbox.list({
  token: credentials.token,
  teamId: credentials.teamId,
  projectId: credentials.projectId,
  // The provider caps a single inventory page at 50; the paginator still
  // walks subsequent pages without broadening the request scope.
  limit: 50,
});

const candidates: Array<{
  name: string;
  persistent: boolean;
  status: string;
  reviewedSnapshotTag: boolean;
  verascopeRuntimeRole: boolean;
  currentSnapshotMatchesReviewed: boolean;
}> = [];
let inspected = 0;

for await (const sandbox of inventory) {
  inspected += 1;
  const tags = sandbox.tags;
  const reviewedSnapshotTag = tags?.["verascope-snapshot"] === RUNTIME_BROWSER_SNAPSHOT.snapshotId;
  const verascopeRuntimeRole = tags?.["verascope-role"] === "verascope-runtime";
  if (!reviewedSnapshotTag && !verascopeRuntimeRole && sandbox.currentSnapshotId !== RUNTIME_BROWSER_SNAPSHOT.snapshotId) continue;
  candidates.push({
    name: sandbox.name,
    persistent: sandbox.persistent,
    status: sandbox.status,
    reviewedSnapshotTag,
    verascopeRuntimeRole,
    currentSnapshotMatchesReviewed: sandbox.currentSnapshotId === RUNTIME_BROWSER_SNAPSHOT.snapshotId,
  });
}

console.log(JSON.stringify({
  inspected,
  compatible: candidates.filter((candidate) => candidate.reviewedSnapshotTag && candidate.verascopeRuntimeRole),
  relatedCandidates: candidates.filter((candidate) => !candidate.reviewedSnapshotTag || !candidate.verascopeRuntimeRole),
}, null, 2));

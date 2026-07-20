/**
 * Immutable, one-time browser provisioning artifact. Update this value only by
 * running `npm run provision:runtime-browser-snapshot` and recording the
 * resulting snapshot ID after its browser-launch verification passes.
 *
 * This is not a credential. It is deliberately committed so every fresh
 * session and deployment knows which reviewed browser image scan sandboxes use.
 */
export const RUNTIME_BROWSER_SNAPSHOT: {
  name: string;
  snapshotId: string;
  toolsDirectory: string;
  browsersDirectory: string;
} = {
  name: "verascope-playwright-chromium-v1",
  snapshotId: "snap_1pJCQaZpMOmMbfSDlz8MZ4LGjdLt",
  toolsDirectory: "/opt/verascope-playwright",
  browsersDirectory: "/opt/verascope-playwright-browsers",
};

export function requireRuntimeBrowserSnapshotId() {
  if (RUNTIME_BROWSER_SNAPSHOT.snapshotId === "PENDING_PROVISIONING") {
    throw new Error("runtime_browser_snapshot_unprovisioned");
  }
  return RUNTIME_BROWSER_SNAPSHOT.snapshotId;
}

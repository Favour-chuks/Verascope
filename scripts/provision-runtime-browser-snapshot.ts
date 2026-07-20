import { createRequire } from "node:module";
import { Sandbox } from "@vercel/sandbox";
import { getVercelSandboxEnvironment } from "@/lib/config/env";
import { RUNTIME_BROWSER_SNAPSHOT } from "@/lib/runtime/browser-snapshot";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

if (RUNTIME_BROWSER_SNAPSHOT.snapshotId !== "PENDING_PROVISIONING") {
  throw new Error(`Browser snapshot is already recorded as ${RUNTIME_BROWSER_SNAPSHOT.snapshotId}; refuse to provision a second one implicitly.`);
}

const credentials = getVercelSandboxEnvironment();
const sandbox = await Sandbox.create({
  token: credentials.token,
  projectId: credentials.projectId,
  teamId: credentials.teamId,
  runtime: "node24",
  timeout: 20 * 60_000,
  persistent: false,
  env: { CI: "1", PLAYWRIGHT_BROWSERS_PATH: RUNTIME_BROWSER_SNAPSHOT.browsersDirectory },
  networkPolicy: "allow-all",
  tags: { purpose: "verascope-browser-provisioning", snapshot: RUNTIME_BROWSER_SNAPSHOT.name },
});

async function run(command: string) {
  const result = await sandbox.runCommand({ cmd: "sh", args: ["-lc", command] });
  const output = await result.output("both");
  if (result.exitCode !== 0) throw new Error(`Provisioning command failed (${result.exitCode}): ${output.slice(-4_000)}`);
  console.log(output.slice(-2_000).trim());
}

try {
  // Vercel's Amazon Linux runtime is intentionally minimal. These are native
  // Chromium runtime libraries installed only in this one-time, allow-all
  // provisioning sandbox; scan sandboxes inherit them from the snapshot.
  await run("sudo dnf install -y alsa-lib atk at-spi2-atk cups-libs glib2 libX11 libXcomposite libXdamage libXfixes libXrandr libdrm libxkbcommon mesa-libgbm nspr nss pango");
  await run(`mkdir -p '${RUNTIME_BROWSER_SNAPSHOT.toolsDirectory}' '${RUNTIME_BROWSER_SNAPSHOT.browsersDirectory}'`);
  await run(`cd '${RUNTIME_BROWSER_SNAPSHOT.toolsDirectory}' && npm init -y && npm install --no-audit --no-fund playwright@1.61.1`);
  // Timeline scope: bundled Chromium serves all three modes. This provisioning
  // sandbox is the only place browser assets may be downloaded.
  await run(`cd '${RUNTIME_BROWSER_SNAPSHOT.toolsDirectory}' && PLAYWRIGHT_BROWSERS_PATH='${RUNTIME_BROWSER_SNAPSHOT.browsersDirectory}' npx playwright install chromium`);
  await run(`cd '${RUNTIME_BROWSER_SNAPSHOT.toolsDirectory}' && PLAYWRIGHT_BROWSERS_PATH='${RUNTIME_BROWSER_SNAPSHOT.browsersDirectory}' node --input-type=module -e "import { chromium } from 'playwright'; const bundled = await chromium.launch({ headless: true }); await bundled.close(); console.log('Bundled Chromium launch passed in provisioning sandbox.');"`);
  const snapshot = await sandbox.snapshot({ expiration: 0 });
  console.log(`VERASCOPE_RUNTIME_BROWSER_SNAPSHOT_ID=${snapshot.snapshotId}`);
  console.log(`Record this ID in src/lib/runtime/browser-snapshot.ts before enabling runtime scans. Snapshot name: ${RUNTIME_BROWSER_SNAPSHOT.name}`);
} catch (error) {
  await sandbox.stop().catch(() => undefined);
  throw error;
}

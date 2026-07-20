import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VercelSandboxClient } from "@openai/agents-extensions/sandbox/vercel";
import { tryBuildAndStartInVercelSandbox, detectBuildStartCommands, getTryBuildStartDefaults } from "@/lib/sandbox/network-trace/try-build-start";
import { getServerEnvironment } from "@/lib/config/env";

const root = await mkdtemp(join(tmpdir(), "verascope-build-start-"));
const working = join(root, "working");
await (await import("node:fs/promises")).mkdir(working);

await writeFile(join(working, "package.json"), JSON.stringify({ scripts: { build: "node -e \"console.log('built')\"", start: "node server.mjs" } }));

const detected = await detectBuildStartCommands(working);
assert.equal(detected?.buildCommand, "npm run build");
assert.equal(detected?.startCommand, "npm run start");
assert.equal(await detectBuildStartCommands(working, { buildCommand: "npm run build" }), null);
assert.equal(getTryBuildStartDefaults(getServerEnvironment({ REPO_BUILD_TIMEOUT_MS: "42" })).buildTimeoutMs, 42);

type RemoteCase = "runnable" | "build_failed";

function remoteResponse(output: string, exitCode: number) {
  return `Chunk ID: fixture\nWall time: 0.0001 seconds\nProcess exited with code 0\nOutput:\n${output}\n__VERASCOPE_EXIT_CODE:${exitCode}\n`;
}

function createFixtureClient(caseName: RemoteCase) {
  let closed = false;
  const commands: string[] = [];
  const session = {
    async readFile({ path }: { path: string }) {
      if (path === "repo/package.json") return Buffer.from(JSON.stringify({ scripts: { build: "echo build", start: "echo start" } }));
      if (path === "repo/.verascope-start.log") return Buffer.from("fixture start log");
      throw new Error(`unexpected read: ${path}`);
    },
    async pathExists() { return true; },
    async resolveExposedPort() { return { url: "https://runtime-bridge.vercel-sandbox.example" }; },
    async execCommand({ cmd }: { cmd: string }) {
      commands.push(cmd);
      if (cmd.includes("npm run build") && caseName === "build_failed") return remoteResponse("build failed", 17);
      return remoteResponse("fixture command output", 0);
    },
    async close() { closed = true; },
  };
  const client = {
    async create() { return session; },
  } as unknown as Pick<VercelSandboxClient, "create">;
  return { client, commands, get closed() { return closed; } };
}

const runnableFixture = createFixtureClient("runnable");
const runnable = await tryBuildAndStartInVercelSandbox("https://github.com/vercel/nextjs-portfolio-starter", {
  installDependencies: true,
  client: runnableFixture.client,
});
assert.equal(runnable.status, "runnable");
assert.ok(runnableFixture.commands.some((command) => command.includes("npm ci")));
assert.ok(runnableFixture.commands.some((command) => command.includes("npm run build")));
assert.ok(runnableFixture.commands.some((command) => command.includes("curl -fsS")));
assert.equal(runnable.status === "runnable" && runnable.baseUrl, "https://runtime-bridge.vercel-sandbox.example");
if (runnable.status === "runnable") await runnable.stop();
assert.equal(runnableFixture.closed, true);

const failedFixture = createFixtureClient("build_failed");
const notRunnable = await tryBuildAndStartInVercelSandbox("https://github.com/vercel/nextjs-portfolio-starter", {
  installDependencies: true,
  client: failedFixture.client,
});
assert.equal(notRunnable.status, "repo_not_runnable");
assert.equal(notRunnable.status === "repo_not_runnable" && notRunnable.reason, "build_failed");
assert.equal(failedFixture.closed, true);

console.log("try-build-start verification passed: detection plus Vercel-only runnable health check and repo_not_runnable build failure.");

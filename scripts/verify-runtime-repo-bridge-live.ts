import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runSandboxRuntimeBehavior } from "@/lib/runtime/sandbox-executor";
import { tryBuildAndStartInVercelSandbox } from "@/lib/sandbox/network-trace/try-build-start";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

const repoUrl = process.argv[2] ?? "https://github.com/vercel/nextjs-portfolio-starter";
const build = await tryBuildAndStartInVercelSandbox(repoUrl, {
  installDependencies: true,
});
assert.equal(build.status, "runnable", build.status === "repo_not_runnable" ? build.reason : "");
if (build.status !== "runnable") throw new Error("repo_not_runnable");

try {
  assert.match(build.baseUrl, /^https:\/\//);
  const result = await runSandboxRuntimeBehavior({
    status: "ready",
    mode: "repo_build",
    baseUrl: build.baseUrl,
    policyCandidates: ["/privacy", "/legal/privacy", "/PRIVACY.md"],
    close: build.stop,
    target: { mode: "repo_build" },
  });
  assert.equal(result.coverage.targetMode, "repo_build");
  assert.equal(result.coverage.flowsTested.includes("checkout-without-referrer"), true);
  assert.equal(result.coverage.stealthPosture, "none");
  console.log(`Snapshot-resident repo bridge passed for ${repoUrl}: the browser reached only the temporary provider bridge and returned a bounded runtime report.`);
} finally {
  await build.stop();
}

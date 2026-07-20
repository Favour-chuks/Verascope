import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tryBuildAndStartInVercelSandbox } from "@/lib/sandbox/network-trace/try-build-start";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

const args = process.argv.slice(2);
const valueFor = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const repoUrl = valueFor("--repo-url");
const outputPath = valueFor("--output");
if (!repoUrl) throw new Error("Usage: npm run repo:build -- --repo-url https://github.com/owner/repo [--build <command> --start <command>] [--install]");

process.stderr.write("VERASCOPE_REPO_BUILD_STARTED\n");
let result;
try {
  result = await tryBuildAndStartInVercelSandbox(repoUrl, {
    buildCommand: valueFor("--build"),
    startCommand: valueFor("--start"),
    installDependencies: args.includes("--install"),
  });
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_hosted_runner_error";
  if (outputPath) await writeFile(resolve(outputPath), `${JSON.stringify({ status: "runner_failed", message }, null, 2)}\n`, "utf8");
  throw error;
}

const printable = result.status === "runnable" ? { ...result, stop: undefined } : result;
const evidence = JSON.stringify(printable, null, 2);
if (outputPath) await writeFile(resolve(outputPath), `${evidence}\n`, "utf8");
process.stdout.write(`${evidence}\n`);
// Keep the standalone proof visible even in runners that buffer stdout while
// Vercel's client closes the remote session.
process.stderr.write(`VERASCOPE_REPO_BUILD_RESULT ${JSON.stringify({ status: result.status, reason: result.status === "repo_not_runnable" ? result.reason : undefined })}\n`);
if (result.status === "runnable") await result.stop();
process.exitCode = result.status === "runnable" ? 0 : 2;

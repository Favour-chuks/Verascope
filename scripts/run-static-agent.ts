import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runStaticAgent, type StaticAgentKind } from "@/lib/agents/static-agents";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

const args = process.argv.slice(2);
const valueFor = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const kind = valueFor("--kind") as StaticAgentKind | undefined;
const repoUrl = valueFor("--repo-url");
const outputPath = valueFor("--output");
if (kind !== "code_health" && kind !== "security_license_ai") throw new Error("--kind must be code_health or security_license_ai");
if (!repoUrl || !outputPath) throw new Error("Usage: tsx scripts/run-static-agent.ts --kind <kind> --repo-url https://github.com/owner/repo --output <path>");

try {
  const result = await runStaticAgent(kind, repoUrl);
  const evidence = JSON.stringify(result, null, 2);
  await writeFile(resolve(outputPath), `${evidence}\n`, "utf8");
  process.stdout.write(`${evidence}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_static_agent_error";
  await writeFile(resolve(outputPath), `${JSON.stringify({ status: "agent_failed", message }, null, 2)}\n`, "utf8");
  throw error;
}

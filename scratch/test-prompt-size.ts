import { createRequire } from "node:module";
import { stageStaticAuditEvidence, buildStaticAuditDefinition, promptEvidence } from "../src/lib/agents/static-agents.ts";
import { getManagedVercelSandboxClient } from "../src/lib/sandbox/managed-vercel-pool.ts";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const repo = "https://github.com/vercel/next-learn";
const definition = buildStaticAuditDefinition("code_health", repo);
const client = getManagedVercelSandboxClient({ timeoutMs: 240000, env: { CI: "1" } });

console.log("Staging evidence...");
const evidence = await stageStaticAuditEvidence(definition, client);
console.log("Staged! Calculating prompt size...");
const prompt = promptEvidence("code_health", evidence);
console.log("Prompt length (chars):", prompt.length);
console.log("Dependency audit output length:", evidence.dependencyAudit.length);
console.log("License inventory length:", evidence.licenseInventory.length);

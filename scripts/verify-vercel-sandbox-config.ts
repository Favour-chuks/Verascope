import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { VercelSandboxClient } from "@openai/agents-extensions/sandbox/vercel";
import { getServerEnvironment, getVercelSandboxEnvironment } from "@/lib/config/env";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());
const environment = getServerEnvironment();
assert.equal(environment.SANDBOX_PROVIDER, "vercel");

const client = new VercelSandboxClient(getVercelSandboxEnvironment());
assert.equal(client.backendId, "vercel");

console.log("Vercel sandbox configuration verification passed: provider, non-empty credentials, and client construction.");

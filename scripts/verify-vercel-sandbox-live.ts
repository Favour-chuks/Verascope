import { createRequire } from "node:module";
import { VercelSandboxClient } from "@openai/agents-extensions/sandbox/vercel";
import { getVercelSandboxEnvironment } from "@/lib/config/env";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());

const client = new VercelSandboxClient({
  ...getVercelSandboxEnvironment(),
  timeoutMs: 60_000,
  env: { CI: "1" },
});

const session = await client.create();
try {
  const output = await session.execCommand({ cmd: "pwd; command -v node; command -v git", maxOutputTokens: 200 });
  if (!/Process exited with code 0/.test(output)) throw new Error("vercel_sandbox_live_command_failed");
  process.stdout.write("Vercel sandbox live verification passed: created, executed a minimal OS check, and will close.\n");
} finally {
  await session.close();
}

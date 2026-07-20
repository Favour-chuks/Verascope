import assert from "node:assert/strict";
import { createTargetProcessEnvironment, getGeminiAuditEnvironment, getServerEnvironment, getVercelSandboxEnvironment, isUserUrlModeEnabled } from "@/lib/config/env";

const defaults = getServerEnvironment({});
assert.equal(defaults.GEMINI_AUDIT_MODEL, "gemini-3.5-flash");
assert.equal(defaults.ALLOW_USER_URL_MODE, true);
assert.equal(defaults.STATIC_AGENT_TIMEOUT_MS, 240_000);
assert.equal(defaults.REPO_BUILD_TIMEOUT_MS, 90_000);
assert.equal(isUserUrlModeEnabled({ ALLOW_USER_URL_MODE: "false" }), false);
assert.deepEqual(
  getVercelSandboxEnvironment({ VERCEL_PROJECT_ID: "project", VERCEL_TEAM_ID: "team", VERCEL_TOKEN: "token" }),
  { projectId: "project", teamId: "team", token: "token", timeoutMs: 240_000 },
);
assert.throws(() => getVercelSandboxEnvironment({}), /vercel_sandbox_credentials_missing/);

const audit = getGeminiAuditEnvironment({ GEMINI_API_KEY: "test-key", GEMINI_AUDIT_MODEL: "test-model" });
assert.deepEqual(audit, { apiKey: "test-key", model: "test-model" });
assert.throws(() => getGeminiAuditEnvironment({}), /gemini_api_key_missing/);
assert.throws(() => getServerEnvironment({ ALLOW_USER_URL_MODE: "yes" }), /Invalid option/);

const targetEnvironment = createTargetProcessEnvironment({
  PATH: "safe-path",
  GEMINI_API_KEY: "must-not-leak",
  SUPABASE_SERVICE_ROLE_KEY: "must-not-leak",
  VERCEL_TOKEN: "must-not-leak",
});
assert.equal(targetEnvironment.PATH, "safe-path");
assert.equal(targetEnvironment.CI, "1");
assert.equal(targetEnvironment.GEMINI_API_KEY, undefined);
assert.equal(targetEnvironment.SUPABASE_SERVICE_ROLE_KEY, undefined);
assert.equal(targetEnvironment.VERCEL_TOKEN, undefined);

console.log("Environment configuration verification passed: Gemini defaults/key requirement, strict booleans, and target-process secret isolation.");

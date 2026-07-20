import assert from "node:assert/strict";
import {
  buildStaticAuditDefinition,
  assertStaticAuditGrounding,
  isStaticFindingGrounded,
  parseStaticAgentOutput,
  repoSlugFromUrl,
  resolveStaticSandboxClient,
  runStaticAgent,
  stageStaticAuditEvidence,
  type StagedAuditEvidence,
} from "@/lib/agents/static-agents";
import { VercelSandboxClient } from "@openai/agents-extensions/sandbox/vercel";
import { ManagedVercelPool } from "@/lib/sandbox/managed-vercel-pool";
import { validateStaticFinding } from "@/lib/schemas/findings";
import { appendScanEvent, createScan, updateScan } from "@/lib/scans/memory-store";

assert.equal(repoSlugFromUrl("https://github.com/vercel/next.js"), "vercel/next.js");
assert.throws(() => repoSlugFromUrl("https://example.com/not-a-repo"));
assert.equal(buildStaticAuditDefinition("code_health", "https://github.com/vercel/next.js").name, "Code Health Agent");
assert.equal(buildStaticAuditDefinition("security_license_ai", "https://github.com/vercel/next.js").name, "Security, License & Static AI-Vendor Exposure Agent");

const valid = validateStaticFinding({
  category: "security",
  severity: "notable",
  claim: "Dependency audit reported a vulnerable package.",
  citation: { type: "command", command: "npm audit --json", output: "{\"vulnerabilities\":{}}" },
});
assert.ok(valid);
assert.equal(validateStaticFinding({ category: "security", severity: "notable", claim: "Uncited" }), null);
assert.equal(
  parseStaticAgentOutput("```json\n{\"findings\":[],\"notChecked\":[\"No test script\"]}\n``` ").notChecked[0],
  "No test script",
);
assert.equal(
  parseStaticAgentOutput(JSON.stringify({ findings: [{
    category: "security", severity: "minor", claim: "A file citation may use snake_case fields.",
    citation: { citation_type: "file", file_path: "src/example.ts", line_start: 4 }, confidence: "verified",
  }], not_checked: [] })).findings[0].citation.type,
  "file",
);
assert.equal(
  parseStaticAgentOutput(JSON.stringify({ findings: [{
    category: "code_quality", severity: "minor", claim: "A Gemini command-output alias is normalized.",
    citation: { type: "command_output", command: "git --no-pager shortlog -s -n HEAD", output: "1: 12 commits" }, confidence: "verified",
  }], notChecked: [] })).findings[0].citation.type,
  "command",
);
const hostedSandbox = {} as Pick<VercelSandboxClient, "create">;
assert.equal(resolveStaticSandboxClient(hostedSandbox), hostedSandbox);

let poolCreates = 0;
let poolResets = 0;
const appliedManifests: unknown[] = [];
const pooledSession = {
  execCommand: async ({ cmd }: { cmd: string }) => {
    if (cmd.includes("__VERASCOPE_POOL_RESET_OK__")) poolResets += 1;
    return "__VERASCOPE_POOL_RESET_OK__";
  },
  applyManifest: async (manifest: unknown) => { appliedManifests.push(manifest); },
  close: async () => { throw new Error("pooled session should not be closed"); },
};
const pool = new ManagedVercelPool(() => ({
  create: async () => {
    poolCreates += 1;
    return pooledSession as never;
  },
}));
const poolClient = pool.getClient({});
const firstLease = await poolClient.create({ manifest: { entries: { repo: { type: "git_repo", repo: "vercel/next.js", ref: "main" } } } } as never);
await firstLease.close?.();
const secondLease = await poolClient.create({ manifest: { entries: { repo: { type: "git_repo", repo: "vercel/next.js", ref: "main" } } } } as never);
assert.equal(poolCreates, 1);
assert.equal(poolResets, 2);
assert.equal(appliedManifests.length, 1);
await secondLease.close?.();

const sandboxCommands: string[] = [];
let sandboxClosed = false;
const stagedSandbox = {
  create: async () => ({
    readFile: async () => JSON.stringify({
      scripts: { test: "vitest" },
      config: { apiKey: "must-not-reach-the-model" },
    }),
    execCommand: async ({ cmd }: { cmd: string }) => {
      sandboxCommands.push(cmd);
      return "Output:\n" + cmd;
    },
    close: async () => { sandboxClosed = true; },
  }),
} as unknown as Pick<VercelSandboxClient, "create">;
const stagedEvidence = await stageStaticAuditEvidence(
  buildStaticAuditDefinition("code_health", "https://github.com/vercel/next.js"),
  stagedSandbox,
);
assert.equal(sandboxClosed, true);
assert.ok(sandboxCommands.some((command) => command.includes("npm ci --ignore-scripts") && command.includes("npm install --ignore-scripts")));
assert.ok(sandboxCommands.some((command) => command.includes("rg -l")));
assert.ok(sandboxCommands.every((command) => !command.includes("rg -n")));
assert.match(stagedEvidence.secretSignals, /rg -l/);

const evidence: StagedAuditEvidence = {
  ...stagedEvidence,
  files: "./src/ai.ts",
  secretSignals: "./src/config.ts",
  aiSignals: "./src/ai.ts",
  historySignals: "./src/ai.ts",
  dependencyInstall: "npm ci --ignore-scripts completed",
  dependencyAudit: "{\"metadata\":{\"vulnerabilities\":{\"total\":0}}}",
  licenseInventory: "[{\"name\":\"fixture\",\"license\":\"MIT\"}]",
};
const groundedFinding = validateStaticFinding({
  category: "ai_exposure",
  severity: "minor",
  claim: "Static AI SDK candidate is present.",
  citation: { type: "file", filePath: "src/ai.ts" },
});
assert.ok(groundedFinding);
assert.equal(isStaticFindingGrounded(groundedFinding, evidence), true);
const ungroundedFinding = validateStaticFinding({
  category: "security",
  severity: "notable",
  claim: "Unsupported claim.",
  citation: { type: "command", command: "npm audit --json", output: "invented output" },
});
assert.ok(ungroundedFinding);
assert.equal(isStaticFindingGrounded(ungroundedFinding, evidence), false);
assert.throws(
  () => assertStaticAuditGrounding({ findings: [ungroundedFinding], notChecked: [] }, evidence),
  /static_agent_ungrounded_citation/,
);
const geminiRequests: unknown[] = [];
let geminiAttempts = 0;
const output = await runStaticAgent("security_license_ai", "https://github.com/vercel/next.js", {
  environment: { GEMINI_API_KEY: "fixture-only-key", GEMINI_AUDIT_MODEL: "gemini-3.5-flash" },
  evidence,
  retryBaseDelayMs: 1,
  geminiClient: {
    models: {
      generateContent: async (request) => {
        geminiRequests.push(request);
        geminiAttempts += 1;
        if (geminiAttempts === 1) {
          throw Object.assign(new Error("temporary Gemini saturation"), { status: 503 });
        }
        if (geminiAttempts === 2) {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        }
        return { text: "{\"findings\":[],\"notChecked\":[\"Fixture-only verification\"]}" };
      },
    },
  },
});
assert.equal(output.notChecked[0], "Fixture-only verification");
assert.equal(geminiRequests.length, 3);
const geminiRequest = geminiRequests[0] as { model: string; contents: string; config: { responseMimeType: string; responseJsonSchema: unknown } };
assert.equal(geminiRequest.model, "gemini-3.5-flash");
assert.equal(geminiRequest.config.responseMimeType, "application/json");
assert.ok(geminiRequest.config.responseJsonSchema);
assert.match(geminiRequest.contents, /values are intentionally withheld/);
assert.match(geminiRequest.contents, /Scope boundary: emit only security, licensing, or ai_exposure findings/);
assert.doesNotMatch(geminiRequest.contents, /fixture-only-key/);
assert.doesNotMatch(geminiRequest.contents, /must-not-reach-the-model/);

const scopedOutput = await runStaticAgent("code_health", "https://github.com/vercel/next.js", {
  environment: { GEMINI_API_KEY: "fixture-only-key" }, evidence,
  geminiClient: { models: { generateContent: async () => ({ text: JSON.stringify({
    findings: [{ category: "security", severity: "minor", claim: "Must be excluded.", citation: { type: "command", command: "npm audit --json", output: evidence.dependencyAudit }, confidence: "verified" }],
    notChecked: [],
  }) }) } },
});
assert.equal(scopedOutput.findings.length, 0);
assert.match(scopedOutput.notChecked.join(" "), /out-of-scope model proposal/);

const scan = createScan("https://github.com/vercel/next.js", { mode: "repo_build" });
appendScanEvent(scan.id, "Running npm audit --json");
const updated = updateScan(scan.id, { status: "running_security", currentStageDetail: "Running Security Agent" });
assert.equal(updated.events.length, 2);
assert.equal(updated.status, "running_security");

await assert.rejects(() => runStaticAgent("code_health", "https://github.com/vercel/next.js"), /gemini_api_key_missing/);

console.log("Gemini static-agent contract verification passed: cited static staging, citation grounding, secret-value isolation, structured Gemini request/retry, scan events, and missing-key fail-closed behavior.");

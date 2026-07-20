import {
  buildStaticAuditDefinition,
  resolveStaticSandboxClient,
  stageStaticAuditEvidence,
} from "@/lib/agents/static-agents";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
loadEnvConfig(process.cwd());
const repoUrl = process.argv[2] ?? "https://github.com/vercel/nextjs-portfolio-starter";
const definition = buildStaticAuditDefinition("code_health", repoUrl);
const evidence = await stageStaticAuditEvidence(definition, resolveStaticSandboxClient());

const nonEmptyLines = (value: string) => value.split(/\r?\n/).filter((line) => line.trim().length > 0).length;

// Do not print candidate paths or any raw command output: this command proves
// the live sandbox path while retaining Verascope's no-secret-value rule.
console.log(JSON.stringify({
  repo: definition.repo,
  evidence: {
    packageManifestCaptured: evidence.packageJson !== "(package.json unavailable)",
    repositoryFilesListed: nonEmptyLines(evidence.files),
    ciFilesListed: nonEmptyLines(evidence.ciFiles),
    modulesListed: nonEmptyLines(evidence.modules),
    anonymizedAuthorshipRows: nonEmptyLines(evidence.authors),
    candidateSecretPathCount: nonEmptyLines(evidence.secretSignals),
    aiSignalPathCount: nonEmptyLines(evidence.aiSignals),
    aiHistoryPathCount: nonEmptyLines(evidence.historySignals),
    dependencyInstallAttempted: !evidence.dependencyInstall.includes("not run:"),
    dependencyAuditAttempted: !evidence.dependencyAudit.includes("not run:"),
    licenseInventoryAttempted: !evidence.licenseInventory.includes("not run:"),
    testSuiteStatus: evidence.tests,
  },
}, null, 2));

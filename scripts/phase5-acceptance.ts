import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runDemoRuntimeOnly, runStaticStages } from "@/lib/agents/orchestrator";
import { ReportView } from "@/components/scan-view";
import { synthesizeReport } from "@/lib/reports/synthesis";
import { memoryScanStore } from "@/lib/scans/scan-store";
import type { ScanRecord } from "@/lib/scans/memory-store";

type PhaseFiveTargets = {
  runnableRepo: string;
  notRunnableRepo: string;
  userUrlRepo: string;
  userUrl: string;
};

function isPublicGithubRepo(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.split("/").filter(Boolean).length === 2;
  } catch {
    return false;
  }
}

/**
 * Phase 5 takes separate repository inputs for every static audit. In
 * particular, user_url must be paired with the repository that actually owns
 * that live application; substituting a convenient unrelated public project
 * would make the static report misleading.
 */
export function parsePhaseFiveTargets(argv: string[]): PhaseFiveTargets {
  const [runnableRepo, notRunnableRepo, userUrlRepo, userUrl] = argv;
  if (!runnableRepo || !notRunnableRepo || !userUrlRepo || !userUrl) {
    throw new Error("Usage: npm run test:phase5-live -- --authorized-user-url <runnable-github-repo-url> <non-runnable-github-repo-url> <user-url-github-repo-url> <owned-https-user-url>");
  }
  if (![runnableRepo, notRunnableRepo, userUrlRepo].every(isPublicGithubRepo)) {
    throw new Error("phase5_repo_url_invalid");
  }
  try {
    if (new URL(userUrl).protocol !== "https:") throw new Error();
  } catch {
    throw new Error("phase5_user_url_invalid");
  }
  return { runnableRepo, notRunnableRepo, userUrlRepo, userUrl };
}

function hasCitation(scan: ScanRecord) {
  return scan.findings.every((finding) => {
    const citation = finding.citation;
    if (citation.type === "file") return Boolean(citation.filePath);
    if (citation.type === "command") return Boolean(citation.command && citation.output);
    return Boolean(citation.host && citation.method && citation.check && citation.flow);
  });
}

function reportFor(scan: ScanRecord) {
  const report = synthesizeReport({
    findings: scan.findings,
    notAssessed: scan.notAssessed,
    runtimeCoverage: scan.runtimeCoverage,
  });
  const html = renderToStaticMarkup(createElement(ReportView, { report }));
  assert.equal(report.findings.length, scan.findings.length, "no finding may survive report synthesis without its citation");
  return { report, html };
}

function logAcceptance(mode: string, scan: ScanRecord, renderedReport: { report: ReturnType<typeof synthesizeReport>; html: string }) {
  console.log(JSON.stringify({
    mode,
    status: scan.status,
    citedFindingCount: renderedReport.report.findings.length,
    targetMode: scan.runtimeCoverage?.targetMode ?? null,
    targetSkippedReason: scan.runtimeCoverage?.targetSkippedReason ?? null,
    eventPasses: scan.events.map((event) => event.message).filter((message) => /Static evidence passes|Gemini pass|Runtime passes|Runtime stage skipped/.test(message)),
  }, null, 2));
}

async function requireCompletedScan(scanId: string) {
  const scan = await memoryScanStore.getScan(scanId);
  assert.ok(scan, "scan_result_missing");
  assert.equal(scan.status, "complete", scan.currentStageDetail ?? "scan_failed_without_detail");
  assert.ok(scan.runtimeCoverage, "runtime_coverage_missing");
  assert.ok(scan.findings.length > 0, "phase5_cited_finding_required");
  assert.equal(hasCitation(scan), true, "phase5_uncited_finding");
  return scan;
}

async function runDemo(repoUrl: string) {
  const scan = await memoryScanStore.createScan(repoUrl, { mode: "demo_app" });
  await runDemoRuntimeOnly(scan.id, { store: memoryScanStore });
  const complete = await requireCompletedScan(scan.id);
  assert.equal(complete.runtimeCoverage?.targetMode, "demo_app");
  assert.match(complete.notAssessed.join("\n"), /Static-agent analysis was not run/);
  const rendered = reportFor(complete);
  assert.match(rendered.html, /NETWORK TRACE/);
  logAcceptance("demo_app", complete, rendered);
}

async function runRunnableRepo(repoUrl: string) {
  const scan = await memoryScanStore.createScan(repoUrl, { mode: "repo_build" });
  await runStaticStages(scan.id, { store: memoryScanStore });
  const complete = await requireCompletedScan(scan.id);
  assert.equal(complete.runtimeCoverage?.targetMode, "repo_build");
  assert.equal(complete.runtimeCoverage?.targetSkippedReason, null);
  assert.match(complete.events.map((event) => event.message).join("\n"), /Static evidence passes/);
  const rendered = reportFor(complete);
  assert.match(rendered.html, /Runtime testing/);
  assert.match(rendered.html, /checkout-with-simulated-referrer/);
  assert.match(rendered.html, /checkout-without-referrer/);
  logAcceptance("repo_build:runnable", complete, rendered);
}

async function runNonRunnableRepo(repoUrl: string) {
  const scan = await memoryScanStore.createScan(repoUrl, { mode: "repo_build" });
  await runStaticStages(scan.id, { store: memoryScanStore });
  const complete = await requireCompletedScan(scan.id);
  assert.equal(complete.runtimeCoverage?.targetMode, "repo_build");
  assert.equal(complete.runtimeCoverage?.targetSkippedReason, "repo_not_runnable");
  assert.ok(complete.findings.some((finding) => finding.citation.type !== "network_trace"), "repo_not_runnable must retain a cited static finding");
  assert.match(complete.notAssessed.join("\n"), /Runtime testing didn't run/);
  const rendered = reportFor(complete);
  assert.match(rendered.html, /continuing with static findings only/);
  logAcceptance("repo_build:repo_not_runnable", complete, rendered);
}

async function runUserUrl(repoUrl: string, targetUrl: string) {
  const scan = await memoryScanStore.createScan(repoUrl, { mode: "user_url", targetUrl, consentAttestation: true });
  await runStaticStages(scan.id, { store: memoryScanStore });
  const complete = await requireCompletedScan(scan.id);
  assert.equal(complete.runtimeCoverage?.targetMode, "user_url");
  assert.equal(complete.runtimeCoverage?.consentAttested, true);
  assert.ok(complete.runtimeCoverage?.consentAttestedAt, "user_url_consent_timestamp_missing");
  const rendered = reportFor(complete);
  assert.match(rendered.html, /confirmation recorded, not verified/);
  assert.match(rendered.html, /Runtime testing/);
  assert.match(rendered.html, /checkout-with-simulated-referrer/);
  assert.match(rendered.html, /checkout-without-referrer/);
  assert.equal(/verascope-upstream-referrer|override-token|affiliate_ref=/i.test(rendered.html), false, "credential value leaked into report HTML");
  logAcceptance("user_url", complete, rendered);
}

async function main() {
  const acknowledgement = process.argv[2];
  if (acknowledgement !== "--authorized-user-url") {
    throw new Error("phase5_user_url_authorization_acknowledgement_required");
  }
  const targets = parsePhaseFiveTargets(process.argv.slice(3));
  await runDemo(targets.runnableRepo);
  await runRunnableRepo(targets.runnableRepo);
  await runNonRunnableRepo(targets.notRunnableRepo);
  await runUserUrl(targets.userUrlRepo, targets.userUrl);
  console.log("Phase 5 full acceptance passed: every target mode completed through its production orchestration path and rendered a cited report.");
}

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as { loadEnvConfig: (directory: string) => void };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvConfig(process.cwd());
  await main();
}

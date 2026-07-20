"use client";

import { useEffect, useState } from "react";
import type { Finding } from "@/lib/schemas/findings";
import type { RuntimeCoverage } from "@/lib/runtime/types";

type Event = { id: string; message: string; createdAt: string };
type Scan = {
  id: string; repoUrl: string; status: string; currentStageDetail: string | null; findings: Finding[];
  notAssessed: string[]; events: Event[]; runtimeCoverage: RuntimeCoverage | null;
  runtimeTarget: { mode: string; targetUrl?: string; consentAttestation?: true };
};
type Report = {
  executiveSummary: string; findings: Finding[]; notAssessed: string[];
  runtimeCoverage: RuntimeCoverage | null; generatedAt: string;
};
type Payload = { scan: Scan; report: Report | null; error?: { message?: string } };

const categoryLabels: Record<string, string> = {
  code_quality: "Code health", security: "Security", licensing: "Licensing", ai_exposure: "AI vendor exposure",
  team_risk: "Team & key-person risk", runtime_disclosure: "Runtime behavior & disclosure",
};

function titleMode(mode: string) {
  if (mode === "demo_app") return "Quick demo";
  if (mode === "repo_build") return "Repository build";
  return "Live URL";
}

const auditStages = [
  { id: "queued", label: "Queued" },
  { id: "running_code_health", label: "Code" },
  { id: "running_security", label: "Security" },
  { id: "running_runtime_behavior", label: "Runtime" },
  { id: "synthesizing", label: "Report" },
];

function AuditStageRail({ status }: { status: string }) {
  const stageIndex = auditStages.findIndex((stage) => stage.id === status);
  const activeStage = status === "complete" ? auditStages.length : stageIndex;
  const isUnknownStatus = activeStage === -1;

  return (
    <ol className="stage-rail" aria-label="Audit progress" data-status={isUnknownStatus ? status : undefined}>
      {auditStages.map((stage, index) => {
        const className = isUnknownStatus
          ? ""
          : index < activeStage
            ? "is-complete"
            : index === activeStage
              ? "is-current"
              : "";
        return (
          <li className={className} key={stage.id} aria-current={className === "is-current" ? "step" : undefined}>
            <span>{index + 1}</span>
            {stage.label}
          </li>
        );
      })}
    </ol>
  );
}

function Citation({ finding }: { finding: Finding }) {
  const citation = finding.citation;
  if (citation.type === "file") return <div className="citation"><span>FILE</span><code>{citation.filePath}{citation.lineStart ? ":" + citation.lineStart + (citation.lineEnd ? "–" + citation.lineEnd : "") : ""}</code></div>;
  if (citation.type === "command") return <details className="citation"><summary><span>COMMAND</span><code>{citation.command}</code></summary><pre>{citation.output}</pre></details>;
  return (
    <details className={"citation network-citation " + (citation.check === "attribution_override" ? "attribution-citation" : "")}>
      <summary><span>NETWORK TRACE</span><code>{citation.method} {citation.host} · {citation.flow}</code></summary>
      <dl>
        <div><dt>Check</dt><dd>{citation.check.replaceAll("_", " ")}</dd></div>
        <div><dt>Flow</dt><dd>{citation.flow}</dd></div>
        <div><dt>Timing</dt><dd>{citation.timingMs === null ? "Not recorded" : citation.timingMs + "ms"}</dd></div>
        <div><dt>Payload</dt><dd>{citation.payloadSummary}</dd></div>
      </dl>
    </details>
  );
}

function Coverage({ coverage }: { coverage: RuntimeCoverage }) {
  const skipped = coverage.targetSkippedReason === "repo_not_runnable";
  return (
    <section className={"coverage-panel " + (skipped ? "coverage-skipped" : "")}>
      <p className="eyebrow">Runtime testing — {titleMode(coverage.targetMode)}</p>
      {skipped ? <p className="coverage-lead">Runtime target couldn&apos;t start — continuing with static findings only.</p> : <p className="coverage-lead">Tested against: <code>{coverage.flowsTested.length ? coverage.flowsTested.join(", ") : "No runtime flows completed"}</code></p>}
      <div className="coverage-grid">
        <span>CNAME check: <strong>{coverage.cnameCheckPerformed ? "performed" : "not performed"}</strong></span>
        <span>Browser fingerprint parity: <strong>{coverage.fingerprintParityScore ?? "not run"}</strong></span>
        {coverage.targetMode === "user_url" && <span>Authorization: <strong>{coverage.consentAttested ? "confirmation recorded, not verified" : "not recorded"}</strong></span>}
        {coverage.targetMode === "user_url" && <span>Confirmation recorded: <strong>{coverage.consentAttestedAt ?? "not available"}</strong></span>}
      </div>
      <p className="limitations">{coverage.limitationsNote}</p>
    </section>
  );
}

export function ReportView({ report }: { report: Report }) {
  const groups = report.findings.reduce<Record<string, Finding[]>>((all, finding) => {
    (all[finding.category] ??= []).push(finding);
    return all;
  }, {});
  const networkTraceCount = report.findings.filter((finding) => finding.citation.type === "network_trace").length;
  const verifiedCount = report.findings.filter((finding) => finding.confidence === "verified").length;
  return (
    <article className="report">
      <header className="report-header">
        <div>
          <p className="eyebrow">Completed audit</p>
          <h1>What the evidence supports.</h1>
          <p className="executive-summary">{report.executiveSummary}</p>
        </div>
        <dl className="report-stats">
          <div><dt>Cited signals</dt><dd>{report.findings.length}</dd></div>
          <div><dt>Verified</dt><dd>{verifiedCount}</dd></div>
          <div><dt>Runtime traces</dt><dd>{networkTraceCount}</dd></div>
        </dl>
      </header>
      {report.runtimeCoverage && <Coverage coverage={report.runtimeCoverage} />}
      {Object.entries(groups).map(([category, findings]) => (
        <section className="category-section" key={category}>
          <h2>{categoryLabels[category] ?? category}</h2>
          {findings.map((finding, index) => (
            <article className={"finding severity-" + finding.severity} key={category + index}>
              <div className="finding-topline"><span className="severity">{finding.severity}</span><span className="confidence">{finding.confidence === "verified" ? "Execution verified" : "Heuristic signal"}</span></div>
              <h3>{finding.claim}</h3>
              {finding.whyItMatters && <p className="why">{finding.whyItMatters}</p>}
              {finding.disclosedClaim && <p className="disclosure"><span>Disclosure</span> “{finding.disclosedClaim}” <em>{finding.disclosedClaimLocation}</em></p>}
              <Citation finding={finding} />
              {finding.category === "runtime_disclosure" && <p className="risk-footer">Observed behavior and cited evidence are flagged for legal/compliance review; this report does not make legal conclusions.</p>}
            </article>
          ))}
        </section>
      ))}
      <section className="not-assessed">
        <p className="eyebrow">Not assessed</p>
        <h2>What this report does not claim.</h2>
        <ul>{report.notAssessed.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>
    </article>
  );
}

export function ScanView({ scanId }: { scanId: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await fetch("/api/scans/" + scanId, { cache: "no-store" });
        const next = await response.json() as Payload;
        if (!response.ok) throw new Error(next.error?.message ?? "The scan could not be loaded.");
        if (!active) return;
        setPayload(next);
        if (!next.report && next.scan.status !== "failed") timer = window.setTimeout(load, 1400);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "The scan could not be loaded.");
      }
    };
    void load();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [scanId]);
  if (error) return <main className="scan-shell"><p className="form-error" role="alert">{error}</p></main>;
  if (!payload) return <main className="scan-shell"><p className="loading-copy">Loading audit evidence…</p></main>;
  const { scan, report } = payload;
  if (report) return <main className="scan-shell"><div className="masthead compact"><a className="wordmark" href="/">VERASCOPE<span>●</span></a><p>{titleMode(scan.runtimeTarget.mode)} / report</p></div><ReportView report={report} /></main>;
  return (
    <main className="scan-shell">
      <div className="masthead compact"><a className="wordmark" href="/">VERASCOPE<span>●</span></a><p>{titleMode(scan.runtimeTarget.mode)} / in progress</p></div>
      <section className="running-panel">
        <p className="eyebrow">{scan.status === "failed" ? "Audit failed" : "Audit in progress"}</p>
        <h1>{scan.status === "failed" ? "The audit stopped before a report could be assembled." : "Following the evidence trail."}</h1>
        {scan.status != "failed" ?<p className="intro">{scan.currentStageDetail ?? "Preparing the audit."}</p> : '' }
        <div className="status-line"><span className={scan.status === "failed" ? "status-dot failed" : "status-dot"}></span><span>{scan.status.replaceAll("_", " ")}</span></div>
        {scan.status !== "failed"? <AuditStageRail status={scan.status} /> : ''}
        <ol className="event-log" aria-live="polite">{scan.events.map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span>{event.message}</span></li>)}</ol>
        {scan.status === "failed" && (
          <>
            <p className="form-error">No report was produced. The log above contains the recorded stage outcome.</p>
            <a href="/" className="back-button">
              <span>←</span>
              <span>Back</span>
            </a>
          </>
        )}
      </section>
    </main>
  );
}

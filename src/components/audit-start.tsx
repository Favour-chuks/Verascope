"use client";

import { FormEvent, startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import type { TargetMode } from "@/lib/domain";

const modes: Array<{ id: TargetMode; label: string; helper: string }> = [
  { id: "demo_app", label: "Quick demo", helper: "Trace a controlled storefront with planted, reproducible behavior." },
  { id: "repo_build", label: "Test my repo", helper: "Build the repository, then examine its real runtime behavior." },
  { id: "user_url", label: "Test a live URL", helper: "Inspect a public target you are authorized to test." },
];

const errors: Record<string, string> = {
  consent_not_attested: "Check the authorization box to test a live URL, or choose a different target option.",
  unsafe_target_url: "That URL can't be tested - it resolves to a private or internal address. Enter a public URL, or choose a different target option.",
  invalid_repo_url: "Enter an HTTPS GitHub owner/repository URL.",
  invalid_runtime_target: "Complete the fields required for this target option.",
};

const DEMO_REPOSITORY = "https://github.com/vercel/nextjs-portfolio-starter";

export function AuditStart() {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");
  const [mode, setMode] = useState<TargetMode>("demo_app");
  const [targetUrl, setTargetUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [buildCommand, setBuildCommand] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const changeMode = (nextMode: TargetMode) => {
    setMode(nextMode);
    setError("");
    setTargetUrl("");
    setConsent(false);
    setBuildCommand("");
    setStartCommand("");
    setShowCommands(false);
  };

  const canSubmit = Boolean(repoUrl.trim())
    && (mode !== "user_url" || Boolean(targetUrl.trim()) && consent)
    && (mode !== "repo_build" || Boolean(buildCommand.trim()) === Boolean(startCommand.trim()));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError("");
    const runtimeTarget = mode === "demo_app"
      ? { mode }
      : mode === "repo_build"
        ? { mode, ...(buildCommand.trim() ? { buildCommand: buildCommand.trim(), startCommand: startCommand.trim() } : {}) }
        : { mode, targetUrl: targetUrl.trim(), consentAttestation: true };
    try {
      const response = await fetch("/api/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoUrl: repoUrl.trim(), runtimeTarget }),
      });
      const payload = await response.json() as { id?: string; error?: { code?: string; message?: string } };
      if (!response.ok || !payload.id) {
        setError(errors[payload.error?.code ?? ""] ?? payload.error?.message ?? "The audit could not be started. Try again.");
        return;
      }
      startTransition(() => router.push("/scans/" + payload.id));
    } catch {
      setError("The audit could not be started. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="start-shell">
      <div className="topographic-grid" aria-hidden="true"></div>
      <div className="masthead">
        <a className="wordmark" href="/">VERASCOPE<span>●</span></a>
        <div className="masthead-meta"><span className="live-indicator"></span><p>Evidence-led technical diligence</p></div>
      </div>
      <section className="start-stage">
        <div className="start-introduction">
          <p className="eyebrow">Audit workspace / v3</p>
          <h1>Evidence before<br /><em>assumptions.</em></h1>
          <p className="intro">Verascope traces code, runtime behavior, and public disclosures into one reviewable record. Every claim ships with the evidence that supports it.</p>
          <div className="principle-stack" aria-label="Audit principles">
            <span><b>01</b> No finding without a citation</span>
            <span><b>02</b> Runtime behavior stays scoped</span>
            <span><b>03</b> Limits are stated plainly</span>
          </div>
        </div>

        <section className="start-panel" aria-label="Start an audit">
          <div className="panel-kicker"><span>New audit</span><span>Ready when you are</span></div>
          <form onSubmit={submit} noValidate>
            <div className="field-heading">
              <label className="field-label" htmlFor="repo-url"><span>01</span> Repository URL</label>
              {mode === "demo_app" ? <button className="preset-control" type="button" onClick={() => setRepoUrl(DEMO_REPOSITORY)}>Use demo repo</button> : null}
            </div>
            <input id="repo-url" className="text-input" value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/owner/repository" inputMode="url" autoComplete="url" />

            <fieldset className="mode-fieldset">
              <legend><span>02</span> Choose the evidence surface</legend>
              <div className="mode-grid" role="radiogroup" aria-label="Test against">
                {modes.map((option, index) => (
                  <label className={"mode-option " + (mode === option.id ? "is-active" : "")} key={option.id}>
                    <input type="radio" name="target-mode" value={option.id} checked={mode === option.id} onChange={() => changeMode(option.id)} />
                    <span className="mode-index">0{index + 1}</span>
                    <span className="mode-name">{option.label}</span>
                    <span className="mode-helper">{option.helper}</span>
                    <span className="mode-arrow" aria-hidden="true">↗</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {mode === "repo_build" ? (
              <div className="progressive-field">
                <button className="text-control" type="button" onClick={() => setShowCommands((value) => !value)}>{showCommands ? "Hide build/start commands" : "Specify build/start commands"}</button>
                {showCommands ? <div className="command-grid">
                  <label><span>Build command</span><input className="text-input" value={buildCommand} onChange={(event) => setBuildCommand(event.target.value)} placeholder="npm run build" /></label>
                  <label><span>Start command</span><input className="text-input" value={startCommand} onChange={(event) => setStartCommand(event.target.value)} placeholder="npm run start" /></label>
                </div> : null}
              </div>
            ) : null}

            {mode === "user_url" ? (
              <div className="live-fields">
                <label className="field-label" htmlFor="target-url"><span>03</span> Live URL</label>
                <input id="target-url" className="text-input" value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://staging.example.com" inputMode="url" autoComplete="url" />
                <label className="attestation">
                  <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                  <span>I confirm I&apos;m authorized to run automated tests against this URL.</span>
                </label>
                <p className="attestation-note">This records your confirmation. It does not verify authorization.</p>
              </div>
            ) : null}

            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <button className="primary-button" disabled={!canSubmit || submitting} type="submit"><span>{submitting ? "Starting audit..." : "Start evidence audit"}</span><span aria-hidden="true">→</span></button>
            <div className="form-footer"><p className="form-note">No finding ships without a citation.</p><p className="form-note">Scope and limitations included.</p></div>
            <p className="sr-only" aria-live="polite">{mode === "demo_app" ? "Quick demo selected." : mode === "repo_build" ? "Test my repo selected." : "Test a live URL selected."}</p>
          </form>
        </section>
      </section>
    </main>
  );
}

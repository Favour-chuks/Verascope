import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, StaticAuditOutput } from "@/lib/schemas/findings";

type CommandResult = {
  command: string;
  output: string;
  exitCode: number | null;
  timedOut?: boolean;
};

const READ_ONLY_COMMAND_TIMEOUT_MS = 10_000;

async function exists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function runReadOnly(
  repoPath: string,
  executable: string,
  args: string[],
  timeoutMs = READ_ONLY_COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const command = [executable, ...args].join(" ");
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: repoPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({
        command,
        output: `${output.slice(0, 4_000)}\n(command timed out after ${timeoutMs}ms)`.trim(),
        exitCode: null,
        timedOut: true,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", (error) => finish({ command, output: error.message, exitCode: null }));
    child.once("close", (exitCode) => finish({ command, output: output.slice(0, 4_000) || "(no output)", exitCode }));
  });
}

function commandFinding(category: Finding["category"], severity: Finding["severity"], claim: string, result: CommandResult, whyItMatters?: string): Finding {
  return { category, severity, claim, whyItMatters, citation: { type: "command", command: result.command, output: result.output }, confidence: "verified" };
}

export async function collectStaticEvidence(repoPath: string): Promise<StaticAuditOutput> {
  const findings: Finding[] = [];
  const notChecked: string[] = [];
  const packagePath = join(repoPath, "package.json");

  if (await exists(packagePath)) {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = packageJson.scripts ?? {};
    const manifest = await runReadOnly(repoPath, "rg", ["-n", "^\\s*\\\"(build|start|test|dev)\\\"", "package.json"]);
    findings.push(commandFinding("code_quality", "minor", "Repository build, start, test, or development scripts were identified from package.json.", manifest, "The commands are cited for reproducible follow-up; their behavior has not been executed in this non-executing pass."));
    if (!scripts.test) notChecked.push("No package.json test script was available to execute.");
  } else {
    notChecked.push("No package.json was present; npm/Next.js-specific checks were not applicable.");
  }

  const ci = await runReadOnly(repoPath, "rg", ["--files", "-g", ".github/workflows/**", "-g", ".gitlab-ci.yml", "-g", "azure-pipelines.yml"]);
  if (ci.exitCode === 0 && ci.output !== "(no output)") {
    findings.push(commandFinding("code_quality", "minor", "CI configuration files are present.", ci, "Presence alone does not prove that CI executes tests; that requires execution or configuration review."));
  } else {
    notChecked.push("No supported CI configuration file was located by the static evidence pass.");
  }

  const authors = await runReadOnly(repoPath, "git", ["--no-pager", "shortlog", "-s", "-n", "HEAD"]);
  if (authors.exitCode === 0) {
    findings.push(commandFinding("team_risk", "minor", "Repository commit authorship counts were collected for human review.", authors, "Commit concentration is a factual data point, not a conclusion about team availability or retention."));
  } else {
    notChecked.push("Git authorship history could not be read.");
  }

  const secretFiles = await runReadOnly(repoPath, "rg", ["-l", "--hidden", "--glob", "!.git/**", "(AKIA[0-9A-Z]{16}|-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,})", "."]);
  if (secretFiles.exitCode === 0 && secretFiles.output !== "(no output)") {
    findings.push(commandFinding("security", "critical", "Potential committed secret patterns were found; file names are cited without exposing values.", secretFiles, "Potential credentials should be rotated and investigated without copying secret material into the report."));
  } else {
    notChecked.push("No likely committed-secret file names matched the static patterns; git history was not searched in this non-executing pass.");
  }

  const aiUsage = await runReadOnly(repoPath, "rg", ["-n", "--glob", "!node_modules/**", "(openai|anthropic|langchain|gpt-[0-9]|claude)", "."]);
  if (aiUsage.exitCode === 0 && aiUsage.output !== "(no output)") {
    findings.push({
      ...commandFinding("ai_exposure", "minor", "Static AI-provider usage signals were found; confirm data transmission at runtime.", aiUsage, "This is static signal only — confirm at runtime."),
      confidence: "heuristic",
    });
  }

  notChecked.push("Dependency installation, test execution, vulnerability scanning, and repository build/start were intentionally not run by this non-executing evidence collector.");
  return { findings, notChecked };
}

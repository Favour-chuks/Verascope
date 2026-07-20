import { GoogleGenAI } from "@google/genai";
import { VercelSandboxClient } from "@openai/agents-extensions/sandbox/vercel";
import { getManagedVercelSandboxClient } from "@/lib/sandbox/managed-vercel-pool";
import { CODE_HEALTH_INSTRUCTIONS, SECURITY_LICENSE_AI_INSTRUCTIONS } from "@/lib/agents/instructions";
import { getGeminiAuditEnvironment, getServerEnvironment, getVercelSandboxEnvironment } from "@/lib/config/env";
import { StaticAuditOutputSchema, type Finding, type StaticAuditOutput } from "@/lib/schemas/findings";

export type StaticAgentKind = "code_health" | "security_license_ai";

type GeminiClientLike = {
  models: {
    generateContent(request: unknown): Promise<{ text?: string }>;
  };
};

type EnvironmentSource = Record<string, string | undefined>;

export type StaticAgentRunOptions = {
  sandboxClient?: Pick<VercelSandboxClient, "create">;
  geminiClient?: GeminiClientLike;
  /** Test seam only. Production uses the server process environment. */
  environment?: EnvironmentSource;
  /** Lets Agent 1 and Agent 2 reason over one staged repository snapshot. */
  evidence?: StagedAuditEvidence;
  timeoutMs?: number;
  /** Test seam only; production uses a conservative bounded retry cadence. */
  maxGeminiAttempts?: number;
  retryBaseDelayMs?: number;
  signal?: AbortSignal;
};

type StaticAuditDefinition = {
  name: string;
  instructions: string;
  repo: string;
};

export type StagedAuditEvidence = {
  packageJson: string;
  files: string;
  ciFiles: string;
  modules: string;
  authors: string;
  secretSignals: string;
  aiSignals: string;
  historySignals: string;
  dependencyInstall: string;
  dependencyAudit: string;
  licenseInventory: string;
  tests: string;
};

const STATIC_COMMAND_SIGNATURES = [
  "find . -maxdepth 3",
  "find .github",
  "find . -maxdepth 2",
  "git --no-pager shortlog",
  "rg -l",
  "git --no-pager log",
  "npm ci --ignore-scripts",
  "npm install --ignore-scripts",
  "npm audit --json",
  "node -e",
] as const;

function truncate(value: string, limit = 12_000) {
  return value.length > limit ? `${value.slice(0, limit)}\n... (truncated)` : value;
}

const PROMPT_EVIDENCE_LIMIT = 3_500;

export function promptEvidence(kind: StaticAgentKind, evidence: StagedAuditEvidence) {
  const shared: Array<[string, string]> = [
    ["PACKAGE MANIFEST (safe allow-list)", evidence.packageJson],
    ["FILES", evidence.files],
  ];
  const agentSpecific: Array<[string, string]> = kind === "code_health"
    ? [
      ["CI FILES", evidence.ciFiles],
      ["TOP-LEVEL MODULES", evidence.modules],
      ["ANONYMIZED AUTHORSHIP CONCENTRATION", evidence.authors],
      ["DEPENDENCY INSTALL (lifecycle scripts suppressed)", evidence.dependencyInstall],
      ["TEST-SUITE COVERAGE", evidence.tests],
    ]
    : [
      ["CANDIDATE SECRET FILE PATHS (values are intentionally withheld)", evidence.secretSignals],
      ["AI-VENDOR SIGNAL FILE PATHS", evidence.aiSignals],
      ["AI-VENDOR HISTORY FILE PATHS", evidence.historySignals],
      ["DEPENDENCY ADVISORY OUTPUT", evidence.dependencyAudit],
      ["LICENSE INVENTORY", evidence.licenseInventory],
    ];
  return [...shared, ...agentSpecific]
    .map(([label, value]) => label + ":\n" + truncate(value, PROMPT_EVIDENCE_LIMIT))
    .join("\n\n");
}

export function repoSlugFromUrl(repoUrl: string) {
  const url = new URL(repoUrl);
  if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("invalid_repo_url");
  const [owner, repository] = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
  if (!owner || !repository || url.pathname.split("/").filter(Boolean).length !== 2) throw new Error("invalid_repo_url");
  return `${owner}/${repository}`;
}

export function buildStaticAuditDefinition(kind: StaticAgentKind, repoUrl: string): StaticAuditDefinition {
  const repo = repoSlugFromUrl(repoUrl);
  return kind === "code_health"
    ? { name: "Code Health Agent", instructions: CODE_HEALTH_INSTRUCTIONS, repo }
    : { name: "Security, License & Static AI-Vendor Exposure Agent", instructions: SECURITY_LICENSE_AI_INSTRUCTIONS, repo };
}

/** The only production sandbox client: target repositories never run on the app host. */
export function resolveStaticSandboxClient(explicitClient?: Pick<VercelSandboxClient, "create">): Pick<VercelSandboxClient, "create"> {
  return explicitClient ?? getManagedVercelSandboxClient({
    ...getVercelSandboxEnvironment(),
    // Never forward the app host environment to a staged repository.
    env: { CI: "1" },
  });
}

function createGeminiClient(apiKey: string): GeminiClientLike {
  return new GoogleGenAI({ apiKey }) as unknown as GeminiClientLike;
}

function sanitizePackageManifest(value: string) {
  try {
    const packageJson = JSON.parse(value) as Record<string, unknown>;
    const dependencies = (key: string) => {
      const candidate = packageJson[key];
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
      return Object.fromEntries(
        Object.entries(candidate).filter(([name, version]) => typeof name === "string" && typeof version === "string"),
      );
    };
    const scripts = packageJson.scripts;
    return JSON.stringify({
      name: typeof packageJson.name === "string" ? packageJson.name : undefined,
      version: typeof packageJson.version === "string" ? packageJson.version : undefined,
      private: typeof packageJson.private === "boolean" ? packageJson.private : undefined,
      packageManager: typeof packageJson.packageManager === "string" ? packageJson.packageManager : undefined,
      engines: packageJson.engines && typeof packageJson.engines === "object" && !Array.isArray(packageJson.engines) ? packageJson.engines : undefined,
      // Script names are enough to determine declared coverage. Their command
      // bodies can contain arbitrary values, so do not transmit them.
      scripts: scripts && typeof scripts === "object" && !Array.isArray(scripts) ? Object.keys(scripts) : [],
      dependencies: dependencies("dependencies"),
      devDependencies: dependencies("devDependencies"),
      peerDependencies: dependencies("peerDependencies"),
      optionalDependencies: dependencies("optionalDependencies"),
    }, null, 2);
  } catch {
    return "(package.json could not be safely parsed)";
  }
}

/**
 * Collect cited static evidence without executing submitted application code.
 * In particular, candidate-secret results are paths only: raw matched content
 * never leaves the sandbox and is never placed in a model prompt or report.
 */
export async function stageStaticAuditEvidence(
  definition: StaticAuditDefinition,
  sandboxClient: Pick<VercelSandboxClient, "create">,
): Promise<StagedAuditEvidence> {
  const session = await sandboxClient.create({
    manifest: { entries: { repo: { type: "git_repo", repo: definition.repo, ref: "main" } } },
  });
  try {
    const readPackageJson = async () => {
      try {
        const value = await session.readFile({ path: "repo/package.json", maxBytes: 128_000 });
        return truncate(sanitizePackageManifest(Buffer.from(value).toString("utf8")));
      } catch {
        return "(package.json unavailable)";
      }
    };
    const inspect = async (command: string) => {
      try {
        return truncate(await session.execCommand({ cmd: command, workdir: "repo", maxOutputTokens: 2_000 }));
      } catch (error) {
        return `(command unavailable: ${error instanceof Error ? error.message : "unknown sandbox error"})`;
      }
    };
    const [packageJson, files, ciFiles, modules, authors, secretSignals, aiSignals, historySignals] = await Promise.all([
      readPackageJson(),
      inspect("find . -maxdepth 3 -type f -not -path './.git/*' | sort | head -n 250"),
      inspect("find .github -type f 2>/dev/null | sort || true"),
      inspect("find . -maxdepth 2 -type d -not -path './.git*' -not -path './node_modules*' | sort | head -n 250"),
      // Deliberately redact author identities while retaining concentration data.
      inspect("git --no-pager shortlog -s -n HEAD | awk '{print NR \": \" $1 \" commits\"}'"),
      // --files-with-matches keeps secret values inside the sandbox.
      inspect("rg -l --hidden --glob '!.git/**' --glob '!node_modules/**' '(AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----|password|secret|api[_-]?key)' . || true"),
      inspect("rg -l --hidden --glob '!.git/**' --glob '!node_modules/**' '(openai|anthropic|langchain|gpt-[0-9]|claude|gemini|generativeai)' . || true"),
      inspect("git --no-pager log --all -G'(openai|anthropic|langchain|gpt-[0-9]|claude|gemini|generativeai)' --format='' --name-only | sort -u | head -n 250 || true"),
    ]);
    // Package lifecycle scripts are suppressed. This permits a dependency
    // advisory/license inspection without executing repository code.
    const dependencyInstall = await inspect("if [ -f package-lock.json ]; then timeout 120s npm ci --ignore-scripts --no-audit --no-fund; else timeout 120s npm install --ignore-scripts --no-audit --no-fund; fi");
    const [dependencyAudit, licenseInventory] = await Promise.all([
      inspect("if [ -d node_modules ]; then npm audit --json || true; else echo 'not run: dependencies unavailable'; fi"),
      inspect("if [ -d node_modules ]; then node -e \"const fs=require('fs'),p=require('path'),out=[];for(const e of fs.readdirSync('node_modules',{withFileTypes:true})){if(e.name.startsWith('.'))continue;const ds=e.name.startsWith('@')?fs.readdirSync(p.join('node_modules',e.name),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>p.join(e.name,x.name)):[e.name];for(const d of ds){try{const j=JSON.parse(fs.readFileSync(p.join('node_modules',d,'package.json'),'utf8'));if(j.license)out.push({name:j.name,version:j.version,license:j.license})}catch{}}}console.log(JSON.stringify(out.slice(0,500)))\"; else echo 'not run: dependencies unavailable'; fi"),
    ]);
    return {
      packageJson,
      files,
      ciFiles,
      modules,
      authors,
      secretSignals,
      aiSignals,
      historySignals,
      dependencyInstall,
      dependencyAudit,
      licenseInventory,
      tests: "Not run: static agents never execute submitted repository test suites. This is intentional; tests can execute untrusted project code and belong only to the separately bounded repo_build runtime stage.",
    };
  } finally {
    await session.close?.();
  }
}

export function parseStaticAgentOutput(output: unknown): StaticAuditOutput {
  const text = typeof output === "string" ? output.trim() : JSON.stringify(output);
  const withoutFence = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const normalizeFinding = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const finding = value as Record<string, unknown>;
    const rawCitation = finding.citation;
    if (!rawCitation || typeof rawCitation !== "object" || Array.isArray(rawCitation)) return value;
    const citation = rawCitation as Record<string, unknown>;
    const providerType = citation.type ?? citation.citationType ?? citation.citation_type;
    const inferredType = providerType === "command_output" ? "command" : providerType
      ?? ((citation.filePath ?? citation.file_path) ? "file" : undefined)
      ?? ((citation.command && citation.output) ? "command" : undefined)
      ?? ((citation.host && citation.method) ? "network_trace" : undefined);
    return {
      ...finding,
      whyItMatters: finding.whyItMatters ?? finding.why_it_matters,
      disclosedClaim: finding.disclosedClaim ?? finding.disclosed_claim,
      disclosedClaimLocation: finding.disclosedClaimLocation ?? finding.disclosed_claim_location,
      citation: {
        ...citation,
        type: inferredType,
        filePath: citation.filePath ?? citation.file_path,
        lineStart: citation.lineStart ?? citation.line_start,
        lineEnd: citation.lineEnd ?? citation.line_end,
        timingMs: citation.timingMs ?? citation.timing_ms,
        payloadSummary: citation.payloadSummary ?? citation.payload_summary,
      },
    };
  };
  const normalizeOutput = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const result = value as Record<string, unknown>;
    return {
      ...result,
      notChecked: result.notChecked ?? result.not_checked ?? [],
      findings: Array.isArray(result.findings) ? result.findings.map(normalizeFinding) : result.findings,
    };
  };
  const parse = (value: string) => StaticAuditOutputSchema.parse(normalizeOutput(JSON.parse(value)));
  const citationShape = (value: string) => {
    try {
      const parsed = JSON.parse(value) as { findings?: unknown[] };
      return (parsed.findings ?? []).slice(0, 8).map((finding) => {
        const citation = finding && typeof finding === "object" && !Array.isArray(finding)
          ? (finding as Record<string, unknown>).citation : undefined;
        return citation && typeof citation === "object" && !Array.isArray(citation)
          ? { keys: Object.keys(citation).sort(), type: typeof (citation as Record<string, unknown>).type === "string" ? (citation as Record<string, unknown>).type : null }
          : { keys: [], type: null };
      });
    } catch { return []; }
  };
  try {
    return parse(withoutFence);
  } catch (firstError) {
    const firstObject = withoutFence.indexOf("{");
    const lastObject = withoutFence.lastIndexOf("}");
    if (firstObject < 0 || lastObject <= firstObject) throw new Error("static_agent_output_not_json");
    const extracted = withoutFence.slice(firstObject, lastObject + 1);
    try { return parse(extracted); } catch {
      throw new Error(`static_agent_output_invalid_citation_shape:${JSON.stringify(citationShape(extracted))}`, { cause: firstError });
    }
  }
}

function normalizedPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^repo\//, "");
}

function evidencePaths(evidence: StagedAuditEvidence) {
  return [
    evidence.files,
    evidence.ciFiles,
    evidence.modules,
    evidence.secretSignals,
    evidence.aiSignals,
    evidence.historySignals,
  ].flatMap((section) => section.split(/\r?\n/).map((line) => normalizedPath(line.trim())).filter(Boolean));
}

/**
 * A citation is only shippable when it points back to a staged file path or to
 * output we actually collected from one of the fixed sandbox commands. This is
 * intentionally conservative: uncertain citations fail the agent rather than
 * becoming plausible-looking report content.
 */
export function isStaticFindingGrounded(finding: Finding, evidence: StagedAuditEvidence) {
  const citation = finding.citation;
  if (citation.type === "file") {
    const expected = normalizedPath(citation.filePath);
    return evidencePaths(evidence).includes(expected);
  }
  if (citation.type !== "command") return false;
  const commandAllowed = STATIC_COMMAND_SIGNATURES.some((signature) => citation.command.includes(signature));
  const outputRecorded = [
    evidence.files,
    evidence.ciFiles,
    evidence.modules,
    evidence.authors,
    evidence.secretSignals,
    evidence.aiSignals,
    evidence.historySignals,
    evidence.dependencyInstall,
    evidence.dependencyAudit,
    evidence.licenseInventory,
    evidence.tests,
  ].some((section) => section.includes(citation.output));
  return commandAllowed && outputRecorded;
}

export function assertStaticAuditGrounding(output: StaticAuditOutput, evidence: StagedAuditEvidence) {
  const invalid = output.findings.find((finding) => !isStaticFindingGrounded(finding, evidence));
  if (invalid) {
    const citation = invalid.citation;
    if (citation.type === "file") throw new Error("static_agent_ungrounded_citation:file_path");
    if (citation.type !== "command") throw new Error("static_agent_ungrounded_citation:citation_type");
    const allowed = STATIC_COMMAND_SIGNATURES.some((signature) => citation.command.includes(signature));
    if (!allowed) throw new Error("static_agent_ungrounded_citation:command_name");
    throw new Error("static_agent_ungrounded_citation:command_output");
  }
  return output;
}

/**
 * Production path: silently drops findings whose citations cannot be verified
 * against the staged evidence snapshot and records the count in notChecked.
 * This prevents a single model paraphrase from failing the entire scan.
 * The hard-throwing assertStaticAuditGrounding remains for contract tests.
 */
export function filterToGroundedStaticAuditOutput(output: StaticAuditOutput, evidence: StagedAuditEvidence): StaticAuditOutput {
  const grounded = output.findings.filter((finding) => isStaticFindingGrounded(finding, evidence));
  const dropped = output.findings.length - grounded.length;
  return {
    findings: grounded,
    notChecked: dropped > 0
      ? [...output.notChecked, `${dropped} model finding(s) were excluded: their citations could not be verified against the staged evidence snapshot.`]
      : output.notChecked,
  };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("gemini_static_agent_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function retryableGeminiStatus(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const detail = error as { status?: unknown; code?: unknown; cause?: { code?: unknown } };
  if (detail.status === 429 || detail.status === 500 || detail.status === 503 || detail.status === 504) return true;
  const code = detail.code ?? detail.cause?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
}

async function generateGeminiContentWithRetry(
  client: GeminiClientLike,
  request: unknown,
  maxAttempts = 4,
  retryBaseDelayMs = 2_000,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await Promise.race([
        client.models.generateContent(request),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            const err = new Error("gemini_api_hang");
            (err as any).code = "ETIMEDOUT";
            reject(err);
          }, 90000);
        })
      ]);
    } catch (error) {
      lastError = error;
      if (!retryableGeminiStatus(error) || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryBaseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

export async function runStaticAgent(
  kind: StaticAgentKind,
  repoUrl: string,
  options: StaticAgentRunOptions = {},
): Promise<StaticAuditOutput> {
  if (options.signal?.aborted) throw new Error("gemini_static_agent_aborted");
  const { apiKey, model } = getGeminiAuditEnvironment(options.environment);
  const timeoutMs = options.timeoutMs ?? getServerEnvironment(options.environment).STATIC_AGENT_TIMEOUT_MS;
  const definition = buildStaticAuditDefinition(kind, repoUrl);
  const operation = (async () => {
    const evidence = options.evidence ?? await stageStaticAuditEvidence(definition, resolveStaticSandboxClient(options.sandboxClient));
    const prompt = [
      "Return only a JSON object matching the supplied schema.",
      "Audit only the supplied sandbox evidence. Every finding needs a citation drawn from that evidence; never invent file paths, line ranges, counts, or command output.",
      "Citation contract: use citation.type exactly 'file' or 'command'. A file citation's filePath must be copied verbatim from FILES, CI FILES, TOP-LEVEL MODULES, CANDIDATE SECRET FILE PATHS, AI-VENDOR SIGNAL FILE PATHS, or AI-VENDOR HISTORY FILE PATHS. A command citation's command must contain one of these exact collected command signatures: " + STATIC_COMMAND_SIGNATURES.join(" | ") + ". Its output must be a literal contiguous excerpt from the matching evidence section. Do not cite build, start, or test execution: they were not run by these static agents.",
      kind === "code_health"
        ? "Scope boundary: emit only code_quality or team_risk findings. Dependency vulnerabilities, licenses, committed-secret signals, and AI-provider exposure belong to the Security, License & Static AI-Vendor Exposure Agent; place them in notChecked here rather than changing category."
        : "Scope boundary: emit only security, licensing, or ai_exposure findings. Code-quality and team-risk conclusions belong to the Code Health Agent; place them in notChecked here rather than changing category.",
      "If the evidence cannot support a check, add it to notChecked. Never make a legal conclusion or expose a secret value.",
      `Repository: ${definition.repo}`,
      promptEvidence(kind, evidence),
    ].join("\n\n");
    const client = options.geminiClient ?? createGeminiClient(apiKey);
    const response = await generateGeminiContentWithRetry(client, {
      model,
      contents: prompt,
      config: {
        systemInstruction: definition.instructions,
        responseMimeType: "application/json",
        responseJsonSchema: StaticAuditOutputSchema.toJSONSchema(),
      },
    }, options.maxGeminiAttempts, options.retryBaseDelayMs);
    if (!response.text) throw new Error("gemini_static_agent_empty_output");
    const parsed = parseStaticAgentOutput(response.text);
    const allowedCategories = kind === "code_health"
      ? new Set<Finding["category"]>(["code_quality", "team_risk"])
      : new Set<Finding["category"]>(["security", "licensing", "ai_exposure"]);
    const scopedFindings = parsed.findings.filter((finding) => allowedCategories.has(finding.category));
    const excluded = parsed.findings.length - scopedFindings.length;
    const scoped = {
      findings: scopedFindings,
      notChecked: excluded
        ? [...parsed.notChecked, `${excluded} out-of-scope model proposal(s) were excluded from this agent's report.`]
        : parsed.notChecked,
    };
    return filterToGroundedStaticAuditOutput(scoped, evidence);
  })();
  return await withTimeout(operation, timeoutMs);
}

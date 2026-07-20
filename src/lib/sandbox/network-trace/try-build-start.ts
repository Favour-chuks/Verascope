import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { VercelSandboxClient } from "@openai/agents-extensions/sandbox/vercel";
import { getManagedVercelSandboxClient } from "@/lib/sandbox/managed-vercel-pool";
import {
  getServerEnvironment,
  getVercelSandboxEnvironment,
  type ServerEnvironment,
} from "@/lib/config/env";

export type PackageManager = "npm" | "pnpm" | "yarn";

export type BuildStartCommands = {
  packageManager: PackageManager;
  buildCommand: string;
  startCommand: string;
  detected: boolean;
};

export type BuildStartAttempt =
  | {
      status: "runnable";
      baseUrl: string;
      commands: BuildStartCommands;
      installOutput: string;
      buildOutput: string;
      startOutput: string;
      stop: () => Promise<void>;
    }
  | {
      status: "repo_not_runnable";
      reason: "commands_not_detected" | "install_failed" | "build_failed" | "start_failed" | "health_check_failed";
      commands: BuildStartCommands | null;
      installOutput: string;
      buildOutput: string;
      startOutput: string;
    };

export type TryBuildStartOptions = {
  buildCommand?: string;
  startCommand?: string;
  installDependencies?: boolean;
  installTimeoutMs?: number;
  buildTimeoutMs?: number;
  startTimeoutMs?: number;
  healthCheckTimeoutMs?: number;
  port?: number;
};

export type VercelBuildStartOptions = TryBuildStartOptions & {
  /** Test seam only. Production callers use the configured Vercel client. */
  client?: Pick<VercelSandboxClient, "create">;
};

type VercelSandboxSessionLike = {
  execCommand?: (args: { cmd: string; workdir?: string; maxOutputTokens?: number }) => Promise<string>;
  readFile?: (args: { path: string; maxBytes?: number }) => Promise<string | Uint8Array>;
  pathExists?: (path: string) => Promise<boolean>;
  resolveExposedPort?: (port: number) => Promise<{ url?: string; host?: string; port?: number; tls?: boolean; protocol?: string }>;
  close?: () => Promise<void>;
};

const BASE_DEFAULTS: Required<Omit<TryBuildStartOptions, "buildCommand" | "startCommand" | "port">> = {
  installDependencies: false,
  installTimeoutMs: 120_000,
  buildTimeoutMs: 90_000,
  startTimeoutMs: 30_000,
  healthCheckTimeoutMs: 30_000,
};

export function getTryBuildStartDefaults(environment: ServerEnvironment = getServerEnvironment()) {
  return { ...BASE_DEFAULTS, buildTimeoutMs: environment.REPO_BUILD_TIMEOUT_MS };
}

type CommandResult = { exitCode: number | null; timedOut: boolean; output: string };

function truncate(output: string) {
  return output.length > 8_000 ? `${output.slice(0, 8_000)}\n... (truncated)` : output;
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function managerCommand(manager: PackageManager, script: string) {
  if (manager === "yarn") return `yarn ${script}`;
  return `${manager} run ${script}`;
}

function installCommand(manager: PackageManager, hasLockFile: boolean) {
  if (manager === "npm") return hasLockFile ? "npm ci" : "npm install";
  if (manager === "pnpm") return hasLockFile ? "pnpm install --frozen-lockfile" : "pnpm install";
  return hasLockFile ? "yarn install --immutable" : "yarn install";
}

export async function detectBuildStartCommands(repoPath: string, overrides: Pick<TryBuildStartOptions, "buildCommand" | "startCommand"> = {}): Promise<BuildStartCommands | null> {
  const hasBuildOverride = Boolean(overrides.buildCommand?.trim());
  const hasStartOverride = Boolean(overrides.startCommand?.trim());
  if (hasBuildOverride !== hasStartOverride) return null;

  const packagePath = join(repoPath, "package.json");
  if (!(await fileExists(packagePath))) return null;
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { packageManager?: string; scripts?: Record<string, string> };

  const lockFiles: Array<[PackageManager, string]> = [
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["npm", "package-lock.json"],
  ];
  const declaredManager = pkg.packageManager?.split("@")[0];
  const packageManager: PackageManager = declaredManager === "pnpm" || declaredManager === "yarn" || declaredManager === "npm"
    ? declaredManager
    : (await Promise.all(lockFiles.map(async ([manager, lock]) => ((await fileExists(join(repoPath, lock))) ? manager : null))))
      .find((manager): manager is PackageManager => manager !== null) ?? "npm";

  if (hasBuildOverride && hasStartOverride) {
    return {
      packageManager,
      buildCommand: overrides.buildCommand!.trim(),
      startCommand: overrides.startCommand!.trim(),
      detected: false,
    };
  }

  const scripts = pkg.scripts ?? {};
  if (!scripts.build) return null;
  const startScript = scripts.start ? "start" : scripts.dev ? "dev" : null;
  if (!startScript) return null;
  return {
    packageManager,
    buildCommand: managerCommand(packageManager, "build"),
    startCommand: managerCommand(packageManager, startScript),
    detected: true,
  };
}

// SandboxSession workdirs are manifest-root-relative. The Vercel manifest's
// root is `/workspace`, so passing `/workspace/repo` would be rejected as an
// escaping path by the SDK.
const REMOTE_REPO_PATH = "repo";
const EXIT_MARKER = "__VERASCOPE_EXIT_CODE:";

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`;
}

function printableOutput(response: string) {
  const outputIndex = response.indexOf("Output:\n");
  return truncate(outputIndex >= 0 ? response.slice(outputIndex + "Output:\n".length) : response);
}

function commandResultFromResponse(response: string) {
  const output = printableOutput(response);
  const markerIndex = output.lastIndexOf(EXIT_MARKER);
  if (markerIndex < 0) return { exitCode: null, timedOut: false, output } satisfies CommandResult;
  const exitCode = Number(output.slice(markerIndex + EXIT_MARKER.length).match(/^\d+/)?.[0]);
  const cleanOutput = output.slice(0, markerIndex).trimEnd();
  return {
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    timedOut: exitCode === 124,
    output: cleanOutput,
  } satisfies CommandResult;
}

async function runSandboxCommand(
  session: Pick<VercelSandboxSessionLike, "execCommand">,
  command: string,
  timeoutMs: number,
  workdir = REMOTE_REPO_PATH,
) {
  if (!session.execCommand) throw new Error("sandbox_exec_unavailable");
  // `timeout` is inside the hosted sandbox: the repository command never runs
  // on the Next.js host and a provider hiccup cannot turn into an unbounded run.
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const wrapped = `timeout --signal=TERM --kill-after=5s ${seconds}s sh -lc ${shellQuote(command)}; status=$?; printf '\n${EXIT_MARKER}%s\n' "$status"; exit 0`;
  return commandResultFromResponse(await session.execCommand({ cmd: wrapped, workdir, maxOutputTokens: 2_000 }));
}

function repoSlugFromUrl(repoUrl: string) {
  const url = new URL(repoUrl);
  if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("invalid_repo_url");
  const [owner, repository] = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
  if (!owner || !repository || url.pathname.split("/").filter(Boolean).length !== 2) throw new Error("invalid_repo_url");
  return `${owner}/${repository}`;
}

async function readSandboxBuildStartCommands(
  session: Pick<VercelSandboxSessionLike, "readFile">,
  overrides: Pick<TryBuildStartOptions, "buildCommand" | "startCommand">,
) {
  if (!session.readFile) throw new Error("sandbox_read_file_unavailable");
  try {
    const content = await session.readFile({ path: "repo/package.json", maxBytes: 1_000_000 });
    const pkg = JSON.parse(Buffer.from(content).toString("utf8")) as { packageManager?: string; scripts?: Record<string, string> };
    // `detectBuildStartCommands` is filesystem based, so choose from the
    // already-read manifest here instead of copying an entire checkout to host.
    const hasBuildOverride = Boolean(overrides.buildCommand?.trim());
    const hasStartOverride = Boolean(overrides.startCommand?.trim());
    if (hasBuildOverride !== hasStartOverride) return null;
    const declaredManager = pkg.packageManager?.split("@")[0];
    const packageManager: PackageManager = declaredManager === "pnpm" || declaredManager === "yarn" || declaredManager === "npm" ? declaredManager : "npm";
    if (hasBuildOverride && hasStartOverride) {
      return { packageManager, buildCommand: overrides.buildCommand!.trim(), startCommand: overrides.startCommand!.trim(), detected: false };
    }
    const scripts = pkg.scripts ?? {};
    if (!scripts.build) return null;
    const startScript = scripts.start ? "start" : scripts.dev ? "dev" : null;
    return startScript ? {
      packageManager,
      buildCommand: managerCommand(packageManager, "build"),
      startCommand: managerCommand(packageManager, startScript),
      detected: true,
    } : null;
  } catch {
    return null;
  }
}

/**
 * The production repo_build path. It materializes and runs the submitted
 * repository only in a short-lived Vercel Sandbox; the local helper above is
 * retained solely for deterministic fixture tests.
 */
export async function tryBuildAndStartInVercelSandbox(
  repoUrl: string,
  options: VercelBuildStartOptions = {},
): Promise<BuildStartAttempt> {
  const config = { ...getTryBuildStartDefaults(), ...options };
  const port = config.port ?? 3000;
  const repo = repoSlugFromUrl(repoUrl);
  // A hosted Linux sandbox must keep its own PATH and OS setup. Forwarding the
  // app host's Windows variables breaks it, and forwarding app configuration
  // would leak secrets into the submitted repository. CI is the whole contract.
  const safeEnvironment = { CI: "1" };
  const client = options.client ?? getManagedVercelSandboxClient({
    ...getVercelSandboxEnvironment(),
    exposedPorts: [port],
    // Include staging plus dependency install as well as the spec's bounded
    // build/start/health windows; otherwise Vercel could end a valid attempt
    // while `npm ci` is still running.
    timeoutMs: 60_000 + config.installTimeoutMs + config.buildTimeoutMs + config.startTimeoutMs + config.healthCheckTimeoutMs,
    env: safeEnvironment,
  });
  const session = await client.create({
    manifest: { entries: { repo: { type: "git_repo", repo, ref: "main" } } },
  }) as VercelSandboxSessionLike;
  const close = async () => { await session.close?.(); };

  try {
    const commands = await readSandboxBuildStartCommands(session, options);
    if (!commands) {
      await close();
      return { status: "repo_not_runnable", reason: "commands_not_detected", commands: null, installOutput: "", buildOutput: "", startOutput: "" };
    }

    const lockName = commands.packageManager === "pnpm" ? "pnpm-lock.yaml" : commands.packageManager === "yarn" ? "yarn.lock" : "package-lock.json";
    const hasLockFile = await session.pathExists?.(`repo/${lockName}`) ?? false;
    let installOutput = "";
    if (config.installDependencies) {
      const install = await runSandboxCommand(session, installCommand(commands.packageManager, hasLockFile), config.installTimeoutMs);
      installOutput = install.output;
      if (install.exitCode !== 0 || install.timedOut) {
        await close();
        return { status: "repo_not_runnable", reason: "install_failed", commands, installOutput, buildOutput: "", startOutput: "" };
      }
    }

    const build = await runSandboxCommand(session, commands.buildCommand, config.buildTimeoutMs);
    if (build.exitCode !== 0 || build.timedOut) {
      await close();
      return { status: "repo_not_runnable", reason: "build_failed", commands, installOutput, buildOutput: build.output, startOutput: "" };
    }

    const started = await runSandboxCommand(
      session,
      `rm -f .verascope-start.log .verascope-start.pid; (PORT=${port} ${commands.startCommand}) > .verascope-start.log 2>&1 & echo $! > .verascope-start.pid; sleep 1; kill -0 "$(cat .verascope-start.pid)"`,
      config.startTimeoutMs,
    );
    let startOutput = started.output;
    if (started.exitCode !== 0 || started.timedOut) {
      const logs = await session.readFile?.({ path: "repo/.verascope-start.log", maxBytes: 32_000 }).catch(() => "");
      startOutput = truncate(`${startOutput}\n${logs ? Buffer.from(logs).toString("utf8") : ""}`.trim());
      await close();
      return { status: "repo_not_runnable", reason: "start_failed", commands, installOutput, buildOutput: build.output, startOutput };
    }

    const health = await runSandboxCommand(
      session,
      `deadline=$(( $(date +%s) + ${Math.max(1, Math.ceil(config.healthCheckTimeoutMs / 1_000))} )); while [ "$(date +%s)" -lt "$deadline" ]; do curl -fsS --max-time 2 http://127.0.0.1:${port}/ >/dev/null && exit 0; sleep 1; done; exit 1`,
      config.healthCheckTimeoutMs + 5_000,
    );
    const logs = await session.readFile?.({ path: "repo/.verascope-start.log", maxBytes: 32_000 }).catch(() => "");
    startOutput = truncate(`${startOutput}\n${health.output}\n${logs ? Buffer.from(logs).toString("utf8") : ""}`.trim());
    if (health.exitCode !== 0 || health.timedOut) {
      await close();
      return { status: "repo_not_runnable", reason: "health_check_failed", commands, installOutput, buildOutput: build.output, startOutput };
    }

    const endpoint = await session.resolveExposedPort?.(port);
    const endpointProtocol = endpoint?.protocol ?? (endpoint?.tls ? "https" : "http");
    const baseUrl = endpoint?.url
      ?? (endpoint?.host ? endpointProtocol + "://" + endpoint.host + (endpoint.port ? ":" + endpoint.port : "") : "http://127.0.0.1:" + port);
    return {
      status: "runnable",
      baseUrl,
      commands,
      installOutput,
      buildOutput: build.output,
      startOutput,
      stop: close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

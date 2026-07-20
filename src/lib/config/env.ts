import { z } from "zod";

type EnvironmentSource = Record<string, string | undefined>;

const positiveInteger = z.coerce.number().int().positive();
const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");
const emptyToUndefined = (value: unknown) => typeof value === "string" && value.trim() === "" ? undefined : value;

const ServerEnvironmentSchema = z.object({
  // Kept server-only. Never use a NEXT_PUBLIC_ prefix for secrets.
  GEMINI_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  GEMINI_AUDIT_MODEL: z.preprocess(emptyToUndefined, z.string().min(1).default("gemini-3.5-flash")),

  // Supabase browser configuration is public by design; the service-role key is not.
  NEXT_PUBLIC_SUPABASE_URL: z.url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  RUNTIME_TRACE_TIMEOUT_MS: positiveInteger.default(240_000),
  STATIC_AGENT_TIMEOUT_MS: positiveInteger.default(480_000),
  REPO_BUILD_TIMEOUT_MS: positiveInteger.default(90_000),
  ALLOW_USER_URL_MODE: booleanString.default(true),
  DEMO_STOREFRONT_PORT: positiveInteger.default(3100),
  PLAYWRIGHT_BUNDLED_CHROMIUM_PATH: z.string().min(1).optional(),

  // Verascope runs sandboxed agent work through Vercel, never on the app host.
  SANDBOX_PROVIDER: z.literal("vercel").default("vercel"),
  VERCEL_PROJECT_ID: z.string().min(1).optional(),
  VERCEL_TEAM_ID: z.string().min(1).optional(),
  VERCEL_TOKEN: z.string().min(1).optional(),
  // Named, persistent runtime sandbox. The name is safe to expose but must be
  // unique within the configured Vercel project.
  VERCEL_RUNTIME_SANDBOX_NAME: z.preprocess(emptyToUndefined, z.string().min(1).default("verascope-runtime-v1")),
});

export type ServerEnvironment = z.infer<typeof ServerEnvironmentSchema>;

/** Parse environment lazily so build tooling does not require deployment secrets. */
export function getServerEnvironment(source: EnvironmentSource = process.env): ServerEnvironment {
  return ServerEnvironmentSchema.parse(source);
}

export function getGeminiAuditEnvironment(source: EnvironmentSource = process.env) {
  const environment = getServerEnvironment(source);
  if (!environment.GEMINI_API_KEY) throw new Error("gemini_api_key_missing");
  return { apiKey: environment.GEMINI_API_KEY, model: environment.GEMINI_AUDIT_MODEL };
}

export function isUserUrlModeEnabled(source: EnvironmentSource = process.env) {
  return getServerEnvironment(source).ALLOW_USER_URL_MODE;
}

export function getVercelSandboxEnvironment(source: EnvironmentSource = process.env) {
  const environment = getServerEnvironment(source);
  if (!environment.VERCEL_PROJECT_ID || !environment.VERCEL_TEAM_ID || !environment.VERCEL_TOKEN) {
    throw new Error("vercel_sandbox_credentials_missing");
  }
  return {
    projectId: environment.VERCEL_PROJECT_ID,
    teamId: environment.VERCEL_TEAM_ID,
    token: environment.VERCEL_TOKEN,
    timeoutMs: environment.STATIC_AGENT_TIMEOUT_MS,
  };
}

/**
 * Only these non-secret OS values reach submitted repository processes.
 * Gemini, Supabase, Vercel, and application variables never do.
 */
const TARGET_PROCESS_ENV_KEYS = ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TMP", "TEMP", "HOME"] as const;

export function createTargetProcessEnvironment(
  source: EnvironmentSource = process.env,
  overrides: EnvironmentSource = {},
): NodeJS.ProcessEnv {
  const environment: EnvironmentSource = { CI: "1" };
  for (const key of TARGET_PROCESS_ENV_KEYS) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  return { ...environment, ...overrides } as NodeJS.ProcessEnv;
}

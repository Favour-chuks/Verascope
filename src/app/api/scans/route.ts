import { NextResponse } from "next/server";
import { z } from "zod";
import { checkExternalUrl } from "@/lib/sandbox/target-safety/ssrf-guard";
import { isUserUrlModeEnabled } from "@/lib/config/env";
import { getApplicationScanStore } from "@/lib/scans/scan-store";
import { runDemoRuntimeOnly, runStaticStages } from "@/lib/agents/orchestrator";
import { repoSlugFromUrl } from "@/lib/agents/static-agents";

const RuntimeTargetSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("demo_app") }),
  z.object({ mode: z.literal("repo_build"), buildCommand: z.string().trim().min(1).optional(), startCommand: z.string().trim().min(1).optional() }).superRefine((value, context) => {
    if (Boolean(value.buildCommand) !== Boolean(value.startCommand)) context.addIssue({ code: "custom", message: "buildCommand and startCommand must be provided together." });
  }),
  z.object({ mode: z.literal("user_url"), targetUrl: z.string().min(1), consentAttestation: z.literal(true) }),
]);

const StartScanEnvelopeSchema = z.object({ repoUrl: z.string().min(1), runtimeTarget: z.unknown() });

type StartScanInput = { repoUrl: string; runtimeTarget: z.infer<typeof RuntimeTargetSchema> };
type StartScanValidation =
  | { ok: true; value: StartScanInput }
  | { ok: false; code: "invalid_repo_url" | "invalid_runtime_target" | "consent_not_attested"; message: string };

export function validateStartScanInput(input: unknown): StartScanValidation {
  const envelope = StartScanEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return { ok: false, code: "invalid_repo_url", message: "repoUrl must be an HTTPS github.com owner/repo URL." };
  }
  try {
    repoSlugFromUrl(envelope.data.repoUrl);
  } catch {
    return { ok: false, code: "invalid_repo_url", message: "repoUrl must be an HTTPS github.com owner/repo URL." };
  }

  const rawTarget = envelope.data.runtimeTarget;
  if (rawTarget && typeof rawTarget === "object" && !Array.isArray(rawTarget)
    && "mode" in rawTarget && rawTarget.mode === "user_url"
    && (!("consentAttestation" in rawTarget) || rawTarget.consentAttestation !== true)) {
    return { ok: false, code: "consent_not_attested", message: "user_url mode requires consentAttestation: true." };
  }
  const runtimeTarget = RuntimeTargetSchema.safeParse(rawTarget);
  if (!runtimeTarget.success) {
    return { ok: false, code: "invalid_runtime_target", message: "runtimeTarget is malformed for the selected mode." };
  }
  return { ok: true, value: { repoUrl: envelope.data.repoUrl, runtimeTarget: runtimeTarget.data } };
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: { code: "invalid_repo_url", message: "repoUrl must be an HTTPS github.com owner/repo URL." } }, { status: 400 });
  }
  const validation = validateStartScanInput(payload);
  if (!validation.ok) {
    return NextResponse.json({ error: { code: validation.code, message: validation.message } }, { status: 400 });
  }
  const input = validation.value;

  if (input.runtimeTarget.mode === "user_url") {
    if (!isUserUrlModeEnabled()) {
      return NextResponse.json({ error: { code: "invalid_runtime_target", message: "user_url mode is disabled for this environment." } }, { status: 400 });
    }
    try {
      await checkExternalUrl(input.runtimeTarget.targetUrl);
    } catch {
      return NextResponse.json({ error: { code: "unsafe_target_url", message: "targetUrl resolves to a non-public address and cannot be scanned." } }, { status: 400 });
    }
  }

  const store = getApplicationScanStore();
  const scan = await store.createScan(input.repoUrl, input.runtimeTarget);
  // Return the specified queued acknowledgement before the asynchronous work
  // can transition state (including a fail-closed missing-model failure).
  queueMicrotask(() => {
    if (input.runtimeTarget.mode === "demo_app") {
      void runDemoRuntimeOnly(scan.id, { store });
      return;
    }
    void runStaticStages(scan.id, { store });
  });
  return NextResponse.json({ id: scan.id, status: scan.status }, { status: 201 });
}

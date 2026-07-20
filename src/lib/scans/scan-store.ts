import { appendScanEvent, createScan, getScan, type ScanRecord, updateScan } from "@/lib/scans/memory-store";
import { getServerEnvironment } from "@/lib/config/env";
import type { RuntimeTarget } from "@/lib/domain";
import type { Finding } from "@/lib/schemas/findings";
import type { RuntimeCoverage } from "@/lib/runtime/types";


export type ScanPatch = Partial<Pick<ScanRecord, "status" | "currentStageDetail" | "findings" | "notAssessed" | "completedAt" | "runtimeCoverage">>;

export type ScanStore = {
  createScan(repoUrl: string, runtimeTarget: RuntimeTarget): Promise<ScanRecord>;
  getScan(id: string): Promise<ScanRecord | null>;
  updateScan(id: string, patch: ScanPatch): Promise<ScanRecord>;
  appendScanEvent(id: string, message: string): Promise<void>;
};

export const memoryScanStore: ScanStore = {
  async createScan(repoUrl, runtimeTarget) { return createScan(repoUrl, runtimeTarget); },
  async getScan(id) { return getScan(id); },
  async updateScan(id, patch) { return updateScan(id, patch); },
  async appendScanEvent(id, message) { appendScanEvent(id, message); },
};

type SupabaseRow = Record<string, unknown>;

function asString(value: unknown) { return typeof value === "string" ? value : null; }
function asStrings(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

class SupabaseScanStore implements ScanStore {
  constructor(private readonly baseUrl: string, private readonly serviceRoleKey: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(`/rest/v1/${path}`, this.baseUrl), {
      ...init,
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`supabase_scan_store_${response.status}`);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return text ? JSON.parse(text) as T : undefined as T;
  }

  private scanTarget(row: SupabaseRow): RuntimeTarget {
    const mode = row.target_mode;
    if (mode === "repo_build") {
      const buildCommand = asString(row.build_command);
      const startCommand = asString(row.start_command);
      return { mode, ...(buildCommand && startCommand ? { buildCommand, startCommand } : {}) };
    }
    if (mode === "user_url") return { mode, targetUrl: asString(row.runtime_target_url) ?? "", consentAttestation: true };
    return { mode: "demo_app" };
  }

  private finding(row: SupabaseRow): Finding {
    const type = row.citation_type;
    const citation = type === "file"
      ? { type, filePath: asString(row.citation_file_path) ?? "", ...(typeof row.citation_line_start === "number" ? { lineStart: row.citation_line_start } : {}), ...(typeof row.citation_line_end === "number" ? { lineEnd: row.citation_line_end } : {}) }
      : type === "command"
        ? { type, command: asString(row.citation_command) ?? "", output: asString(row.citation_command_output) ?? "" }
        : { type: "network_trace" as const, host: asString(row.citation_network_host) ?? "", method: asString(row.citation_network_method) ?? "", check: row.citation_network_check as Finding["citation"] extends { check: infer C } ? C : never, flow: asString(row.citation_network_flow) ?? "", timingMs: typeof row.citation_network_timing_ms === "number" ? row.citation_network_timing_ms : null, payloadSummary: asString(row.citation_network_payload_summary) ?? "" };
    return {
      category: row.category as Finding["category"], severity: row.severity as Finding["severity"], claim: asString(row.claim) ?? "",
      ...(asString(row.why_it_matters) ? { whyItMatters: asString(row.why_it_matters)! } : {}), citation,
      ...(asString(row.disclosed_claim) ? { disclosedClaim: asString(row.disclosed_claim) } : {}),
      ...(asString(row.disclosed_claim_location) ? { disclosedClaimLocation: asString(row.disclosed_claim_location) } : {}),
      ...(asString(row.outcome) ? { outcome: row.outcome as Finding["outcome"] } : {}), confidence: row.confidence as Finding["confidence"],
    } as Finding;
  }

  private findingRow(scanId: string, finding: Finding) {
    const citation = finding.citation;
    return {
      scan_id: scanId, category: finding.category, severity: finding.severity, claim: finding.claim, why_it_matters: finding.whyItMatters ?? null,
      citation_type: citation.type,
      citation_file_path: citation.type === "file" ? citation.filePath : null,
      citation_line_start: citation.type === "file" ? citation.lineStart ?? null : null,
      citation_line_end: citation.type === "file" ? citation.lineEnd ?? null : null,
      citation_command: citation.type === "command" ? citation.command : null,
      citation_command_output: citation.type === "command" ? citation.output : null,
      citation_network_host: citation.type === "network_trace" ? citation.host : null,
      citation_network_method: citation.type === "network_trace" ? citation.method : null,
      citation_network_check: citation.type === "network_trace" ? citation.check : null,
      citation_network_flow: citation.type === "network_trace" ? citation.flow : null,
      citation_network_timing_ms: citation.type === "network_trace" ? citation.timingMs : null,
      citation_network_payload_summary: citation.type === "network_trace" ? citation.payloadSummary : null,
      disclosed_claim: finding.disclosedClaim ?? null, disclosed_claim_location: finding.disclosedClaimLocation ?? null,
      outcome: finding.outcome ?? null, confidence: finding.confidence,
    };
  }

  private coverageRow(scanId: string, coverage: RuntimeCoverage) {
    return {
      scan_id: scanId, target_mode: coverage.targetMode, target_skipped_reason: coverage.targetSkippedReason,
      flows_tested: coverage.flowsTested, cname_check_performed: coverage.cnameCheckPerformed,
      stealth_posture: coverage.stealthPosture, fingerprint_parity_score: coverage.fingerprintParityScore,
      consent_attested: coverage.consentAttested, limitations_note: coverage.limitationsNote,
    };
  }

  async createScan(repoUrl: string, runtimeTarget: RuntimeTarget) {
    const now = new Date().toISOString();
    const body = {
      repo_url: repoUrl, target_mode: runtimeTarget.mode,
      runtime_target_url: runtimeTarget.mode === "user_url" ? runtimeTarget.targetUrl : null,
      consent_attestation_at: runtimeTarget.mode === "user_url" ? now : null,
      build_command: runtimeTarget.mode === "repo_build" ? runtimeTarget.buildCommand ?? null : null,
      start_command: runtimeTarget.mode === "repo_build" ? runtimeTarget.startCommand ?? null : null,
      not_assessed: [],
    };
    const rows = await this.request<SupabaseRow[]>("scans", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
    const id = asString(rows[0]?.id);
    if (!id) throw new Error("supabase_scan_store_create_failed");
    await this.appendScanEvent(id, "Scan queued.");
    const scan = await this.getScan(id);
    if (!scan) throw new Error("supabase_scan_store_create_failed");
    return scan;
  }

  async getScan(id: string) {
    const scanRows = await this.request<SupabaseRow[]>(`scans?id=eq.${encodeURIComponent(id)}&select=*`);
    const row = scanRows[0];
    if (!row) return null;
    const [findingRows, eventRows, coverageRows] = await Promise.all([
      this.request<SupabaseRow[]>(`findings?scan_id=eq.${encodeURIComponent(id)}&select=*&order=created_at.asc`),
      this.request<SupabaseRow[]>(`scan_events?scan_id=eq.${encodeURIComponent(id)}&select=*&order=created_at.asc`),
      this.request<SupabaseRow[]>(`runtime_coverage?scan_id=eq.${encodeURIComponent(id)}&select=*`),
    ]);
    const coverage = coverageRows[0] ? {
      targetMode: coverageRows[0].target_mode, targetSkippedReason: asString(coverageRows[0].target_skipped_reason), flowsTested: asStrings(coverageRows[0].flows_tested),
      cnameCheckPerformed: coverageRows[0].cname_check_performed === true, stealthPosture: "none" as const,
      fingerprintParityScore: asString(coverageRows[0].fingerprint_parity_score), consentAttested: coverageRows[0].consent_attested === true,
      consentAttestedAt: asString(row.consent_attestation_at), limitationsNote: asString(coverageRows[0].limitations_note) ?? "",
    } as RuntimeCoverage : null;
    return {
      id, repoUrl: asString(row.repo_url) ?? "", runtimeTarget: this.scanTarget(row), consentAttestedAt: asString(row.consent_attestation_at),
      status: row.status as ScanRecord["status"], currentStageDetail: asString(row.current_stage_detail), findings: findingRows.map((finding) => this.finding(finding)),
      notAssessed: asStrings(row.not_assessed), events: eventRows.map((event) => ({ id: asString(event.id) ?? "", message: asString(event.message) ?? "", createdAt: asString(event.created_at) ?? "" })),
      createdAt: asString(row.created_at) ?? "", completedAt: asString(row.completed_at), runtimeCoverage: coverage,
    } satisfies ScanRecord;
  }

  async updateScan(id: string, patch: ScanPatch) {
    const scanPatch: Record<string, unknown> = {};
    if (patch.status !== undefined) scanPatch.status = patch.status;
    if (patch.currentStageDetail !== undefined) scanPatch.current_stage_detail = patch.currentStageDetail;
    if (patch.notAssessed !== undefined) scanPatch.not_assessed = patch.notAssessed;
    if (patch.completedAt !== undefined) scanPatch.completed_at = patch.completedAt;
    if (Object.keys(scanPatch).length) await this.request(`scans?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(scanPatch) });
    if (patch.findings !== undefined) {
      await this.request(`findings?scan_id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      if (patch.findings.length) await this.request("findings", { method: "POST", body: JSON.stringify(patch.findings.map((finding) => this.findingRow(id, finding))) });
    }
    if (patch.runtimeCoverage !== undefined && patch.runtimeCoverage !== null) {
      await this.request("runtime_coverage?on_conflict=scan_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(this.coverageRow(id, patch.runtimeCoverage)) });
    }
    const scan = await this.getScan(id);
    if (!scan) throw new Error("scan_not_found");
    return scan;
  }

  async appendScanEvent(id: string, message: string) {
    await this.request("scan_events", { method: "POST", body: JSON.stringify({ scan_id: id, message }) });
  }
}

let applicationStore: ScanStore | undefined;

/** Uses the service-role key only on the server. Development and unit contracts retain the isolated in-memory store. */
export function getApplicationScanStore(): ScanStore {
  if (applicationStore) return applicationStore;
  const environment = getServerEnvironment();
  if (environment.NEXT_PUBLIC_SUPABASE_URL && environment.SUPABASE_SERVICE_ROLE_KEY) {
    applicationStore = new SupabaseScanStore(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY);
    return applicationStore;
  }
  if (process.env.NODE_ENV === "production") throw new Error("supabase_scan_store_configuration_missing");
  applicationStore = memoryScanStore;
  return applicationStore;
}

import { randomUUID } from "node:crypto";
import type { RuntimeTarget, ScanStatus } from "@/lib/domain";
import type { Finding } from "@/lib/schemas/findings";
import type { RuntimeCoverage } from "@/lib/runtime/types";

export type ScanEvent = { id: string; message: string; createdAt: string };
export type ScanRecord = {
  id: string;
  repoUrl: string;
  runtimeTarget: RuntimeTarget;
  consentAttestedAt: string | null;
  status: ScanStatus;
  currentStageDetail: string | null;
  findings: Finding[];
  notAssessed: string[];
  events: ScanEvent[];
  createdAt: string;
  completedAt: string | null;
  runtimeCoverage: RuntimeCoverage | null;
};

const scans = new Map<string, ScanRecord>();

export function createScan(repoUrl: string, runtimeTarget: RuntimeTarget) {
  const now = new Date().toISOString();
  const record: ScanRecord = {
    id: randomUUID(), repoUrl, runtimeTarget, consentAttestedAt: runtimeTarget.mode === "user_url" ? now : null, status: "queued", currentStageDetail: null,
    findings: [], notAssessed: [], events: [], createdAt: now, completedAt: null, runtimeCoverage: null,
  };
  scans.set(record.id, record);
  appendScanEvent(record.id, "Scan queued.");
  return record;
}

export function getScan(id: string) { return scans.get(id) ?? null; }

export function updateScan(id: string, patch: Partial<Pick<ScanRecord, "status" | "currentStageDetail" | "findings" | "notAssessed" | "completedAt" | "runtimeCoverage">>) {
  const scan = getScan(id);
  if (!scan) throw new Error("scan_not_found");
  Object.assign(scan, patch);
  return scan;
}

export function appendScanEvent(id: string, message: string) {
  const scan = getScan(id);
  if (!scan) throw new Error("scan_not_found");
  scan.events.push({ id: randomUUID(), message, createdAt: new Date().toISOString() });
}

import type { ScanStatus, TargetMode } from "@/lib/domain";

export interface ScanRow {
  id: string;
  repo_url: string;
  status: ScanStatus;
  current_stage_detail: string | null;
  target_mode: TargetMode;
  runtime_target_url: string | null;
  consent_attestation_at: string | null;
  build_command: string | null;
  start_command: string | null;
  not_assessed: string[];
  created_at: string;
  completed_at: string | null;
}

export interface RuntimeCoverageRow {
  scan_id: string;
  target_mode: TargetMode;
  target_skipped_reason: string | null;
  flows_tested: string[];
  cname_check_performed: boolean;
  stealth_posture: "none";
  fingerprint_parity_score: string | null;
  consent_attested: boolean;
  limitations_note: string;
}

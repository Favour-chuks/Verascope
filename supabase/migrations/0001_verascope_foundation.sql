create extension if not exists pgcrypto;

create table public.scans (
  id uuid primary key default gen_random_uuid(),
  repo_url text not null,
  status text not null default 'queued' check (status in (
    'queued', 'running_code_health', 'running_security',
    'running_runtime_behavior', 'synthesizing', 'complete', 'failed'
  )),
  current_stage_detail text,
  target_mode text not null default 'demo_app' check (target_mode in ('demo_app', 'repo_build', 'user_url')),
  runtime_target_url text,
  consent_attestation_at timestamptz,
  build_command text,
  start_command text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint scans_repo_build_commands_pair check (
    (build_command is null and start_command is null)
    or (length(trim(coalesce(build_command, ''))) > 0 and length(trim(coalesce(start_command, ''))) > 0)
  ),
  constraint scans_user_url_shape check (
    (target_mode <> 'user_url' and runtime_target_url is null and consent_attestation_at is null)
    or (target_mode = 'user_url' and length(trim(coalesce(runtime_target_url, ''))) > 0 and consent_attestation_at is not null)
  )
);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans(id) on delete cascade,
  category text not null check (category in ('code_quality', 'security', 'licensing', 'ai_exposure', 'runtime_disclosure', 'team_risk')),
  severity text not null check (severity in ('critical', 'notable', 'minor')),
  claim text not null,
  why_it_matters text,
  citation_type text not null check (citation_type in ('file', 'command', 'network_trace')),
  citation_file_path text,
  citation_line_start integer,
  citation_line_end integer,
  citation_command text,
  citation_command_output text,
  citation_network_host text,
  citation_network_method text,
  citation_network_check text check (citation_network_check is null or citation_network_check in (
    'attribution_override', 'unscripted', 'pre_interaction', 'consent_declined', 'consent_accepted', 'cname'
  )),
  citation_network_flow text,
  citation_network_timing_ms integer,
  citation_network_payload_summary text,
  disclosed_claim text,
  disclosed_claim_location text,
  outcome text check (outcome is null or outcome in ('conforms', 'undisclosed', 'contradicted')),
  confidence text not null default 'verified' check (confidence in ('verified', 'heuristic')),
  created_at timestamptz not null default now(),
  constraint findings_citation_shape check (
    (citation_type = 'file' and citation_file_path is not null)
    or (citation_type = 'command' and citation_command is not null and citation_command_output is not null)
    or (citation_type = 'network_trace' and citation_network_host is not null and citation_network_method is not null and citation_network_check is not null and citation_network_flow is not null)
  )
);

create table public.scan_events (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

create table public.runtime_coverage (
  scan_id uuid primary key references public.scans(id) on delete cascade,
  target_mode text not null check (target_mode in ('demo_app', 'repo_build', 'user_url')),
  target_skipped_reason text,
  flows_tested text[] not null,
  cname_check_performed boolean not null,
  stealth_posture text not null check (stealth_posture = 'none'), -- timeline scope: no browser-hardening distinction in v3 delivery
  fingerprint_parity_score text,
  consent_attested boolean not null default false,
  limitations_note text not null check (length(trim(limitations_note)) > 0)
);

create index scans_status_created_at_idx on public.scans (status, created_at desc);
create index findings_scan_id_idx on public.findings (scan_id);
create index findings_scan_severity_idx on public.findings (scan_id, severity);
create index scan_events_scan_created_at_idx on public.scan_events (scan_id, created_at);

alter table public.scans enable row level security;
alter table public.findings enable row level security;
alter table public.scan_events enable row level security;
alter table public.runtime_coverage enable row level security;

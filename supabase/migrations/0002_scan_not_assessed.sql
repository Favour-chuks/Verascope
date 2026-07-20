alter table public.scans
  add column if not exists not_assessed text[] not null default '{}';

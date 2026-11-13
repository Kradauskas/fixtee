-- AutoFix initial schema: projects, errors, fixes, webhook_deliveries.
-- Reads: logged-in users see their own projects and the errors/fixes under them.
-- Writes: service role only (server side). RLS is enabled explicitly on every table.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.fix_status as enum (
  'queued',
  'analyzing',
  'test_pushed',
  'test_failed',
  'fix_pushed',
  'verified',
  'failed'
);

create type public.llm_provider as enum ('anthropic', 'openai');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.projects (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  repo_owner        text not null,
  repo_name         text not null,
  installation_id   bigint not null,
  default_branch    text not null,
  llm_provider      public.llm_provider,
  llm_key_secret_id uuid,          -- vault.secrets id; never the raw key
  db_schema_paths   text[] not null default '{}',
  created_at        timestamptz not null default now(),
  constraint projects_installation_repo_key unique (installation_id, repo_owner, repo_name)
);

create table public.errors (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  fingerprint     text not null,
  test_name       text,
  error_type      text,
  error_message   text,
  log_excerpt     text,
  file_path       text,
  line            integer,
  commit_sha      text not null,
  workflow_run_id bigint not null,
  run_url         text not null,
  parsed          boolean not null default false,
  occurrences     integer not null default 1,
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now(),
  constraint errors_project_fingerprint_key unique (project_id, fingerprint)
);

create table public.fixes (
  id              uuid primary key default gen_random_uuid(),
  error_id        uuid not null references public.errors (id) on delete cascade,
  status          public.fix_status not null default 'queued',
  branch_name     text,
  pr_number       integer,
  pr_url          text,
  test_commit_sha text,
  fix_commit_sha  text,
  red_run_url     text,
  green_run_url   text,
  ai_reasoning    text,
  confidence      numeric,
  tokens_used     integer,
  planned_changes jsonb,           -- Role 2: array of { path, search, replace }
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.webhook_deliveries (
  delivery_id text primary key,
  event       text not null,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- (errors.project_id is covered by the leading column of errors_project_fingerprint_key)
-- ---------------------------------------------------------------------------

create index projects_user_id_idx  on public.projects (user_id);
create index errors_fingerprint_idx on public.errors (fingerprint);
create index fixes_error_id_idx     on public.fixes (error_id);
create index fixes_status_idx       on public.fixes (status);

-- ---------------------------------------------------------------------------
-- fixes.updated_at trigger
-- ---------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger fixes_set_updated_at
  before update on public.fixes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Privileges + Row Level Security
-- Supabase's default privileges grant ALL on new tables to anon/authenticated
-- (including TRUNCATE, which RLS does not cover), so reset them explicitly.
-- ---------------------------------------------------------------------------

revoke all on public.projects, public.errors, public.fixes, public.webhook_deliveries
  from anon, authenticated;
grant select on public.projects, public.errors, public.fixes to authenticated;
grant all on public.projects, public.errors, public.fixes, public.webhook_deliveries
  to service_role;

alter table public.projects           enable row level security;
alter table public.errors             enable row level security;
alter table public.fixes              enable row level security;
alter table public.webhook_deliveries enable row level security;  -- no policies: service role only

create policy "Users read own projects"
  on public.projects for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "Users read errors of own projects"
  on public.errors for select
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      where p.id = errors.project_id
        and p.user_id = (select auth.uid())
    )
  );

create policy "Users read fixes of own projects"
  on public.fixes for select
  to authenticated
  using (
    exists (
      select 1
      from public.errors e
      join public.projects p on p.id = e.project_id
      where e.id = fixes.error_id
        and p.user_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- Realtime (dashboard subscribes; delivery respects the RLS policies above)
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.errors, public.fixes;

-- ---------------------------------------------------------------------------
-- LLM key storage in Vault (service role only)
-- ---------------------------------------------------------------------------

create function public.set_project_llm_key(p_project_id uuid, p_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if p_key is null or length(p_key) = 0 then
    raise exception 'key must not be empty';
  end if;

  select llm_key_secret_id into v_secret_id
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'project % not found', p_project_id;
  end if;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(
      p_key,
      'project_llm_key_' || p_project_id::text,
      'LLM API key for project ' || p_project_id::text
    );
    update public.projects
      set llm_key_secret_id = v_secret_id
      where id = p_project_id;
  else
    perform vault.update_secret(v_secret_id, p_key);
  end if;

  return v_secret_id;
end;
$$;

create function public.get_project_llm_key(p_project_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  select s.decrypted_secret into v_key
  from public.projects p
  join vault.decrypted_secrets s on s.id = p.llm_key_secret_id
  where p.id = p_project_id;

  return v_key;  -- null when the project has no key
end;
$$;

-- Supabase grants EXECUTE on new public functions to anon/authenticated by default.
revoke all on function public.set_project_llm_key(uuid, text) from public, anon, authenticated;
revoke all on function public.get_project_llm_key(uuid)       from public, anon, authenticated;
grant execute on function public.set_project_llm_key(uuid, text) to service_role;
grant execute on function public.get_project_llm_key(uuid)       to service_role;

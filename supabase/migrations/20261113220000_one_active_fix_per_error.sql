-- At most one fix in progress per error. Two identical CI failures arriving at the same time
-- could otherwise both queue a fix and start the agent twice. Ingest (lib/ingest/record-error.ts)
-- treats a unique violation on insert as "a fix is already running" and does not start the agent.
-- Keep the status list in sync with ACTIVE_FIX_STATUSES in lib/ingest/record-error.ts.
create unique index fixes_one_active_per_error
  on public.fixes (error_id)
  where status in ('queued', 'analyzing', 'test_pushed', 'test_failed', 'fix_pushed');

-- 01_core_collaborative.sql
-- Core schema for SHARED_SYNC + COLLABORATIVE (members can write within space)

create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

create index if not exists memberships_user_id_idx on public.memberships(user_id);
create index if not exists memberships_space_id_idx on public.memberships(space_id);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null,
  type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notifications_space_id_idx on public.notifications(space_id);
create index if not exists notifications_user_id_idx on public.notifications(user_id);
create index if not exists notifications_read_at_idx on public.notifications(read_at);

drop trigger if exists set_notifications_updated_at on public.notifications;
create trigger set_notifications_updated_at
before update on public.notifications
for each row execute function public.set_updated_at();

alter table public.spaces enable row level security;
alter table public.memberships enable row level security;
alter table public.notifications enable row level security;

-- Membership lookups via SECURITY DEFINER helpers. A policy ON memberships that
-- does `select ... from memberships` triggers the memberships policy again →
-- "infinite recursion detected in policy for relation memberships". These helpers
-- run with definer rights (RLS bypassed inside the function), breaking the cycle.
-- They still scope to the caller: `user_id = auth.uid()`. search_path is pinned.
create or replace function public.is_space_member(p_space_id uuid)
returns boolean
language sql
security definer  -- Discipline Loop:ALLOW_SECURITY_DEFINER (breaks RLS recursion on memberships)
set search_path = public
stable
as $$
  select exists (
    select 1 from public.memberships
    where space_id = p_space_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_space_owner(p_space_id uuid)
returns boolean
language sql
security definer  -- Discipline Loop:ALLOW_SECURITY_DEFINER (breaks RLS recursion on memberships)
set search_path = public
stable
as $$
  select exists (
    select 1 from public.memberships
    where space_id = p_space_id and user_id = auth.uid() and role = 'owner'
  );
$$;

-- SPACES
drop policy if exists spaces_select_member on public.spaces;
create policy spaces_select_member
on public.spaces for select
to authenticated
using (created_by = auth.uid() or public.is_space_member(id));

drop policy if exists spaces_insert_owner on public.spaces;
create policy spaces_insert_owner
on public.spaces for insert
to authenticated
with check (created_by = auth.uid());

drop policy if exists spaces_update_owner on public.spaces;
create policy spaces_update_owner
on public.spaces for update
to authenticated
using (created_by = auth.uid() or public.is_space_owner(id))
with check (created_by = auth.uid() or public.is_space_owner(id));

drop policy if exists spaces_delete_owner on public.spaces;
create policy spaces_delete_owner
on public.spaces for delete
to authenticated
using (created_by = auth.uid() or public.is_space_owner(id));

-- MEMBERSHIPS (owner manages invites; bootstrap allowed)
drop policy if exists memberships_select_member on public.memberships;
create policy memberships_select_member
on public.memberships for select
to authenticated
using (public.is_space_member(space_id));

drop policy if exists memberships_insert_owner on public.memberships;
create policy memberships_insert_owner
on public.memberships for insert
to authenticated
with check (
  (
    memberships.user_id = auth.uid()
    and memberships.role = 'owner'
    and exists (
      select 1 from public.spaces s
      where s.id = memberships.space_id and s.created_by = auth.uid()
    )
  )
  or public.is_space_owner(memberships.space_id)
);

drop policy if exists memberships_update_owner on public.memberships;
create policy memberships_update_owner
on public.memberships for update
to authenticated
using (public.is_space_owner(space_id))
with check (public.is_space_owner(space_id));

drop policy if exists memberships_delete_owner on public.memberships;
create policy memberships_delete_owner
on public.memberships for delete
to authenticated
using (public.is_space_owner(space_id));

-- NOTIFICATIONS
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own
on public.notifications for select
to authenticated
using (notifications.user_id = auth.uid() and public.is_space_member(notifications.space_id));

drop policy if exists notifications_update_own_read on public.notifications;
create policy notifications_update_own_read
on public.notifications for update
to authenticated
using (notifications.user_id = auth.uid() and public.is_space_member(notifications.space_id))
with check (notifications.user_id = auth.uid() and public.is_space_member(notifications.space_id));

drop policy if exists notifications_insert_owner on public.notifications;
create policy notifications_insert_owner
on public.notifications for insert
to authenticated
with check (public.is_space_owner(notifications.space_id));

drop policy if exists notifications_delete_owner on public.notifications;
create policy notifications_delete_owner
on public.notifications for delete
to authenticated
using (public.is_space_owner(notifications.space_id));

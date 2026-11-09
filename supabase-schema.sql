-- Supabase schema for SchoolFinder ICT owner portal
-- Use this in the Supabase SQL editor after creating a project.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null unique,
  phone text,
  school_name text,
  district text,
  school_type text,
  role text not null default 'school_owner',
  position text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create or replace function public.is_schoolfinder_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

create or replace function public.create_schoolfinder_profile()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.profiles (id, full_name, email, phone, school_name, district, school_type, role, position)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.email,
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'school_name',
    new.raw_user_meta_data->>'district',
    new.raw_user_meta_data->>'school_type',
    'school_owner',
    new.raw_user_meta_data->>'position'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_schoolfinder on auth.users;
create trigger on_auth_user_created_schoolfinder
after insert on auth.users
for each row execute function public.create_schoolfinder_profile();

insert into public.profiles (id, full_name, email, phone, school_name, district, school_type, role, position)
select
  users.id,
  coalesce(users.raw_user_meta_data->>'full_name', ''),
  users.email,
  users.raw_user_meta_data->>'phone',
  users.raw_user_meta_data->>'school_name',
  users.raw_user_meta_data->>'district',
  users.raw_user_meta_data->>'school_type',
  'school_owner',
  users.raw_user_meta_data->>'position'
from auth.users users
on conflict (id) do nothing;

create or replace function public.prevent_profile_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
    and current_user not in ('postgres', 'service_role')
    and not public.is_schoolfinder_admin() then
    raise exception 'Only a platform administrator may change account roles';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_role_protection on public.profiles;
create trigger profiles_role_protection
before update of role on public.profiles
for each row execute function public.prevent_profile_role_escalation();

drop policy if exists "profiles_owner_update" on public.profiles;
drop policy if exists "profiles_owner_read" on public.profiles;
drop policy if exists "profiles_admin_read" on public.profiles;

create policy "profiles_owner_read"
on public.profiles for select
using (auth.uid() = id);

create policy "profiles_admin_read"
on public.profiles for select
using (public.is_schoolfinder_admin());

create table if not exists public.school_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  owner_email text,
  school_name text not null,
  logo_url text,
  description text,
  province text,
  district text,
  sector text,
  address text,
  school_type text default 'Private',
  education_levels text[] default array[]::text[],
  subject_combinations text[] default array[]::text[],
  boarding_arrangement text,
  tuition_fees text,
  period_covered text,
  facilities text[] default array[]::text[],
  phone text,
  email text,
  website text,
  admission_requirements text,
  transfer_requirements text,
  vacancies jsonb not null default '[]'::jsonb,
  verification_status text not null default 'draft' check (verification_status in ('draft', 'pending_verification', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.school_profiles enable row level security;

drop policy if exists "school_profiles_owner_manage" on public.school_profiles;
drop policy if exists "school_profiles_public_read_verified" on public.school_profiles;
drop policy if exists "school_profiles_admin_all" on public.school_profiles;

create policy "school_profiles_owner_manage"
on public.school_profiles for all
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create policy "school_profiles_public_read_verified"
on public.school_profiles for select
using (verification_status = 'approved');

create policy "school_profiles_admin_all"
on public.school_profiles for all
using (public.is_schoolfinder_admin())
with check (public.is_schoolfinder_admin());

create or replace function public.protect_school_verification_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_schoolfinder_admin() then
    if tg_op = 'INSERT' then
      if new.verification_status not in ('draft', 'pending_verification') then
        raise exception 'New school profiles must be drafts or pending verification';
      end if;
    elsif new.verification_status is distinct from old.verification_status then
      raise exception 'Only an administrator may change school verification status';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists school_verification_status_protection on public.school_profiles;
create trigger school_verification_status_protection
before insert or update of verification_status on public.school_profiles
for each row execute function public.protect_school_verification_status();

create table if not exists public.school_inquiries (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references public.school_profiles(id) on delete cascade,
  school_owner_id uuid references auth.users(id) on delete set null,
  parent_name text,
  email text,
  phone text,
  subject text,
  message text not null,
  status text not null default 'pending' check (status in ('pending', 'answered', 'closed')),
  reply_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.school_inquiries enable row level security;

drop policy if exists "inquiries_owner_read" on public.school_inquiries;
drop policy if exists "inquiries_owner_update" on public.school_inquiries;
drop policy if exists "inquiries_public_insert" on public.school_inquiries;
drop policy if exists "inquiries_admin_all" on public.school_inquiries;

create policy "inquiries_owner_read"
on public.school_inquiries for select
using (auth.uid() = school_owner_id);

create policy "inquiries_owner_update"
on public.school_inquiries for update
using (auth.uid() = school_owner_id)
with check (auth.uid() = school_owner_id);

create policy "inquiries_public_insert"
on public.school_inquiries for insert
with check (true);

create policy "inquiries_admin_all"
on public.school_inquiries for all
using (public.is_schoolfinder_admin())
with check (public.is_schoolfinder_admin());

create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
before update on public.profiles
for each row execute function public.update_updated_at();

drop trigger if exists school_profiles_updated_at on public.school_profiles;
create trigger school_profiles_updated_at
before update on public.school_profiles
for each row execute function public.update_updated_at();

drop trigger if exists school_inquiries_updated_at on public.school_inquiries;
create trigger school_inquiries_updated_at
before update on public.school_inquiries
for each row execute function public.update_updated_at();

-- Promote an existing account to administrator from the Supabase SQL editor only:
-- update public.profiles set role = 'admin' where email = 'admin@yourdomain.com';

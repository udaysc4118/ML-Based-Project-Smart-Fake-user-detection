-- Supabase setup SQL for RecomAI
-- Run this in Supabase SQL editor (replace project-specific settings if needed)

create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  username text not null,
  password_hash text not null,
  role text not null default 'user',
  created_at timestamptz default now()
);

create table if not exists public.otp_requests (
  email text primary key,
  code text not null,
  username text,
  password_hash text,
  action text not null,
  verified boolean not null default false,
  created_at timestamptz default now()
);

alter table public.app_users enable row level security;
alter table public.otp_requests enable row level security;

-- Allow anon (client) to read and write as needed for this demo
create policy "Allow anon read app_users"
on public.app_users
for select
to anon
using (true);

create policy "Allow anon write app_users"
on public.app_users
for insert
to anon
with check (true);

create policy "Allow anon update app_users"
on public.app_users
for update
to anon
using (true)
with check (true);

create policy "Allow anon delete app_users"
on public.app_users
for delete
to anon
using (true);

create policy "Allow anon read otp_requests"
on public.otp_requests
for select
to anon
using (true);

create policy "Allow anon write otp_requests"
on public.otp_requests
for insert
to anon
with check (true);

create policy "Allow anon update otp_requests"
on public.otp_requests
for update
to anon
using (true)
with check (true);

create policy "Allow anon delete otp_requests"
on public.otp_requests
for delete
to anon
using (true);

-- End of SQL

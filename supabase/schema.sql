-- Supabase Dashboard -> SQL Editor me ye ek baar run karo.
-- Broker tokens (Fyers/Kotak session) aur OI-baseline yahan save hote hain taaki
-- Render restart hone par dobara login na karna pade.

create table if not exists public.broker_sessions (
  broker     text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- RLS ON + koi policy nahi  => anon / logged-in users is table ko bilkul nahi padh sakte.
-- Sirf server ka service_role key (jo RLS bypass karta hai) isse access karta hai.
alter table public.broker_sessions enable row level security;
revoke all on public.broker_sessions from anon, authenticated;

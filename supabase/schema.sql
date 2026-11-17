-- Сайт «Еда» (Лиза и Олег): рецепты, база продуктов, меню недели, дневник.
-- Выполнить один раз: Supabase → SQL Editor → New query → вставить → Run.

create table if not exists public.products (
  id        text primary key,
  name      text not null,
  kcal      numeric, p numeric, f numeric, c numeric,   -- на 100 г
  cat       text,                                        -- раздел магазина / категория
  recipe_id text,                                        -- если КБЖУ берётся из рецепта («в 100 г» готового блюда)
  source    text,                                        -- таблица / вручную / этикетка / ИИ / Open Food Facts
  note      text,
  updated   timestamptz not null default now()
);

create table if not exists public.recipes (
  id       text primary key,
  meal     text not null,              -- breakfast / lunch / dinner / other
  title    text not null,
  url      text,
  items    jsonb not null default '[]', -- [{pid, name, g}]
  cooked   numeric,                    -- вес готового блюда (г) или число штук
  unit     text not null default 'g',  -- g | pcs
  portions jsonb not null default '{}',-- {"liza": 195, "oleg": 250}
  note     text,
  sort     int,
  updated  timestamptz not null default now()
);

create table if not exists public.diary (
  id      text primary key,
  person  text not null,               -- liza / oleg
  day     date not null,
  meal    text not null,               -- breakfast / lunch / dinner / snack
  title   text not null,
  amount  numeric,                     -- граммы или штуки
  unit    text not null default 'g',
  kcal numeric, p numeric, f numeric, c numeric,  -- снимок на момент записи
  src     text,                        -- recipe / product / label / ai / off / manual
  ref     text,
  created timestamptz not null default now()
);
create index if not exists diary_person_day on public.diary(person, day);

create table if not exists public.kv (
  key     text primary key,            -- plan, goals
  value   jsonb not null,
  updated timestamptz not null default now()
);

-- Сайт открыт без логина: читать и писать может любой, у кого есть адрес сайта.
do $$
declare t text;
begin
  foreach t in array array['products','recipes','diary','kv'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "open all" on public.%I', t);
    execute format('create policy "open all" on public.%I for all to anon using (true) with check (true)', t);
    execute format('grant select, insert, update, delete on public.%I to anon', t);
  end loop;
end $$;

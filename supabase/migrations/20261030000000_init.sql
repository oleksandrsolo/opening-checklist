-- =====================================================================
-- 23.Ресторани · Чеклист відкриття ресторану
-- Застосовується автоматично з GitHub Actions (supabase db push).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Ресторани ----------
create table if not exists restaurants (
  id         serial primary key,
  name       text not null unique,
  open_time  time not null default '10:00',   -- до цього часу чеклист має бути завершений
  active     boolean not null default true
);

insert into restaurants (name) values
  ('Manufactura'), ('FABBRICA'), ('DELIKACIA 100'), ('PromBar & Catering'),
  ('Foodoteka'), ('Delikacia Bakery'), ('Fabbrica Brooklin'), ('Мама - кухня')
on conflict (name) do nothing;

-- ---------- Працівники (реєструються через бота, активує адмін у панелі) ----------
create table if not exists staff (
  telegram_id    bigint primary key,
  username       text,
  full_name      text,
  restaurant_id  int references restaurants(id),
  active         boolean not null default false,
  created_at     timestamptz not null default now()
);

-- ---------- Пункти чеклиста ----------
-- answer_type: yes_no | number | text | photo (лише фото)
-- restaurant_id = null → пункт для всіх ресторанів
create table if not exists checklist_items (
  id              serial primary key,
  restaurant_id   int references restaurants(id),
  position        int not null default 100,
  section         text not null default 'Загальне',
  question        text not null,
  hint            text,
  answer_type     text not null check (answer_type in ('yes_no','number','text','photo')),
  photo_required  boolean not null default false,
  ok_min          numeric,      -- для number: допустимий діапазон, поза ним = проблема
  ok_max          numeric,
  active          boolean not null default true
);

-- ---------- Проходження чеклиста ----------
create table if not exists submissions (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  int not null references restaurants(id),
  telegram_id    bigint not null references staff(telegram_id),
  staff_name     text,
  status         text not null default 'in_progress'
                 check (status in ('in_progress','completed','abandoned')),
  current_index  int not null default 0,
  step           text not null default 'answer',   -- answer | comment | photo
  work_date      date not null default ((now() at time zone 'Europe/Kyiv')::date),
  started_at     timestamptz not null default now(),
  completed_at   timestamptz
);
create index if not exists submissions_user_status on submissions (telegram_id, status);
create index if not exists submissions_date on submissions (work_date, restaurant_id);

-- ---------- Відповіді ----------
create table if not exists answers (
  id             bigserial primary key,
  submission_id  uuid not null references submissions(id) on delete cascade,
  item_id        int not null references checklist_items(id),
  section        text,          -- знімок на момент відповіді
  question       text,
  value_bool     boolean,
  value_number   numeric,
  value_text     text,
  comment        text,
  photo_path     text,
  is_problem     boolean not null default false,
  answered_at    timestamptz not null default now(),
  unique (submission_id, item_id)
);
create index if not exists answers_problem on answers (is_problem) where is_problem;

-- ---------- Хто бачить панель звітів ----------
create table if not exists dashboard_admins (email text primary key);

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from dashboard_admins
                 where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

-- ---------- Зведення для звітів ----------
create or replace view v_submissions with (security_invoker = true) as
select s.id, s.restaurant_id, r.name as restaurant, s.telegram_id,
       coalesce(s.staff_name, st.full_name) as staff_name,
       s.status, s.work_date, s.started_at, s.completed_at, r.open_time,
       round(extract(epoch from (s.completed_at - s.started_at)) / 60.0, 1) as duration_min,
       case when s.completed_at is null then null
            else (s.completed_at at time zone 'Europe/Kyiv')::date > s.work_date
              or (s.completed_at at time zone 'Europe/Kyiv')::time > r.open_time end as is_late,
       (select count(*) from answers a where a.submission_id = s.id) as answers_cnt,
       (select count(*) from answers a where a.submission_id = s.id and a.is_problem) as problems_cnt,
       (select count(*) from answers a where a.submission_id = s.id and a.photo_path is not null) as photos_cnt
from submissions s
join restaurants r on r.id = s.restaurant_id
left join staff st on st.telegram_id = s.telegram_id;

-- ---------- Безпека: бот пише через service_role (обходить RLS), панель — лише адміни ----------
alter table restaurants      enable row level security;
alter table staff            enable row level security;
alter table checklist_items  enable row level security;
alter table submissions      enable row level security;
alter table answers          enable row level security;
alter table dashboard_admins enable row level security;

drop policy if exists admin_read_restaurants on restaurants;
create policy admin_read_restaurants on restaurants for select to authenticated using (is_admin());
drop policy if exists admin_edit_restaurants on restaurants;
create policy admin_edit_restaurants on restaurants for update to authenticated using (is_admin()) with check (is_admin());
drop policy if exists admin_read_staff on staff;
create policy admin_read_staff on staff for select to authenticated using (is_admin());
drop policy if exists admin_edit_staff on staff;
create policy admin_edit_staff on staff for update to authenticated using (is_admin()) with check (is_admin());
drop policy if exists admin_read_items on checklist_items;
create policy admin_read_items on checklist_items for select to authenticated using (is_admin());
drop policy if exists admin_add_items on checklist_items;
create policy admin_add_items on checklist_items for insert to authenticated with check (is_admin());
drop policy if exists admin_edit_items on checklist_items;
create policy admin_edit_items on checklist_items for update to authenticated using (is_admin()) with check (is_admin());
drop policy if exists admin_read_subs on submissions;
create policy admin_read_subs on submissions for select to authenticated using (is_admin());
drop policy if exists admin_read_answers on answers;
create policy admin_read_answers on answers for select to authenticated using (is_admin());
drop policy if exists admin_read_self on dashboard_admins;
create policy admin_read_self on dashboard_admins for select to authenticated using (is_admin());

-- ---------- Сховище фото (приватне) ----------
insert into storage.buckets (id, name, public)
values ('checklist-photos', 'checklist-photos', false)
on conflict (id) do nothing;

drop policy if exists admin_read_photos on storage.objects;
create policy admin_read_photos on storage.objects for select to authenticated
  using (bucket_id = 'checklist-photos' and public.is_admin());

-- ---------- Чеклист за замовчуванням (для всіх ресторанів; правиться в панелі) ----------
insert into checklist_items (position, section, question, hint, answer_type, photo_required, ok_min, ok_max)
select * from (values
  (10,  'Вхід і фасад', 'Вхідна група й тераса чисті, вивіска світиться?', 'Фото входу з вулиці', 'yes_no', true,  null::numeric, null::numeric),
  (20,  'Зал',          'Зал прибраний, столи сервіровані за стандартом?', 'Загальне фото залу', 'yes_no', true,  null, null),
  (30,  'Зал',          'Санвузли чисті, є мило, папір і рушники?',       null,                 'yes_no', true,  null, null),
  (40,  'Зал',          'Світло й музика в залі ввімкнені за стандартом?', null,                'yes_no', false, null, null),
  (50,  'Бар',          'Бар готовий: стійка чиста, є лід, нарізка, заготовки?', 'Фото барної стійки', 'yes_no', true, null, null),
  (60,  'Бар',          'Кавомашину промито й відкалібровано?',          null,                 'yes_no', false, null, null),
  (70,  'Кухня',        'Температура в холодильній камері, °C',          'Фото термометра',    'number', true,  0, 5),
  (80,  'Кухня',        'Температура в морозильній камері, °C',          'Фото термометра',    'number', true,  -25, -18),
  (90,  'Кухня',        'Заготовки промарковані, простроченого немає?',  'Фото полиці з маркуванням', 'yes_no', true, null, null),
  (100, 'Кухня',        'Усе обладнання кухні справне?',                 null,                 'yes_no', false, null, null),
  (110, 'Каса',         'Розмінна сума в касі, грн',                     null,                 'number', false, null, null),
  (120, 'Каса',         'Термінал оплати працює, Syrve на звʼязку?',     null,                 'yes_no', false, null, null),
  (130, 'Безпека',      'Генератор / резервне живлення перевірено, пальне є?', null,           'yes_no', false, null, null),
  (140, 'Безпека',      'Аптечка й вогнегасник на місці?',               null,                 'yes_no', false, null, null),
  (150, 'Персонал',     'Скільки працівників вийшло на зміну?',          null,                 'number', false, null, null),
  (160, 'Персонал',     'Зовнішній вигляд персоналу за стандартом?',     'Фото команди перед відкриттям', 'yes_no', true, null, null),
  (170, 'Підсумок',     'Інші зауваження (або «-» якщо немає)',          null,                 'text',   false, null, null)
) v
where not exists (select 1 from checklist_items);

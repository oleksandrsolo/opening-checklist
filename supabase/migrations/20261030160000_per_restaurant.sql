-- =====================================================================
-- Окремий чек-лист для кожного ресторану, вікно виконання,
-- кілька ресторанів у одного працівника.
-- =====================================================================

-- ---------- 1. Вікно виконання: з start_time до open_time ----------
alter table restaurants add column if not exists start_time time not null default '07:00';
comment on column restaurants.start_time is 'Раніше цього часу почати чек-лист не можна';
comment on column restaurants.open_time  is 'Дедлайн: завершено пізніше = запізнення';

-- ---------- 2. Кілька ресторанів у працівника ----------
create table if not exists staff_restaurants (
  telegram_id   bigint not null references staff(telegram_id) on delete cascade,
  restaurant_id int    not null references restaurants(id) on delete cascade,
  primary key (telegram_id, restaurant_id)
);

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'staff' and column_name = 'restaurant_id') then
    insert into staff_restaurants (telegram_id, restaurant_id)
    select telegram_id, restaurant_id from staff where restaurant_id is not null
    on conflict do nothing;
    alter table staff drop column restaurant_id;
  end if;
end $$;

alter table staff_restaurants enable row level security;
drop policy if exists admin_read_staff_rest on staff_restaurants;
create policy admin_read_staff_rest on staff_restaurants for select to authenticated using (is_admin());
drop policy if exists admin_add_staff_rest on staff_restaurants;
create policy admin_add_staff_rest on staff_restaurants for insert to authenticated with check (is_admin());
drop policy if exists admin_del_staff_rest on staff_restaurants;
create policy admin_del_staff_rest on staff_restaurants for delete to authenticated using (is_admin());

-- ---------- 3. Спільні пункти → копія в кожен ресторан ----------
alter table checklist_items add column if not exists source_item_id int;

insert into checklist_items (restaurant_id, position, section, question, hint, answer_type,
                             photo_required, ok_min, ok_max, active, source_item_id)
select r.id, i.position, i.section, i.question, i.hint, i.answer_type,
       i.photo_required, i.ok_min, i.ok_max, i.active, i.id
from checklist_items i cross join restaurants r
where i.restaurant_id is null;

-- старі відповіді переносимо на копію пункту свого ресторану
update answers a set item_id = c.id
from submissions s, checklist_items c
where a.submission_id = s.id
  and c.source_item_id = a.item_id
  and c.restaurant_id = s.restaurant_id;

delete from checklist_items where restaurant_id is null;
alter table checklist_items drop column source_item_id;
alter table checklist_items alter column restaurant_id set not null;
create index if not exists checklist_items_rest on checklist_items (restaurant_id, position);

-- адмін може видаляти пункти, на які ще немає відповідей (інакше — вимикати)
drop policy if exists admin_del_items on checklist_items;
create policy admin_del_items on checklist_items for delete to authenticated using (is_admin());

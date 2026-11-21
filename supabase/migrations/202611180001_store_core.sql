-- Dar Al Handasa production store schema for Supabase PostgreSQL.
-- Apply this migration in the Supabase SQL editor before enabling the API.
begin;

create extension if not exists pgcrypto;

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  icon text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  description text not null default '',
  brand_id uuid references public.brands(id) on delete restrict,
  category_id uuid not null references public.categories(id) on delete restrict,
  price numeric(12,2) not null check (price >= 0),
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  image text not null default '',
  label text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists products_category_active_idx on public.products(category_id, active);
create index if not exists products_brand_active_idx on public.products(brand_id, active);
create index if not exists products_price_active_idx on public.products(price) where active;
create index if not exists products_search_idx on public.products using gin
  (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,'') || ' ' || coalesce(sku,'')));

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  quantity_delta integer not null check (quantity_delta <> 0),
  quantity_after integer not null check (quantity_after >= 0),
  reason text not null,
  admin_reference text not null,
  created_at timestamptz not null default now()
);
create index if not exists inventory_movements_product_date_idx
  on public.inventory_movements(product_id, created_at desc);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending',
  currency text not null default 'EGP',
  total numeric(12,2) not null default 0 check (total >= 0),
  created_at timestamptz not null default now()
);
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  product_id uuid references public.products(id) on delete set null,
  sku_snapshot text not null,
  name_snapshot text not null,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.site_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);
create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null,
  maps_url text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text not null default '',
  subject text not null,
  details text not null,
  status text not null default 'new',
  created_at timestamptz not null default now()
);
create table if not exists public.quote_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text not null,
  company text not null default '',
  activity text not null default '',
  governorate text not null default '',
  city text not null default '',
  address text not null default '',
  products text not null,
  quantity text not null,
  details text not null default '',
  status text not null default 'new',
  created_at timestamptz not null default now()
);
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  name text not null,
  phone text not null,
  password_hash text not null,
  password_salt text not null,
  role text not null default 'customer',
  approved boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.wholesale_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete restrict,
  company text not null,
  activity text not null,
  governorate text not null,
  city text not null,
  address text not null,
  tax_number text not null default '',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create or replace function public.create_user_account(
  p_email text, p_name text, p_phone text, p_password_hash text, p_password_salt text,
  p_role text, p_approved boolean, p_company text default '', p_activity text default '',
  p_governorate text default '', p_city text default '', p_address text default '', p_tax_number text default ''
) returns public.users language plpgsql security definer set search_path = public as $$
declare created_user public.users;
begin
  insert into public.users(email,name,phone,password_hash,password_salt,role,approved)
  values(lower(trim(p_email)),trim(p_name),trim(p_phone),p_password_hash,p_password_salt,p_role,p_approved)
  returning * into created_user;
  if p_role='wholesale' then
    insert into public.wholesale_applications(user_id,company,activity,governorate,city,address,tax_number)
    values(created_user.id,trim(p_company),trim(p_activity),trim(p_governorate),trim(p_city),trim(p_address),coalesce(p_tax_number,''));
  end if;
  return created_user;
end;
$$;

create or replace function public.set_wholesale_status(p_application_id uuid,p_status text)
returns public.wholesale_applications language plpgsql security definer set search_path = public as $$
declare app public.wholesale_applications;
begin
  if p_status not in ('pending','approved','rejected') then raise exception 'invalid_status' using errcode='22023'; end if;
  update public.wholesale_applications set status=p_status where id=p_application_id returning * into app;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  update public.users set approved=(p_status='approved') where id=app.user_id;
  return app;
end;
$$;

create or replace function public.save_site_settings(p_settings jsonb)
returns setof public.site_settings language plpgsql security definer set search_path = public as $$
begin
  insert into public.site_settings(key,value)
  select key,value from jsonb_each_text(p_settings) as s(key,value)
  on conflict(key) do update set value=excluded.value,updated_at=now();
  return query select * from public.site_settings order by key;
end;
$$;

insert into public.site_settings(key,value) values
 ('business_name','دار الهندسة للأنظمة المتطورة'),('currency','EGP'),('phone','01099005307'),
 ('whatsapp','01099005307'),('whatsapp_link','https://wa.me/201099005307'),('instapay_number','01099005307'),
 ('wallet_number','01500074015'),('facebook_url','https://www.facebook.com/share/1P9meyfK2R/'),
 ('instagram_url','https://www.instagram.com/dar.alhandasah2?igsh=MTlpOXBsOHM5NmM3Mw==')
on conflict(key) do nothing;

-- Inventory adjustment and audit record are atomic. Only the trusted backend role may call it.
create or replace function public.adjust_inventory(
  p_product_id uuid, p_delta integer, p_reason text, p_admin_reference text
) returns public.products language plpgsql security definer set search_path = public as $$
declare updated_product public.products;
begin
  if p_delta = 0 or nullif(trim(p_reason), '') is null or nullif(trim(p_admin_reference), '') is null then
    raise exception 'invalid_inventory_adjustment' using errcode = '22023';
  end if;
  update public.products
     set stock_quantity = stock_quantity + p_delta, updated_at = now()
   where id = p_product_id and active and stock_quantity + p_delta >= 0
   returning * into updated_product;
  if not found then raise exception 'product_missing_or_insufficient_stock' using errcode = 'P0002'; end if;
  insert into public.inventory_movements(product_id, quantity_delta, quantity_after, reason, admin_reference)
  values (p_product_id, p_delta, updated_product.stock_quantity, trim(p_reason), trim(p_admin_reference));
  return updated_product;
end;
$$;

-- Product insert/update plus its initial or changed inventory balance is one transaction.
create or replace function public.save_product(
  p_product_id uuid,
  p_sku text,
  p_name text,
  p_description text,
  p_category_name text,
  p_category_slug text,
  p_brand_name text,
  p_brand_slug text,
  p_price numeric,
  p_stock_quantity integer,
  p_image text,
  p_label text,
  p_admin_reference text,
  p_inventory_reason text default 'تعديل المنتج من لوحة الإدارة'
) returns public.products language plpgsql security definer set search_path = public as $$
declare prior_quantity integer := 0; saved_product public.products; saved_category uuid; saved_brand uuid;
begin
  if nullif(trim(p_sku),'') is null or nullif(trim(p_name),'') is null or p_price < 0
     or nullif(trim(p_category_name),'') is null or p_stock_quantity < 0 or p_admin_reference is null then
    raise exception 'invalid_product' using errcode = '22023';
  end if;
  insert into public.categories(name,slug,active) values(trim(p_category_name),trim(p_category_slug),true)
    on conflict(name) do update set active=true,updated_at=now() returning id into saved_category;
  if nullif(trim(p_brand_name),'') is not null then
    insert into public.brands(name,slug,active) values(trim(p_brand_name),trim(p_brand_slug),true)
      on conflict(name) do update set active=true,updated_at=now() returning id into saved_brand;
  else saved_brand := null;
  end if;
  if p_product_id is null then
    insert into public.products(sku,name,description,brand_id,category_id,price,stock_quantity,image,label)
    values(trim(p_sku),trim(p_name),coalesce(p_description,''),saved_brand,saved_category,p_price,p_stock_quantity,coalesce(p_image,''),coalesce(p_label,''))
    returning * into saved_product;
    if p_stock_quantity > 0 then
      insert into public.inventory_movements(product_id,quantity_delta,quantity_after,reason,admin_reference)
      values(saved_product.id,p_stock_quantity,p_stock_quantity,'تعديل المنتج عند الإنشاء',p_admin_reference);
    end if;
  else
    select stock_quantity into prior_quantity from public.products where id=p_product_id and active for update;
    if not found then raise exception 'product_not_found' using errcode = 'P0002'; end if;
    update public.products set sku=trim(p_sku),name=trim(p_name),description=coalesce(p_description,''),brand_id=saved_brand,
      category_id=saved_category,price=p_price,stock_quantity=p_stock_quantity,image=coalesce(p_image,''),label=coalesce(p_label,''),updated_at=now()
      where id=p_product_id returning * into saved_product;
    if prior_quantity <> p_stock_quantity then
      insert into public.inventory_movements(product_id,quantity_delta,quantity_after,reason,admin_reference)
      values(saved_product.id,p_stock_quantity-prior_quantity,p_stock_quantity,coalesce(nullif(trim(p_inventory_reason),''),'تعديل المخزون'),p_admin_reference);
    end if;
  end if;
  return saved_product;
end;
$$;

-- The browser has no direct table access. The Node API uses the server-only service role.
do $$ declare t text; begin
  foreach t in array array['categories','brands','products','inventory_movements','orders','order_items','site_settings','branches','contact_messages','quote_requests','users','wholesale_applications'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on function public.adjust_inventory(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.adjust_inventory(uuid, integer, text, text) to service_role;
revoke all on function public.save_product(uuid,text,text,text,text,text,text,text,numeric,integer,text,text,text,text) from public, anon, authenticated;
grant execute on function public.save_product(uuid,text,text,text,text,text,text,text,numeric,integer,text,text,text,text) to service_role;
revoke all on function public.create_user_account(text,text,text,text,text,text,boolean,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.create_user_account(text,text,text,text,text,text,boolean,text,text,text,text,text,text) to service_role;
revoke all on function public.set_wholesale_status(uuid,text) from public, anon, authenticated;
grant execute on function public.set_wholesale_status(uuid,text) to service_role;
revoke all on function public.save_site_settings(jsonb) from public, anon, authenticated;
grant execute on function public.save_site_settings(jsonb) to service_role;
commit;

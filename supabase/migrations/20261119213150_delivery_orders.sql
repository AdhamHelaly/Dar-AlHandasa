begin;

alter table public.orders
  add column if not exists customer_name text not null default '',
  add column if not exists customer_email text not null default '',
  add column if not exists customer_phone text not null default '',
  add column if not exists governorate text not null default '',
  add column if not exists city text not null default '',
  add column if not exists delivery_address text not null default '',
  add column if not exists delivery_fee numeric(12,2) not null default 0 check (delivery_fee >= 0),
  add column if not exists order_method text not null default 'website' check (order_method in ('website','whatsapp')),
  add column if not exists idempotency_key uuid,
  add column if not exists request_fingerprint text,
  add column if not exists reservation_expires_at timestamptz;

alter table public.orders drop constraint if exists orders_idempotency_fingerprint_check;
alter table public.orders add constraint orders_idempotency_fingerprint_check check
  ((idempotency_key is null and request_fingerprint is null)
    or (idempotency_key is not null and request_fingerprint is not null
      and request_fingerprint ~ '^[0-9a-f]{64}$'));

create unique index if not exists orders_idempotency_key_uidx
  on public.orders(idempotency_key) where idempotency_key is not null;
create index if not exists orders_created_at_idx on public.orders(created_at desc);
create index if not exists orders_status_idx on public.orders(status,created_at desc);
create index if not exists orders_whatsapp_reservation_expiry_idx
  on public.orders(reservation_expires_at) where order_method='whatsapp' and status='pending';

insert into public.site_settings(key,value) values
  ('delivery_enabled','true'),('delivery_fee','0'),
  ('delivery_note','نوصل الطلبات إلى عنوانك المسجل؛ لا يتوفر استلام من الفروع.'),
  ('hero_title','كل حلولك الهندسية'),('hero_subtitle','في مكان واحد'),
  ('hero_description','مجموعة متكاملة من الأدوات والمعدات والحلول الهندسية للأفراد والشركات.')
on conflict(key) do nothing;

-- Service-role only stock correction; row update and audit entry commit together.
create or replace function public.adjust_inventory(
  p_product_id uuid,p_delta integer,p_reason text,p_admin_reference text
) returns public.products language plpgsql security definer set search_path = pg_catalog, public as $$
declare updated_product public.products;
begin
  if p_delta=0 or nullif(trim(p_reason),'') is null or nullif(trim(p_admin_reference),'') is null then
    raise exception 'invalid_inventory_adjustment' using errcode='22023';
  end if;
  update public.products set stock_quantity=stock_quantity+p_delta,updated_at=now()
  where id=p_product_id and stock_quantity+p_delta>=0 returning * into updated_product;
  if not found then raise exception 'product_missing_or_insufficient_stock' using errcode='P0002'; end if;
  insert into public.inventory_movements(product_id,quantity_delta,quantity_after,reason,admin_reference)
  values(p_product_id,p_delta,updated_product.stock_quantity,trim(p_reason),trim(p_admin_reference));
  return updated_product;
end;
$$;

-- Restore a WhatsApp order's reservation once; the order row lock serializes the sweeper
-- against admin status changes and makes the transition to expired the one-time guard.
create or replace function public.expire_whatsapp_order(p_order_id uuid)
returns public.orders language plpgsql security definer set search_path = pg_catalog, public as $$
declare current_order public.orders; line record; new_quantity integer; expired_order public.orders;
begin
  select * into current_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found' using errcode='P0002'; end if;
  if current_order.order_method<>'whatsapp' or current_order.status<>'pending'
     or current_order.reservation_expires_at is null or current_order.reservation_expires_at>now() then
    return current_order;
  end if;
  for line in select product_id,quantity from public.order_items
    where order_id=p_order_id and product_id is not null loop
    update public.products set stock_quantity=stock_quantity+line.quantity,updated_at=now()
    where id=line.product_id returning stock_quantity into new_quantity;
    if not found then raise exception 'reserved_product_missing' using errcode='P0002'; end if;
    insert into public.inventory_movements(product_id,quantity_delta,quantity_after,reason,admin_reference)
    values(line.product_id,line.quantity,new_quantity,'انتهاء مهلة طلب واتساب واستعادة المخزون','order:'||p_order_id::text);
  end loop;
  update public.orders set status='expired',reservation_expires_at=null
  where id=p_order_id returning * into expired_order;
  return expired_order;
end;
$$;

-- Called periodically by the backend; SKIP LOCKED prevents contention with status updates.
create or replace function public.expire_whatsapp_reservations(p_batch_size integer default 100)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare candidate record; expired_count integer:=0;
begin
  if p_batch_size is null or p_batch_size<1 or p_batch_size>1000 then
    raise exception 'invalid_batch_size' using errcode='22023';
  end if;
  for candidate in
    select id from public.orders
    where order_method='whatsapp' and status='pending'
      and reservation_expires_at is not null and reservation_expires_at<=now()
    order by reservation_expires_at
    limit p_batch_size for update skip locked
  loop
    perform public.expire_whatsapp_order(candidate.id);
    expired_count:=expired_count+1;
  end loop;
  return expired_count;
end;
$$;

create or replace function public.create_delivery_order(
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_governorate text,
  p_city text,
  p_delivery_address text,
  p_order_method text,
  p_items jsonb,
  p_idempotency_key uuid,
  p_request_fingerprint text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  new_order public.orders;
  existing_order public.orders;
  line jsonb;
  current_product public.products;
  requested_id uuid;
  requested_quantity integer;
  calculated_total numeric(12,2) := 0;
  configured_delivery_fee numeric(12,2) := 0;
  snapshots jsonb := '[]'::jsonb;
begin
  if nullif(trim(p_customer_name),'') is null or nullif(trim(p_customer_phone),'') is null
     or nullif(trim(p_governorate),'') is null or nullif(trim(p_city),'') is null
     or nullif(trim(p_delivery_address),'') is null
     or p_order_method is null or p_order_method not in ('website','whatsapp')
     or p_items is null or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>50
     or p_idempotency_key is null or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_order' using errcode='22023';
  end if;

  -- Fast replay path. A key can only ever represent the exact same normalized request.
  select * into existing_order from public.orders where idempotency_key=p_idempotency_key;
  if found then
    if existing_order.request_fingerprint<>p_request_fingerprint then
      raise exception 'idempotency_conflict' using errcode='P2001';
    end if;
    if existing_order.order_method='whatsapp' and existing_order.status='pending'
       and existing_order.reservation_expires_at is not null
       and existing_order.reservation_expires_at<=now() then
      existing_order:=public.expire_whatsapp_order(existing_order.id);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',product_id,'sku',sku_snapshot,'name',name_snapshot,
      'price',unit_price,'quantity',quantity) order by created_at,id),'[]'::jsonb)
      into snapshots from public.order_items where order_id=existing_order.id;
    return jsonb_build_object('order',to_jsonb(existing_order),'items',snapshots,'replayed',true);
  end if;

  if exists(select 1 from public.site_settings where key='delivery_enabled' and lower(trim(value)) in ('false','0','no','لا')) then
    raise exception 'delivery_disabled' using errcode='22023';
  end if;
  select coalesce(nullif(value,'')::numeric,0) into configured_delivery_fee
  from public.site_settings where key='delivery_fee';
  configured_delivery_fee:=coalesce(configured_delivery_fee,0);
  if configured_delivery_fee<0 then raise exception 'invalid_delivery_fee' using errcode='22023'; end if;

  -- The unique key insert arbitrates concurrent retries. A collision waits for the
  -- winner; if it commits, this call returns that order without touching inventory.
  insert into public.orders(status,currency,total,customer_name,customer_email,customer_phone,
    governorate,city,delivery_address,delivery_fee,order_method,idempotency_key,
    request_fingerprint,reservation_expires_at)
  values('pending','EGP',0,trim(p_customer_name),coalesce(trim(p_customer_email),''),trim(p_customer_phone),
    trim(p_governorate),trim(p_city),trim(p_delivery_address),configured_delivery_fee,p_order_method,
    p_idempotency_key,p_request_fingerprint,
    case when p_order_method='whatsapp' then now()+interval '30 minutes' else null end)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into new_order;
  if not found then
    select * into existing_order from public.orders where idempotency_key=p_idempotency_key;
    if existing_order.request_fingerprint<>p_request_fingerprint then
      raise exception 'idempotency_conflict' using errcode='P2001';
    end if;
    if existing_order.order_method='whatsapp' and existing_order.status='pending'
       and existing_order.reservation_expires_at is not null
       and existing_order.reservation_expires_at<=now() then
      existing_order:=public.expire_whatsapp_order(existing_order.id);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',product_id,'sku',sku_snapshot,'name',name_snapshot,
      'price',unit_price,'quantity',quantity) order by created_at,id),'[]'::jsonb)
      into snapshots from public.order_items where order_id=existing_order.id;
    return jsonb_build_object('order',to_jsonb(existing_order),'items',snapshots,'replayed',true);
  end if;

  for line in select value from jsonb_array_elements(p_items) loop
    begin
      requested_id:=(line->>'id')::uuid;
      requested_quantity:=(line->>'quantity')::integer;
    exception when others then
      raise exception 'invalid_order_item' using errcode='22023';
    end;
    if requested_id is null or requested_quantity is null or requested_quantity<1 or requested_quantity>999 then
      raise exception 'invalid_order_item' using errcode='22023';
    end if;
    select * into current_product from public.products
    where id=requested_id and active=true and archived_at is null
    for update;
    if not found then raise exception 'product_unavailable' using errcode='P0002'; end if;
    if current_product.stock_quantity<requested_quantity then
      raise exception 'insufficient_stock' using errcode='P0001';
    end if;
    update public.products set stock_quantity=stock_quantity-requested_quantity,updated_at=now()
    where id=current_product.id returning * into current_product;
    insert into public.order_items(order_id,product_id,sku_snapshot,name_snapshot,unit_price,quantity)
    values(new_order.id,current_product.id,current_product.sku,current_product.name,current_product.price,requested_quantity);
    insert into public.inventory_movements(product_id,quantity_delta,quantity_after,reason,admin_reference)
    values(current_product.id,-requested_quantity,current_product.stock_quantity,
      case when p_order_method='whatsapp' then 'طلب واتساب (مخزون محجوز)' else 'طلب من المتجر' end,
      'order:'||new_order.id::text);
    calculated_total:=calculated_total+current_product.price*requested_quantity;
    snapshots:=snapshots||jsonb_build_array(jsonb_build_object(
      'id',current_product.id,'sku',current_product.sku,'name',current_product.name,
      'price',current_product.price,'quantity',requested_quantity));
  end loop;

  update public.orders set total=calculated_total+configured_delivery_fee
  where id=new_order.id returning * into new_order;
  return jsonb_build_object('order',to_jsonb(new_order),'items',snapshots,'replayed',false);
end;
$$;

create or replace function public.set_order_status(
  p_order_id uuid,p_status text,p_admin_reference text
) returns public.orders language plpgsql security definer set search_path = pg_catalog, public as $$
declare current_order public.orders; line record; updated_order public.orders; new_quantity integer;
begin
  if p_status is null or p_status not in ('pending','confirmed','processing','shipped','delivered','cancelled')
     or nullif(trim(p_admin_reference),'') is null then
    raise exception 'invalid_order_status' using errcode='22023';
  end if;
  select * into current_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found' using errcode='P0002'; end if;

  if current_order.status='expired' then return current_order; end if;
  if current_order.order_method='whatsapp' and current_order.status='pending'
     and current_order.reservation_expires_at is not null
     and current_order.reservation_expires_at<=now() then
    return public.expire_whatsapp_order(p_order_id);
  end if;
  if p_status=current_order.status then return current_order; end if;

  if not (
    (current_order.status='pending' and p_status in ('confirmed','cancelled'))
    or (current_order.status='confirmed' and p_status in ('processing','cancelled'))
    or (current_order.status='processing' and p_status in ('shipped','cancelled'))
    or (current_order.status='shipped' and p_status='delivered')
  ) then
    raise exception 'invalid_order_transition' using errcode='22023';
  end if;
  if p_status='cancelled' then
    for line in select product_id,quantity from public.order_items
      where order_id=p_order_id and product_id is not null loop
      update public.products set stock_quantity=stock_quantity+line.quantity,updated_at=now()
      where id=line.product_id returning stock_quantity into new_quantity;
      if not found then raise exception 'reserved_product_missing' using errcode='P0002'; end if;
      insert into public.inventory_movements(product_id,quantity_delta,quantity_after,reason,admin_reference)
      values(line.product_id,line.quantity,new_quantity,'إلغاء طلب واستعادة المخزون',trim(p_admin_reference));
    end loop;
  end if;
  update public.orders set status=p_status,
    reservation_expires_at=case when p_status='pending' then reservation_expires_at else null end
  where id=p_order_id returning * into updated_order;
  return updated_order;
end;
$$;

-- Browser roles must not be able to shadow objects used by SECURITY DEFINER functions.
revoke create on schema public from public,anon,authenticated;

revoke all on function public.adjust_inventory(uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.adjust_inventory(uuid,integer,text,text) to service_role;
revoke all on function public.expire_whatsapp_order(uuid) from public,anon,authenticated;
grant execute on function public.expire_whatsapp_order(uuid) to service_role;
revoke all on function public.expire_whatsapp_reservations(integer) from public,anon,authenticated;
grant execute on function public.expire_whatsapp_reservations(integer) to service_role;
-- Remove the pre-idempotency overload if an earlier draft of this migration was installed.
drop function if exists public.create_delivery_order(text,text,text,text,text,text,text,jsonb);
revoke all on function public.create_delivery_order(text,text,text,text,text,text,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.create_delivery_order(text,text,text,text,text,text,text,jsonb,uuid,text) to service_role;
revoke all on function public.set_order_status(uuid,text,text) from public,anon,authenticated;
grant execute on function public.set_order_status(uuid,text,text) to service_role;

commit;

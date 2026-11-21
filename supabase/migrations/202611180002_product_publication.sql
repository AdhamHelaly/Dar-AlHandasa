begin;

-- Product publication is explicitly controlled by the admin form. A draft remains
-- inactive with archived_at null; a product archived through the dashboard keeps
-- its archive timestamp until the admin republishes it.
drop function if exists public.save_product(uuid,text,text,text,text,text,text,text,numeric,integer,text,text,text,text);

create function public.save_product(
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
  p_inventory_reason text default 'تعديل المنتج من لوحة الإدارة',
  p_active boolean default true
) returns public.products language plpgsql security definer set search_path = public as $$
declare
  prior_quantity integer := 0;
  saved_product public.products;
  saved_category uuid;
  saved_brand uuid;
begin
  if nullif(trim(p_sku),'') is null or nullif(trim(p_name),'') is null or p_price < 0
     or nullif(trim(p_category_name),'') is null or p_stock_quantity < 0
     or p_admin_reference is null or p_active is null then
    raise exception 'invalid_product' using errcode = '22023';
  end if;

  insert into public.categories(name,slug,active)
  values(trim(p_category_name),trim(p_category_slug),true)
  on conflict(name) do update set active=true,updated_at=now()
  returning id into saved_category;

  if nullif(trim(p_brand_name),'') is not null then
    insert into public.brands(name,slug,active)
    values(trim(p_brand_name),trim(p_brand_slug),true)
    on conflict(name) do update set active=true,updated_at=now()
    returning id into saved_brand;
  else
    saved_brand := null;
  end if;

  if p_product_id is null then
    insert into public.products(sku,name,description,brand_id,category_id,price,stock_quantity,image,label,active)
    values(trim(p_sku),trim(p_name),coalesce(p_description,''),saved_brand,saved_category,p_price,
      p_stock_quantity,coalesce(p_image,''),coalesce(p_label,''),p_active)
    returning * into saved_product;

    if p_stock_quantity > 0 then
      insert into public.inventory_movements(product_id,quantity_delta,quantity_after,reason,admin_reference)
      values(saved_product.id,p_stock_quantity,p_stock_quantity,'تعديل المنتج عند الإنشاء',p_admin_reference);
    end if;
  else
    select stock_quantity into prior_quantity
    from public.products where id=p_product_id for update;
    if not found then raise exception 'product_not_found' using errcode = 'P0002'; end if;

    update public.products set
      sku=trim(p_sku), name=trim(p_name), description=coalesce(p_description,''),
      brand_id=saved_brand, category_id=saved_category, price=p_price,
      stock_quantity=p_stock_quantity, image=coalesce(p_image,''), label=coalesce(p_label,''),
      active=p_active,
      archived_at=case when p_active then null else archived_at end,
      updated_at=now()
    where id=p_product_id returning * into saved_product;

    if prior_quantity <> p_stock_quantity then
      insert into public.inventory_movements(product_id,quantity_delta,quantity_after,reason,admin_reference)
      values(saved_product.id,p_stock_quantity-prior_quantity,p_stock_quantity,
        coalesce(nullif(trim(p_inventory_reason),''),'تعديل المنتج من لوحة الإدارة'),p_admin_reference);
    end if;
  end if;

  return saved_product;
end;
$$;

revoke all on function public.save_product(uuid,text,text,text,text,text,text,text,numeric,integer,text,text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.save_product(uuid,text,text,text,text,text,text,text,numeric,integer,text,text,text,text,boolean) to service_role;

commit;

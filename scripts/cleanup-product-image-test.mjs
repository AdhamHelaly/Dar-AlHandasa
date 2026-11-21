import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectQuoteSnapshotImageReference, inspectStorageUrlReferenceValues } from './product-image-reference-safety.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROJECT_REF = 'ipegazjnkejasorskdur';
const EXPECTED_NAME = 'TEMPORARY IMAGE WORKFLOW TEST - DO NOT PUBLISH';
const PAGE_SIZE = 500;
const OBJECT_PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEST_SKU_RE = /^IMGTEST-[A-Z0-9][A-Z0-9-]{7,59}$/;
const EXPECTED_PRODUCT_FKS = new Set(['inventory_movements.inventory_movements_product_id_fkey', 'order_items.order_items_product_id_fkey']);
const EXPECTED_PRODUCTISH_COLUMNS = new Set(['inventory_movements.product_id','order_items.product_id','products.image','quote_requests.products']);

function parseEnv(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function params(values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) query.set(key, String(value));
  return query.toString();
}

function normalizeStorageName(name, prefix) {
  if (typeof name !== 'string' || !name) return null;
  const full = name.startsWith(prefix) ? name : `${prefix}${name}`;
  const expected = new RegExp(`^products/${prefix.split('/')[1]}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(?:jpg|png|webp)$`, 'i');
  return expected.test(full) ? full : null;
}

function storagePublicUrl(projectUrl, path) {
  const origin = new URL(projectUrl).origin;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${origin}/storage/v1/object/public/product-images/${encoded}`;
}

function parseCliRows(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('catalog_inspection_unavailable');
  let result;
  try { result = JSON.parse(stdout.slice(start).trim()); }
  catch { throw new Error('catalog_inspection_unavailable'); }
  if (!Array.isArray(result?.rows)) throw new Error('catalog_inspection_unavailable');
  return result.rows;
}

export function validateCleanupIdentity(productId, sku) {
  if (!UUID_RE.test(productId || '')) return 'invalid_product_uuid';
  if (!TEST_SKU_RE.test(sku || '') || sku !== sku?.toUpperCase()) return 'invalid_test_sku';
  return '';
}

export async function inspectCleanup({ client, projectUrl, productId, sku }) {
  const reasons = [];
  let productStatus = 'unknown';
  let product = null;
  let objectPathsStatus = 'unknown';
  let objectPaths = null;
  let failedCheck = null;
  const identityError = validateCleanupIdentity(productId, sku);
  if (identityError) return { safe: false, reasons: [identityError], product: null, productStatus, objectPaths, objectPathsStatus, failedCheck: 'identity_validation' };
  try {
    failedCheck = 'foreign_key_catalog';
    const [foreignKeys, productishColumns] = await Promise.all([client.listProductForeignKeys(), client.listProductishColumns()]);
    if (!Array.isArray(foreignKeys) || !Array.isArray(productishColumns)) throw new Error('catalog_inspection_unavailable');
    const foundFks = new Set(foreignKeys.map(row => `${row.referencing_table}.${row.constraint_name}`));
    if (foundFks.size !== EXPECTED_PRODUCT_FKS.size || [...EXPECTED_PRODUCT_FKS].some(value => !foundFks.has(value))) reasons.push('unexpected_product_foreign_key_schema');
    const foundColumns = new Set(productishColumns.map(row => `${row.table_name}.${row.column_name}`));
    if (foundColumns.size !== EXPECTED_PRODUCTISH_COLUMNS.size || [...EXPECTED_PRODUCTISH_COLUMNS].some(value => !foundColumns.has(value))) reasons.push('unexpected_product_reference_column_schema');

    failedCheck = 'exact_product_read';
    const productRows = await client.getProduct(productId);
    if (!Array.isArray(productRows)) throw new Error('product_readback_malformed');
    if (productRows.length === 0) {
      productStatus = 'confirmed_absent';
      reasons.push('product_id_not_found');
    } else if (productRows.length === 1) {
      productStatus = 'present';
      product = productRows[0];
    } else {
      productStatus = 'inspection_failed';
      reasons.push('product_id_ambiguous');
    }
    if (product) {
      if (product.id !== productId || product.sku !== sku) reasons.push('product_identity_mismatch');
      if (product.name !== EXPECTED_NAME) reasons.push('unexpected_product_name');
      if (product.active !== false) reasons.push('product_not_unpublished');
      if (Number(product.stock_quantity) !== 0) reasons.push('product_stock_not_zero');
      if (typeof product.image !== 'string' || product.image !== '') reasons.push('product_image_reference_not_cleared');
    }

    const prefix = `products/${productId}/`;
    failedCheck = 'exact_product_storage_listing';
    objectPaths = await client.listProductObjects(prefix);
    if (!Array.isArray(objectPaths) || objectPaths.some(path => typeof path !== 'string')) throw new Error('storage_listing_malformed');
    objectPathsStatus = objectPaths.length ? 'present' : 'confirmed_absent';
    for (const path of objectPaths) if (!normalizeStorageName(path, prefix)) reasons.push('unexpected_or_unowned_storage_path');

    failedCheck = 'business_reference_inspection';
    const [orderRefs, inventoryRefs, quoteSnapshots] = await Promise.all([
      client.findRows('order_items', productId),
      client.findRows('inventory_movements', productId),
      client.listQuoteSnapshots()
    ]);
    if (!Array.isArray(orderRefs) || !Array.isArray(inventoryRefs)) reasons.push('business_references_uninspectable');
    else {
      if (orderRefs.length) reasons.push('order_item_reference_exists');
      if (inventoryRefs.length) reasons.push('inventory_movement_reference_exists');
    }
    if (!Array.isArray(quoteSnapshots)) reasons.push('quote_snapshots_uninspectable');
    else {
      for (const row of quoteSnapshots) {
        if (typeof row?.products !== 'string') { reasons.push('quote_snapshots_uninspectable'); break; }
        if (row.products.includes(productId) || row.products.includes(sku)) reasons.push('quote_snapshot_product_reference_exists');
      }
    }

    for (const path of objectPaths) {
      failedCheck = 'image_reference_inspection';
      const fullPath = normalizeStorageName(path, prefix);
      if (!fullPath) continue;
      const publicUrl = storagePublicUrl(projectUrl, fullPath);
      const productRefs = await client.inspectProductImageReferences(publicUrl);
      if (!productRefs || productRefs.inspectable !== true || productRefs.ambiguous) reasons.push('image_product_references_uninspectable');
      else if (productRefs.referenced) reasons.push('image_referenced_by_product');
      if (Array.isArray(quoteSnapshots)) {
        for (const row of quoteSnapshots) {
          if (typeof row?.products !== 'string') { reasons.push('quote_snapshots_uninspectable'); break; }
          const imageReference = inspectQuoteSnapshotImageReference([row], publicUrl);
          if (!imageReference.inspectable || imageReference.ambiguous) { reasons.push('quote_snapshots_uninspectable'); break; }
          if (imageReference.referenced) { reasons.push('image_referenced_by_quote_snapshot'); break; }
        }
      }
    }
    return { safe: reasons.length === 0, reasons: [...new Set(reasons)], productStatus, product: product ? { id: product.id, sku: product.sku, name: product.name, active: product.active, stock_quantity: Number(product.stock_quantity), image: product.image } : null, objectPathsStatus, objectPaths, failedCheck: null };
  } catch (error) {
    if (failedCheck === 'exact_product_read') productStatus = 'inspection_failed';
    if (failedCheck === 'exact_product_storage_listing') objectPathsStatus = 'inspection_failed';
    return {
      safe: false,
      reasons: [...new Set([...reasons, error?.message === 'catalog_inspection_unavailable' ? 'catalog_inspection_unavailable' : 'preflight_unavailable'])],
      productStatus, product: product ? { id: product.id, sku: product.sku, name: product.name, active: product.active, stock_quantity: Number(product.stock_quantity), image: product.image } : null,
      objectPathsStatus, objectPaths, failedCheck
    };
  }
}

export async function runCleanup({ client, projectUrl, productId, sku, confirmation = '', onReport = () => {} }) {
  const initial = await inspectCleanup({ client, projectUrl, productId, sku });
  const report = {
    dryRun: true, safe: initial.safe, reasons: initial.reasons, productId, sku, before: initial,
    productStatus: initial.productStatus, objectPathsStatus: initial.objectPathsStatus, failedCheck: initial.failedCheck,
    productStillExists: initial.productStatus === 'present' ? true : initial.productStatus === 'confirmed_absent' ? false : null,
    deletedObjectPaths: [], objectDeleteAttempts: [], remainingObjectPaths: initial.objectPathsStatus === 'present' || initial.objectPathsStatus === 'confirmed_absent' ? initial.objectPaths : null,
    productDeleteAttempted: false, productDeleteOutcome: 'not_attempted', outcomeConfirmed: initial.safe, writeAttempted: false,
    nextAction: initial.safe ? 'review_dry_run_then_get_explicit_approval' : 'resolve_preflight_reasons', after: null
  };
  if (!initial.safe) { onReport(report); return report; }
  const requiredConfirmation = `${productId}:${sku}`;
  if (confirmation !== requiredConfirmation) { onReport(report); return report; }

  const stop = async (reason, remaining = report.remainingObjectPaths, confirmed = true, nextAction = 'manual_review_required', objectStatus = null) => {
    report.safe = false;
    report.reasons = [reason];
    report.remainingObjectPaths = remaining;
    report.outcomeConfirmed = confirmed;
    report.nextAction = nextAction;
    const productRows = await client.getProduct(productId).catch(() => null);
    if (!Array.isArray(productRows)) report.productStatus = 'inspection_failed';
    else if (productRows.some(row => row?.id === productId && row?.sku === sku)) report.productStatus = 'present';
    else if (productRows.length === 0) report.productStatus = 'confirmed_absent';
    else report.productStatus = 'inspection_failed';
    report.productStillExists = report.productStatus === 'present' ? true : report.productStatus === 'confirmed_absent' ? false : null;
    report.objectPathsStatus = objectStatus || (Array.isArray(remaining) ? remaining.length ? 'present' : 'confirmed_absent' : 'unknown');
    report.after = { productStatus: report.productStatus, productStillExists: report.productStillExists, objectPathsStatus: report.objectPathsStatus, remainingObjectPaths: report.remainingObjectPaths };
    onReport(report);
    return report;
  };

  // Re-fetch before each object delete. The product row remains in place until all its objects are verified absent.
  for (const path of initial.objectPaths) {
    const beforeObjectDelete = await inspectCleanup({ client, projectUrl, productId, sku });
    if (!beforeObjectDelete.safe) return stop(`pre_object_delete_${beforeObjectDelete.reasons[0] || 'check_failed'}`, beforeObjectDelete.objectPaths);
    if (!beforeObjectDelete.objectPaths.includes(path)) return stop('candidate_object_changed_before_delete', beforeObjectDelete.objectPaths);
    let deleteError = null;
    const objectAttempt = { path, status: 'attempted' };
    report.objectDeleteAttempts.push(objectAttempt);
    report.writeAttempted = true; report.dryRun = false;
    try { await client.deleteProductObject(path); }
    catch { deleteError = true; }
    let remaining;
    try { remaining = await client.listProductObjects(`products/${productId}/`); }
    catch { objectAttempt.status = 'inspection_failed'; return stop('object_delete_result_unverifiable', null, false, 'inspect_exact_product_prefix_read_only_before_retry', 'inspection_failed'); }
    if (!Array.isArray(remaining) || remaining.some(item => typeof item !== 'string')) { objectAttempt.status = 'inspection_failed'; return stop('object_delete_list_malformed', null, false, 'inspect_exact_product_prefix_read_only_before_retry', 'inspection_failed'); }
    if (remaining.includes(path)) { objectAttempt.status = 'present'; return stop(deleteError ? 'object_delete_failed' : 'object_delete_not_confirmed', remaining, true, 'review_remaining_exact_object_then_rerun_dry_run'); }
    objectAttempt.status = 'confirmed_absent';
    report.deletedObjectPaths.push(path);
    report.remainingObjectPaths = remaining;
    report.objectPathsStatus = remaining.length ? 'present' : 'confirmed_absent';
  }

  const beforeProductDelete = await inspectCleanup({ client, projectUrl, productId, sku });
  if (!beforeProductDelete.safe || beforeProductDelete.objectPaths.length) {
    return stop(`pre_product_delete_${beforeProductDelete.reasons[0] || 'objects_or_references_remain'}`, beforeProductDelete.objectPaths);
  }
  report.productDeleteAttempted = true; report.writeAttempted = true; report.dryRun = false;
  let deleted;
  let deleteError = null;
  try { deleted = await client.deleteProductExact(productId, sku); }
  catch { deleteError = true; }
  let afterProduct;
  try { afterProduct = await client.getProduct(productId); }
  catch { return stop('product_delete_result_unverifiable', null, false, 'reconcile_exact_product_id_and_sku_read_only_before_retry', 'unknown'); }
  if (!Array.isArray(afterProduct)) return stop('product_readback_malformed', null, false, 'reconcile_exact_product_id_and_sku_read_only_before_retry', 'inspection_failed');
  const matchingRows = afterProduct.filter(row => row?.id === productId && row?.sku === sku);
  if (matchingRows.length) {
    report.productStillExists = true;
    report.productDeleteOutcome = deleteError ? 'ambiguous_but_product_present' : 'not_deleted';
    return stop('exact_product_row_still_exists', [], true, 'inspect_product_and_references_read_only_before_any_retry');
  }
  if (afterProduct.length) return stop('product_identity_readback_unexpected', null, false, 'manual_review_required', 'unknown');
  report.productDeleteOutcome = !deleteError && Array.isArray(deleted) && deleted.length === 1 && deleted[0]?.id === productId && deleted[0]?.sku === sku
    ? 'confirmed_by_response_and_readback' : 'confirmed_by_readback';
  report.productStillExists = false;
  report.dryRun = false;
  let afterObjects;
  try { afterObjects = await client.listProductObjects(`products/${productId}/`); }
  catch { return stop('post_delete_storage_readback_unavailable', null, false, 'inspect_exact_product_prefix_read_only', 'inspection_failed'); }
  if (!Array.isArray(afterObjects) || afterObjects.some(item => typeof item !== 'string')) return stop('post_delete_storage_readback_malformed', null, false, 'inspect_exact_product_prefix_read_only', 'inspection_failed');
  report.remainingObjectPaths = afterObjects;
  report.objectPathsStatus = afterObjects.length ? 'present' : 'confirmed_absent';
  report.productStatus = 'confirmed_absent';
  report.after = { productStatus: report.productStatus, productStillExists: false, objectPathsStatus: report.objectPathsStatus, remainingObjectPaths: afterObjects };
  report.safe = afterObjects.length === 0;
  if (!report.safe) {
    report.reasons = ['unexpected_storage_paths_after_cleanup'];
    report.nextAction = 'inspect_only_these_exact_paths';
  } else report.nextAction = 'cleanup_verified';
  onReport(report);
  return report;
}

function createClient({ projectUrl, serviceKey, fetchFn = fetch }) {
  async function request(path, { method = 'GET', body, prefer } = {}) {
    const response = await fetchFn(`${projectUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(prefer ? { prefer } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    let value = null; try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    if (!response.ok) throw Object.assign(new Error('supabase_read_or_write_failed'), { code: `supabase_${response.status}` });
    return value;
  }
  return {
    async getProduct(id) { return request(`/rest/v1/products?${params({ select: 'id,sku,name,active,stock_quantity,image', id: `eq.${id}`, limit: 2 })}`); },
    async findRows(table, productId) { return request(`/rest/v1/${table}?${params({ select: 'id', product_id: `eq.${productId}`, limit: 1 })}`); },
    async inspectProductImageReferences(url) {
      const pageSize = 500; let offset = 0; const seenIds = new Set(); const values = [];
      while (true) {
        const page = await request(`/rest/v1/products?${params({ select: 'id,image', order: 'id.asc', limit: pageSize, offset })}`);
        if (!Array.isArray(page) || page.length > pageSize) throw new Error('product_image_references_uninspectable');
        for (const row of page) {
          if (typeof row?.id !== 'string' || seenIds.has(row.id)) throw new Error('product_image_references_uninspectable');
          seenIds.add(row.id); values.push(row.image);
        }
        if (page.length < pageSize) break;
        if (!page.length) throw new Error('product_image_references_uninspectable');
        offset += page.length;
      }
      return inspectStorageUrlReferenceValues(values, url);
    },
    async listQuoteSnapshots() {
      const all = []; const seenIds = new Set(); let offset = 0;
      while (true) {
        const page = await request(`/rest/v1/quote_requests?${params({ select: 'id,products', order: 'id.asc', limit: PAGE_SIZE, offset })}`);
        if (!Array.isArray(page) || page.length > PAGE_SIZE) throw new Error('quote_snapshots_uninspectable');
        for (const row of page) {
          if (typeof row?.id !== 'string' || seenIds.has(row.id)) throw new Error('quote_snapshots_uninspectable');
          seenIds.add(row.id);
        }
        all.push(...page);
        if (page.length < PAGE_SIZE) return all;
        if (!page.length) throw new Error('quote_snapshots_uninspectable');
        offset += page.length;
      }
    },
    async listProductObjects(prefix) {
      const all = []; const seenPaths = new Set(); let offset = 0;
      while (true) {
        const page = await request('/storage/v1/object/list/product-images', { method: 'POST', body: { prefix: prefix.replace(/\/$/, ''), limit: OBJECT_PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } } });
        if (!Array.isArray(page) || page.length > OBJECT_PAGE_SIZE) throw new Error('storage_list_uninspectable');
        const names = page.map(item => {
          if (typeof item?.name !== 'string') throw new Error('storage_list_uninspectable');
          const path = item.name.startsWith(prefix) ? item.name : `${prefix}${item.name}`;
          if (seenPaths.has(path)) throw new Error('storage_list_repeated_page');
          seenPaths.add(path);
          return path;
        });
        all.push(...names);
        if (!page.length) return all;
        if (page.length < OBJECT_PAGE_SIZE) return all;
        offset += page.length;
      }
    },
    async deleteProductExact(id, sku) {
      const query = params({ select: 'id,sku', id: `eq.${id}`, sku: `eq.${sku}`, name: `eq.${EXPECTED_NAME}`, active: 'eq.false', stock_quantity: 'eq.0' });
      return request(`/rest/v1/products?${query}`, { method: 'DELETE', prefer: 'return=representation' });
    },
    async deleteProductObject(path) {
      return request('/storage/v1/object/product-images', { method: 'DELETE', body: { prefixes: [path] } });
    },
    async listProductForeignKeys() { return runCatalogQuery(`select conrelid::regclass::text as referencing_table, conname as constraint_name from pg_constraint where contype='f' and confrelid='public.products'::regclass order by 1,2;`); },
    async listProductishColumns() { return runCatalogQuery(`select table_name, column_name from information_schema.columns where table_schema='public' and (column_name ilike '%product%' or column_name ilike '%image%') order by table_name,column_name;`); }
  };
}

export function createClientForTest(options) { return createClient(options); }

function runCatalogQuery(sql) {
  const cli = join(ROOT, 'node_modules', 'supabase', 'dist', 'supabase.js');
  if (!existsSync(cli)) throw new Error('catalog_inspection_unavailable');
  const result = spawnSync(process.execPath, [cli, 'db', 'query', `--remote=${PROJECT_REF}`, '--read-only', sql], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('catalog_inspection_unavailable');
  return parseCliRows(result.stdout || '');
}

async function main() {
  if (resolve(process.cwd()) !== ROOT) { console.error('Cleanup refused: run this script from A:\\DarAlhandsa.'); process.exitCode = 2; return; }
  const args = new Map(process.argv.slice(2).map(value => { const index = value.indexOf('='); return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)]; }));
  const productId = args.get('--product-id') || '';
  const sku = args.get('--sku') || '';
  const confirmation = args.get('--confirm-delete') || '';
  const identityError = validateCleanupIdentity(productId, sku);
  if (identityError) { console.error(`Cleanup refused: ${identityError}.`); process.exitCode = 2; return; }
  if ([...args.keys()].some(key => !['--product-id','--sku','--confirm-delete'].includes(key))) { console.error('Cleanup refused: unexpected arguments.'); process.exitCode = 2; return; }
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) { console.error('Cleanup refused: project .env is missing.'); process.exitCode = 2; return; }
  const env = parseEnv(envPath);
  const projectUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  let ref = '';
  try { const u = new URL(projectUrl); if (u.protocol === 'https:' && u.hostname.endsWith('.supabase.co')) ref = u.hostname.split('.')[0]; } catch {}
  if (ref !== PROJECT_REF || typeof serviceKey !== 'string' || serviceKey.length < 20) { console.error('Cleanup refused: local Supabase configuration does not match the approved project.'); process.exitCode = 2; return; }
  const report = await runCleanup({ client: createClient({ projectUrl, serviceKey }), projectUrl, productId, sku, confirmation, onReport: value => console.log(JSON.stringify(value, null, 2)) });
  if (!report.safe) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) main().catch(() => { console.error('Cleanup stopped safely: preflight or verification failed.'); process.exitCode = 1; });

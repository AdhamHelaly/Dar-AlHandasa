import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';
import { isSupabaseConfigured, supabaseRequest, supabaseTable } from './supabase-rest.mjs';
import { inspectQuoteSnapshotImageReference, inspectStorageUrlReferenceValues } from './scripts/product-image-reference-safety.mjs';

const scrypt = promisify(scryptCb);
const root = dirname(fileURLToPath(import.meta.url));
const productionProjectRef = 'ipegazjnkejasorskdur';
function parseEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}
const envArgument = process.argv.find(argument => argument.startsWith('--env='))?.slice('--env='.length);
const appEnvironment = (envArgument || process.env.APP_ENV || 'development').trim().toLowerCase();
if (!['development', 'staging', 'production'].includes(appEnvironment)) throw new Error('APP_ENV must be development, staging, or production.');
const envFile = join(root, appEnvironment === 'staging' ? '.env.staging' : '.env');
if (appEnvironment === 'staging') {
  if (!existsSync(envFile)) throw new Error('Staging environment is isolated: create .env.staging from .env.staging.example before starting.');
  for (const key of ['APP_ENV','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SESSION_SECRET','ADMIN_EMAIL','ADMIN_PASSWORD','API_HOST','API_PORT','NODE_ENV','WHATSAPP_RESERVATION_WORKER_ENABLED','FRONTEND_ORIGIN','STAGING_SUPABASE_PROJECT_REF','STAGING_API_URL','STAGING_TEST_PRODUCT_ID']) delete process.env[key];
  Object.assign(process.env, parseEnvFile(envFile));
  if (process.env.APP_ENV?.trim().toLowerCase() !== 'staging') throw new Error('.env.staging must explicitly set APP_ENV=staging.');
} else {
  process.env.APP_ENV = appEnvironment;
  if (existsSync(envFile)) for (const [key, value] of Object.entries(parseEnvFile(envFile))) if (!process.env[key]) process.env[key] = value;
}
function projectRefFromUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname.endsWith('.supabase.co') ? url.hostname.split('.')[0] : ''; }
  catch { return ''; }
}
const configuredProjectRef = projectRefFromUrl(process.env.SUPABASE_URL || '');
const stagingConfigurationValid = appEnvironment === 'staging'
  && /^[a-z0-9]{20}$/.test(process.env.STAGING_SUPABASE_PROJECT_REF || '')
  && process.env.STAGING_SUPABASE_PROJECT_REF !== productionProjectRef
  && configuredProjectRef === process.env.STAGING_SUPABASE_PROJECT_REF
  && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY.length >= 20 && !/replace-with|your[-_ ]/i.test(process.env.SUPABASE_SERVICE_ROLE_KEY))
  && Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 && !/replace-with|your[-_ ]/i.test(process.env.SESSION_SECRET))
  && Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && !/example\.(?:com|invalid)|replace-with/i.test(`${process.env.ADMIN_EMAIL} ${process.env.ADMIN_PASSWORD}`));
if (appEnvironment === 'staging' && !stagingConfigurationValid) throw new Error('Invalid staging configuration: .env.staging must contain valid dedicated staging project credentials and admin settings; production project credentials are rejected.');

const secret = process.env.SESSION_SECRET || randomBytes(48).toString('hex');
const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD;
const port = Number(process.env.API_PORT || 3000);
const nodeEnvironment = process.env.NODE_ENV?.trim().toLowerCase() || 'development';
const reservationWorkerRequested = process.env.WHATSAPP_RESERVATION_WORKER_ENABLED?.trim().toLowerCase() === 'true';
const workerEnvironmentAllowed = ['staging', 'production'].includes(appEnvironment) && nodeEnvironment === 'production';
const reservationWorkerEnabled = reservationWorkerRequested && workerEnvironmentAllowed && isSupabaseConfigured() && (appEnvironment !== 'staging' || stagingConfigurationValid);
const reservationWorkerDisabledReason = !reservationWorkerRequested ? 'switch_off' : !workerEnvironmentAllowed ? 'isolated_environment_required' : !isSupabaseConfigured() ? 'supabase_not_configured' : appEnvironment === 'staging' && !stagingConfigurationValid ? 'staging_configuration_invalid' : null;
const reservationWorkerStatus = { enabled: reservationWorkerEnabled, scheduled: false, running: false, lastRunAt: null, lastSuccessAt: null, lastErrorCode: null, disabledReason: reservationWorkerDisabledReason };
const attempts = new Map();
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': res.getHeader('Access-Control-Allow-Origin') || process.env.FRONTEND_ORIGIN || `http://127.0.0.1:4200`, 'Vary': 'Origin' }); res.end(JSON.stringify(body)); };
const clean = (value, max = 1000) => typeof value === 'string' ? value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max) : '';
const emailOk = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const phoneOk = value => /^[0-9+()\- ]{8,18}$/.test(value);
const publicSettingKeys = new Set(['business_name','currency','phone','whatsapp','whatsapp_link','instapay_number','wallet_number','facebook_url','instagram_url','email','business_hours','address','delivery_enabled','delivery_fee','delivery_note','hero_title','hero_subtitle','hero_description']);
function sign(payload) { const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url'); return `${data}.${createHmac('sha256', secret || 'development-secret-change-before-deploy').update(data).digest('base64url')}`; }
function verify(token) { try { const [data, signature] = token.split('.'); const expected = createHmac('sha256', secret || 'development-secret-change-before-deploy').update(data).digest(); const actual = Buffer.from(signature, 'base64url'); if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null; const payload = JSON.parse(Buffer.from(data, 'base64url').toString()); return payload.exp > Date.now() ? payload : null; } catch { return null; } }
function limited(req, key) { const ip = req.socket.remoteAddress || 'unknown'; const slot = `${ip}:${key}`; const now = Date.now(); const state = attempts.get(slot) || { start: now, count: 0 }; if (now - state.start > 15 * 60 * 1000) { state.start = now; state.count = 0; } state.count++; attempts.set(slot, state); return state.count <= 12; }
async function readBody(req) { let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 100_000) throw new Error('too_large'); } try { return JSON.parse(body || '{}'); } catch { throw new Error('invalid_json'); } }
function admin(req) { const header = req.headers.authorization || ''; const identity = verify(header.startsWith('Bearer ') ? header.slice(7) : ''); return identity?.role === 'admin' ? identity : null; }
function user(req) { const header = req.headers.authorization || ''; return verify(header.startsWith('Bearer ') ? header.slice(7) : ''); }
function productShape(p) { return { id: p.id, sku: p.sku, name: p.name, brand: p.brand, category: p.category, price: p.price, stock: !!p.stock, image: p.image || '', label: p.label || '' }; }
function supabaseProductShape(p) { return { id: p.id, sku: p.sku, name: p.name, description: p.description || '', brand: p.brands?.name || '', category: p.categories?.name || '', price: Number(p.price), stock: Number(p.stock_quantity) || 0, image: p.image || '', label: p.label || '', active: p.active, archivedAt: p.archived_at || null }; }
function normalizeProduct(body) {
  const product = { sku:clean(body.sku,60), name:clean(body.name,180), description:clean(body.description,5000), brand:clean(body.brand,120), category:clean(body.category,120), price:Number(body.price), stock:Number(body.stock), image:clean(body.image,1000), label:clean(body.label,80), active:body.active !== false };
  if (!product.sku || !product.name || !product.category || !Number.isFinite(product.price) || product.price < 0 || !Number.isSafeInteger(product.stock) || product.stock < 0) return { error:true };
  return product;
}
const slug = value => clean(value, 120).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || randomBytes(8).toString('hex');
const PRODUCT_IMAGE_BUCKET = 'product-images';
const productImageMaxBytes = Math.min(20 * 1024 * 1024, Math.max(64 * 1024, Number(process.env.PRODUCT_IMAGE_MAX_BYTES) || 5 * 1024 * 1024));
const imageOperationQueues = new Map();
function withProductImageLock(productId, operation) {
  const previous = imageOperationQueues.get(productId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const tail = current.catch(() => {});
  imageOperationQueues.set(productId, tail);
  return current.finally(() => { if (imageOperationQueues.get(productId) === tail) imageOperationQueues.delete(productId); });
}
function readProductImage(req) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > productImageMaxBytes + 64 * 1024) return reject(Object.assign(new Error('image_too_large'), { code: 'image_too_large' }));
    let parser;
    try { parser = Busboy({ headers: req.headers, limits: { fileSize: productImageMaxBytes, files: 1, fields: 0, parts: 1 } }); }
    catch { return reject(Object.assign(new Error('invalid_image_upload'), { code: 'invalid_image_upload' })); }
    let file = null, declaredMime = '', fileCount = 0, failure = null;
    parser.on('file', (field, stream, info) => {
      fileCount++;
      if (field !== 'image' || fileCount !== 1) { failure = Object.assign(new Error('invalid_image_upload'), { code: 'invalid_image_upload' }); stream.resume(); return; }
      declaredMime = String(info.mimeType || '').toLowerCase();
      const chunks = [];
      let length = 0;
      stream.on('limit', () => { failure = Object.assign(new Error('image_too_large'), { code: 'image_too_large' }); });
      stream.on('data', chunk => { length += chunk.length; if (length <= productImageMaxBytes) chunks.push(chunk); });
      stream.on('end', () => { if (!failure) file = { buffer: Buffer.concat(chunks), declaredMime }; });
    });
    parser.on('filesLimit', () => { failure = Object.assign(new Error('invalid_image_upload'), { code: 'invalid_image_upload' }); });
    parser.on('fieldsLimit', () => { failure = Object.assign(new Error('invalid_image_upload'), { code: 'invalid_image_upload' }); });
    parser.on('error', () => reject(Object.assign(new Error('invalid_image_upload'), { code: 'invalid_image_upload' })));
    parser.on('finish', () => {
      if (failure) return reject(failure);
      if (!file?.buffer?.length) return reject(Object.assign(new Error('image_required'), { code: 'image_required' }));
      const b = file.buffer;
      let detectedMime = '';
      if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) detectedMime = 'image/png';
      else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) detectedMime = 'image/jpeg';
      else if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') detectedMime = 'image/webp';
      if (!detectedMime || file.declaredMime !== detectedMime) return reject(Object.assign(new Error('invalid_image_type'), { code: 'invalid_image_type' }));
      resolve({ buffer: b, mime: detectedMime, extension: detectedMime === 'image/jpeg' ? 'jpg' : detectedMime.slice('image/'.length) });
    });
    req.pipe(parser);
  });
}
function productImagePathFromUrl(imageUrl, productId) {
  try {
    const projectUrl = new URL(process.env.SUPABASE_URL);
    const image = new URL(imageUrl);
    if (image.origin !== projectUrl.origin) return null;
    const match = image.pathname.match(/^\/storage\/v1\/object\/public\/product-images\/(products\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(?:jpg|png|webp))$/i);
    return match && match[2].toLowerCase() === productId.toLowerCase() ? match[1] : null;
  } catch { return null; }
}
async function productImageStorage(path, { method = 'GET', body, mime } = {}) {
  const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const encodedPath = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '';
  const url = `${base}/storage/v1/object/${PRODUCT_IMAGE_BUCKET}${encodedPath}`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const isBinary = Buffer.isBuffer(body);
  const response = await fetch(url, { method, headers: { apikey: key, Authorization: `Bearer ${key}`, ...(mime ? { 'Content-Type': mime, 'x-upsert': 'false', 'Cache-Control': 'public, max-age=31536000, immutable' } : {}), ...(body && !isBinary ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: isBinary ? body : JSON.stringify(body) } : {}) });
  const text = await response.text();
  if (!response.ok) { const error = new Error('storage_request_failed'); error.code = `storage_${response.status}`; error.status = response.status; throw error; }
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
async function deleteProductImageObject(path) {
  const result = await productImageStorage('', { method: 'DELETE', body: { prefixes: [path] } });
  return result;
}
function publicProductImageUrl(path) {
  return `${process.env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/public/${PRODUCT_IMAGE_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
async function quoteSnapshotReferencesImage(imageUrl) {
  const pageSize = 500;
  let offset = 0;
  const seenIds = new Set();
  while (true) {
    const query = new URLSearchParams({ select: 'id,products', order: 'id.asc', limit: String(pageSize), offset: String(offset) }).toString();
    const snapshots = await supabaseRequest(supabaseTable('quote_requests', query));
    if (!Array.isArray(snapshots) || snapshots.length > pageSize) throw Object.assign(new Error('quote_snapshot_uninspectable'), { code: 'quote_snapshot_uninspectable' });
    for (const row of snapshots) {
      if (typeof row?.id !== 'string' || seenIds.has(row.id)) throw Object.assign(new Error('quote_snapshot_uninspectable'), { code: 'quote_snapshot_uninspectable' });
      seenIds.add(row.id);
    }
    const inspection = inspectQuoteSnapshotImageReference(snapshots, imageUrl);
    if (!inspection.inspectable || inspection.ambiguous) throw Object.assign(new Error('quote_snapshot_uninspectable'), { code: 'quote_snapshot_uninspectable' });
    if (inspection.referenced) return true;
    if (snapshots.length < pageSize) return false;
    if (!snapshots.length) throw Object.assign(new Error('quote_snapshot_uninspectable'), { code: 'quote_snapshot_uninspectable' });
    offset += snapshots.length;
  }
}
async function productImageReferencesObject(imageUrl) {
  const pageSize = 500;
  let offset = 0;
  const seenIds = new Set();
  while (true) {
    const query = new URLSearchParams({ select: 'id,image', order: 'id.asc', limit: String(pageSize), offset: String(offset) }).toString();
    const rows = await supabaseRequest(supabaseTable('products', query));
    if (!Array.isArray(rows)) throw Object.assign(new Error('product_image_reference_uninspectable'), { code: 'product_image_reference_uninspectable' });
    for (const row of rows) {
      if (typeof row?.id !== 'string' || seenIds.has(row.id)) throw Object.assign(new Error('product_image_reference_uninspectable'), { code: 'product_image_reference_uninspectable' });
      seenIds.add(row.id);
    }
    const inspection = inspectStorageUrlReferenceValues(rows.map(row => row.image), imageUrl);
    if (!inspection.inspectable || inspection.ambiguous) throw Object.assign(new Error('product_image_reference_uninspectable'), { code: 'product_image_reference_uninspectable' });
    if (inspection.referenced) return true;
    if (rows.length < pageSize) return false;
    offset += rows.length;
  }
}
async function readProductImageReference(productId) {
  const query = new URLSearchParams({ select: 'id,image', id: `eq.${productId}`, limit: '2' }).toString();
  const rows = await supabaseRequest(supabaseTable('products', query));
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== productId || (rows[0].image !== null && typeof rows[0].image !== 'string')) {
    throw Object.assign(new Error('product_image_reference_uninspectable'), { code: 'product_image_reference_uninspectable' });
  }
  return rows[0].image || '';
}
async function cleanupPreviousProductImage(oldImage, productId, newImage) {
  const path = productImagePathFromUrl(oldImage, productId);
  if (!path || oldImage === newImage) return { deleted: false, reason: 'not_product_owned_storage_object' };
  try {
    if (await productImageReferencesObject(oldImage)) return { deleted: false, reason: 'shared_image_reference' };
    if (await quoteSnapshotReferencesImage(oldImage)) return { deleted: false, reason: 'shared_quote_snapshot_reference' };
    await deleteProductImageObject(path);
    return { deleted: true };
  } catch (error) {
    const reason = error?.code === 'quote_snapshot_uninspectable' ? 'quote_snapshot_uninspectable' : error?.code === 'product_image_reference_uninspectable' ? 'product_reference_uninspectable' : 'cleanup_failed';
    console.error('[product image] Previous object cleanup failed', { productId, objectId: path.split('/').at(-1), code: error?.code || 'storage_delete_failed' });
    return { deleted: false, reason };
  }
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowed = process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:4200';
  if (origin && origin !== allowed && origin !== 'http://127.0.0.1:4200') return json(res, 403, { error: 'origin_not_allowed' });
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': origin || allowed, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', Vary: 'Origin' }); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/api/health') {
      await supabaseRequest('products?select=id&limit=1');
      return json(res,200,{status:'ok',database:'supabase',environment:appEnvironment,supabaseProjectRef:appEnvironment==='staging'?configuredProjectRef:undefined,reservationWorker:{...reservationWorkerStatus}});
    }
    if (req.method === 'GET' && path === '/api/site') {
      const [settingRows, branches] = await Promise.all([
        supabaseRequest(supabaseTable('site_settings','select=key,value&order=key.asc')),
        supabaseRequest(supabaseTable('branches','select=id,name,address,maps_url&active=eq.true&order=created_at.asc'))
      ]);
      const settings = Object.fromEntries(settingRows.filter(row=>publicSettingKeys.has(row.key)).map(row => [row.key,row.value]));
      return json(res,200,{ settings, branches });
    }
    if (req.method === 'GET' && path === '/api/products') {
      const query = new URLSearchParams({ select: '*,categories!inner(name),brands(name)', active: 'eq.true', archived_at: 'is.null', 'categories.active': 'eq.true', order: 'created_at.desc' }).toString();
      const rows = (await supabaseRequest(supabaseTable('products', query))).map(supabaseProductShape);
      const filtered = rows.filter(p => (!url.searchParams.get('category') || p.category === url.searchParams.get('category')) && p.price >= Number(url.searchParams.get('min') || 0) && p.price <= Number(url.searchParams.get('max') || Number.MAX_SAFE_INTEGER));
      const search = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
      return json(res, 200, { products: search ? filtered.filter(p => `${p.name} ${p.description} ${p.brand} ${p.category} ${p.sku}`.toLocaleLowerCase().includes(search)) : filtered });
    }
    if (req.method === 'GET' && path.startsWith('/api/products/')) {
      const sku = decodeURIComponent(path.slice('/api/products/'.length));
      const query = new URLSearchParams({ select: '*,categories!inner(name),brands(name)', 'categories.active': 'eq.true', sku: `eq.${sku}`, active: 'eq.true', archived_at: 'is.null', limit: '1' }).toString();
      const rows = await supabaseRequest(supabaseTable('products', query));
      return rows?.[0] ? json(res, 200, { product: supabaseProductShape(rows[0]) }) : json(res, 404, { error: 'not_found' });
    }
    if (req.method === 'GET' && path === '/api/categories') {
      const query = new URLSearchParams({ select: 'id,name,slug,icon', active: 'eq.true', order: 'name.asc' }).toString();
      return json(res, 200, { categories: await supabaseRequest(supabaseTable('categories', query)) });
    }
    if (req.method === 'GET' && path === '/api/brands') {
      const query = new URLSearchParams({ select: 'id,name,slug', active: 'eq.true', order: 'name.asc' }).toString();
      return json(res, 200, { brands: await supabaseRequest(supabaseTable('brands', query)) });
    }
    if (req.method === 'POST' && path === '/api/contact') {
      if (!limited(req, 'contact')) return json(res, 429, { error: 'too_many_requests' });
      const b = await readBody(req); const v = { name: clean(b.name,120), phone: clean(b.phone,24), email: clean(b.email,180), subject: clean(b.subject,180), details: clean(b.details,5000) };
      if (!v.name || !phoneOk(v.phone) || (v.email && !emailOk(v.email)) || !v.subject || !v.details) return json(res, 400, { error: 'invalid_fields' });
      await supabaseRequest('contact_messages',{method:'POST',body:v,prefer:'return=minimal'});
      return json(res, 201, { message: 'تم حفظ رسالتك لمراجعتها.' });
    }
    if (req.method === 'POST' && path === '/api/quotes') {
      if (!limited(req, 'quotes')) return json(res, 429, { error: 'too_many_requests' });
      const b = await readBody(req); const v = { name: clean(b.name,120), phone: clean(b.phone,24), email: clean(b.email,180), company: clean(b.company,180), activity: clean(b.activity,120), governorate: clean(b.governorate,120), city: clean(b.city,120), address: clean(b.address,300), products: clean(b.products,3000), quantity: clean(String(b.quantity || ''),40), details: clean(b.details,5000) };
      if (!v.name || !phoneOk(v.phone) || !emailOk(v.email) || !v.products || !/^\d+$/.test(v.quantity) || Number(v.quantity) < 1) return json(res, 400, { error: 'invalid_fields' });
      await supabaseRequest('quote_requests',{method:'POST',body:v,prefer:'return=minimal'});
      return json(res, 201, { message: 'تم حفظ طلب عرض السعر للمراجعة.' });
    }
    if (req.method === 'POST' && path === '/api/orders') {
      if (!limited(req, 'orders')) return json(res,429,{error:'too_many_requests'});
      const b=await readBody(req), name=clean(b.name,120), email=clean(b.email,180), phone=clean(b.phone,24);
      const governorate=clean(b.governorate,120), city=clean(b.city,120), address=clean(b.address,500);
      const method=b.method;
      const idempotencyKey=typeof b.idempotencyKey==='string'?b.idempotencyKey.toLowerCase():'';
      if(!name||!phoneOk(phone)||(email&&!emailOk(email))||!governorate||!city||!address||!['website','whatsapp'].includes(method)||!Array.isArray(b.items)||!b.items.length||b.items.length>50) return json(res,400,{error:'invalid_order'});
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) return json(res,400,{error:'invalid_idempotency_key'});
      const items=b.items.map(item=>({id:clean(item?.id,50).toLowerCase(),quantity:Number(item?.quantity)}));
      if(items.some(item=>!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(item.id)||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>999)
        ||new Set(items.map(item=>item.id)).size!==items.length) return json(res,400,{error:'invalid_order_items'});
      items.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
      const fingerprintInput={name,email:email.toLowerCase(),phone,governorate,city,address,method,items};
      const requestFingerprint=createHash('sha256').update(JSON.stringify(fingerprintInput),'utf8').digest('hex');
      try {
        const result=await supabaseRequest('rpc/create_delivery_order',{method:'POST',body:{p_customer_name:name,p_customer_email:email,p_customer_phone:phone,p_governorate:governorate,p_city:city,p_delivery_address:address,p_order_method:method,p_items:items,p_idempotency_key:idempotencyKey,p_request_fingerprint:requestFingerprint}});
        const order=result?.order, snapshots=result?.items||[];
        if(!order?.id) throw new Error('invalid_order_rpc_response');
        if(order.status==='expired') return json(res,409,{error:'reservation_expired',orderId:order.id});
        if(method==='whatsapp') {
          if(order.status!=='pending') return json(res,409,{error:'order_already_processed',orderId:order.id});
          const lines=snapshots.map(item=>`${item.name} | SKU: ${item.sku} | الكمية: ${item.quantity} | السعر: ${Number(item.price).toFixed(2)} ج.م`).join('\n');
          const message=`طلب جديد رقم ${order.id}\nالاسم: ${name}\nالهاتف: ${phone}\nالتوصيل: ${governorate} - ${city} - ${address}\n${lines}\nالإجمالي: ${Number(order.total).toFixed(2)} ج.م`;
          return json(res,result.replayed?200:201,{orderId:order.id,total:Number(order.total),items:snapshots,replayed:!!result.replayed,reservationExpiresAt:order.reservation_expires_at,whatsappUrl:`https://wa.me/201099005307?text=${encodeURIComponent(message)}`});
        }
        return json(res,result.replayed?200:201,{orderId:order.id,total:Number(order.total),items:snapshots,replayed:!!result.replayed,message:'تم تسجيل طلبك بنجاح.'});
      } catch(error) {
        if(error.code==='P0002') return json(res,409,{error:'product_unavailable'});
        if(error.code==='P0001') return json(res,409,{error:'insufficient_stock'});
        if(error.code==='P2001') return json(res,409,{error:'idempotency_conflict'});
        if(error.code==='P2002') return json(res,409,{error:'reservation_expired'});
        if(error.code==='22023') return json(res,400,{error:'invalid_order'});
        if(error.code==='PGRST202'||error.code==='42883') return json(res,503,{error:'order_schema_not_applied'});
        throw error;
      }
    }
    if (req.method === 'POST' && path === '/api/wholesale') {
      if (!limited(req, 'wholesale')) return json(res, 429, { error: 'too_many_requests' });
      const b = await readBody(req); const v = { firstName: clean(b.firstName,80), lastName: clean(b.lastName,80), phone: clean(b.phone,24), email: clean(b.email,180).toLowerCase(), password: typeof b.password === 'string' ? b.password : '', company: clean(b.company,180), activity: clean(b.activity,120), governorate: clean(b.governorate,120), city: clean(b.city,120), address: clean(b.address,300), tax: clean(b.tax,60) };
      if (!v.firstName || !v.lastName || !phoneOk(v.phone) || !emailOk(v.email) || v.password.length < 10 || !v.company || !v.activity || !v.governorate || !v.city || !v.address) return json(res, 400, { error: 'invalid_fields' });
      const salt = randomBytes(16).toString('hex'); const hash = (await scrypt(v.password, salt, 64)).toString('hex');
      try { await supabaseRequest('rpc/create_user_account',{method:'POST',body:{p_email:v.email,p_name:`${v.firstName} ${v.lastName}`,p_phone:v.phone,p_password_hash:hash,p_password_salt:salt,p_role:'wholesale',p_approved:false,p_company:v.company,p_activity:v.activity,p_governorate:v.governorate,p_city:v.city,p_address:v.address,p_tax_number:v.tax}}); }
      catch(error) { if(error.code==='23505') return json(res,409,{error:'email_exists'}); throw error; }
      return json(res, 201, { message: 'تم استلام طلب التسجيل للمراجعة. تفعيل أسعار التاجر يحتاج اعتماد الحساب.' });
    }
    if (req.method === 'POST' && path === '/api/auth/register') {
      if (!limited(req, 'register')) return json(res, 429, { error: 'too_many_requests' });
      const b = await readBody(req); const name = clean(b.name,120); const email = clean(b.email,180).toLowerCase(); const phone = clean(b.phone,24); const password = typeof b.password === 'string' ? b.password : '';
      if (!name || !emailOk(email) || !phoneOk(phone) || password.length < 10) return json(res, 400, { error: 'invalid_fields' });
      const salt = randomBytes(16).toString('hex'); const hash = (await scrypt(password,salt,64)).toString('hex');
      let result;
      try { result=await supabaseRequest('rpc/create_user_account',{method:'POST',body:{p_email:email,p_name:name,p_phone:phone,p_password_hash:hash,p_password_salt:salt,p_role:'customer',p_approved:true}}); }
      catch(error) { if(error.code==='23505') return json(res,409,{error:'email_exists'}); throw error; }
      const token = sign({ id: result.id, email, role: 'customer', name });
      return json(res, 201, { token, user: { name, email, role: 'customer' } });
    }
    if (req.method === 'POST' && path === '/api/auth/login') {
      if (!limited(req, 'login')) return json(res, 429, { error: 'too_many_requests' });
      const b = await readBody(req); const email = clean(b.email,180).toLowerCase(); const password = typeof b.password === 'string' ? b.password : '';
      const query = new URLSearchParams({select:'*',email:`eq.${email}`,limit:'1'}).toString();
      const row = (await supabaseRequest(supabaseTable('users',query)))[0];
      if (!row || row.role === 'admin') return json(res, 401, { error: 'invalid_credentials' });
      const derived = await scrypt(password,row.password_salt,64);
      if (!timingSafeEqual(Buffer.from(row.password_hash,'hex'),derived)) return json(res, 401, { error: 'invalid_credentials' });
      if (row.role === 'wholesale' && !row.approved) return json(res, 403, { error: 'pending_approval' });
      const token = sign({ id: row.id, email: row.email, role: row.role, name: row.name });
      return json(res, 200, { token, user: { name: row.name, email: row.email, role: row.role } });
    }
    if (req.method === 'GET' && path === '/api/auth/me') {
      const identity = user(req); if (!identity) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { user: { id: identity.id, name: identity.name, email: identity.email, role: identity.role } });
    }
    if (req.method === 'POST' && path === '/api/admin/login') {
      if (!limited(req, 'admin-login')) return json(res, 429, { error: 'too_many_requests' });
      if (!adminEmail || !adminPassword || !process.env.SESSION_SECRET) return json(res, 503, { error: 'admin_not_configured' });
      const b = await readBody(req); const email = clean(b.email,180).toLowerCase(); const password = typeof b.password === 'string' ? b.password : '';
      const given = Buffer.from(password); const expected = Buffer.from(adminPassword);
      if (email !== adminEmail || given.length !== expected.length || !timingSafeEqual(given,expected)) return json(res, 401, { error: 'invalid_credentials' });
      return json(res, 200, { token: sign({ id: 'admin', email, role: 'admin', name: 'مدير النظام' }) });
    }
    if (path.startsWith('/api/admin/')) {
      if (!admin(req)) return json(res, 401, { error: 'admin_auth_required' });
      if (req.method === 'GET' && path === '/api/admin/products') {
        const query = new URLSearchParams({ select: '*,categories(name),brands(name)', order: 'created_at.desc' }).toString();
        try {
          const products = (await supabaseRequest(supabaseTable('products', query))).map(supabaseProductShape);
          console.info('[admin catalog] Supabase product list loaded', { count: products.length });
          return json(res,200,{ products });
        } catch (error) {
          console.error('[admin catalog] Supabase product list failed', { status: error?.status || 500, code: error?.code || 'query_failed' });
          throw error;
        }
      }
      const productImageRoute = path.match(/^\/api\/admin\/products\/([0-9a-f-]{36})\/image$/i);
      if (productImageRoute && req.method === 'POST') {
        const productId = productImageRoute[1];
        return await withProductImageLock(productId, async () => {
          const upload = await readProductImage(req);
          const prior = (await supabaseRequest(supabaseTable('products', new URLSearchParams({ select: 'id,image', id: `eq.${productId}`, limit: '1' }).toString())))[0];
          if (!prior) return json(res, 404, { error: 'not_found' });
          const objectPath = `products/${productId}/${randomUUID()}.${upload.extension}`;
          try { await productImageStorage(objectPath, { method: 'POST', body: upload.buffer, mime: upload.mime }); }
          catch (error) {
            try { await deleteProductImageObject(objectPath); }
            catch (cleanupError) { console.error('[product image] Orphan cleanup required after upload failure', { productId, objectId: objectPath.split('/').at(-1), code: cleanupError?.code || 'storage_delete_failed' }); }
            throw error;
          }
          const image = publicProductImageUrl(objectPath);
          let referenceConfirmed = false;
          try {
            const updated = await supabaseRequest(supabaseTable('products', `id=eq.${encodeURIComponent(productId)}`), { method: 'PATCH', body: { image }, prefer: 'return=representation' });
            referenceConfirmed = Array.isArray(updated) && updated.length === 1 && updated[0]?.id === productId && updated[0]?.image === image;
          } catch { /* Verify below before deciding whether the uploaded object can be considered orphaned. */ }
          if (!referenceConfirmed) {
            try { referenceConfirmed = await readProductImageReference(productId) === image; }
            catch { return json(res, 502, { error: 'image_reference_update_uncertain', uploadedImageRetained: true }); }
          }
          if (!referenceConfirmed) return json(res, 502, { error: 'image_reference_update_not_confirmed', uploadedImageRetained: true });
          const cleanup = await cleanupPreviousProductImage(prior.image || '', productId, image);
          return json(res, 200, { image, previousImageDeleted: cleanup.deleted, previousImageRetainedReason: cleanup.reason || null });
        });
      }
      if (productImageRoute && req.method === 'DELETE') {
        const productId = productImageRoute[1];
        return await withProductImageLock(productId, async () => {
          const prior = (await supabaseRequest(supabaseTable('products', new URLSearchParams({ select: 'id,image', id: `eq.${productId}`, limit: '1' }).toString())))[0];
          if (!prior) return json(res, 404, { error: 'not_found' });
          if (!prior.image) return json(res, 200, { image: '', storageObjectDeleted: false });
          let cleared = false;
          try {
            const updated = await supabaseRequest(supabaseTable('products', `id=eq.${encodeURIComponent(productId)}`), { method: 'PATCH', body: { image: '' }, prefer: 'return=representation' });
            cleared = Array.isArray(updated) && updated.length === 1 && updated[0]?.id === productId && updated[0]?.image === '';
          } catch { /* Verify below before removing the prior object. */ }
          if (!cleared) {
            try { cleared = await readProductImageReference(productId) === ''; }
            catch { return json(res, 502, { error: 'image_reference_clear_uncertain', previousImageRetained: true }); }
          }
          if (!cleared) return json(res, 502, { error: 'image_reference_clear_not_confirmed', previousImageRetained: true });
          const cleanup = await cleanupPreviousProductImage(prior.image, productId, '');
          return json(res, 200, { image: '', storageObjectDeleted: cleanup.deleted, storageObjectRetainedReason: cleanup.reason || null });
        });
      }
      if (/^\/api\/admin\/(categories|brands)$/.test(path) && req.method === 'GET') {
        const table = path.endsWith('/categories') ? 'categories' : 'brands';
        const query = new URLSearchParams({ select:'*,products(count)', order:'name.asc' }).toString();
        return json(res,200,{ [table]:await supabaseRequest(supabaseTable(table,query)) });
      }
      if (/^\/api\/admin\/(categories|brands)$/.test(path) && req.method === 'POST') {
        const table = path.endsWith('/categories') ? 'categories' : 'brands';
        const b = await readBody(req); const name = clean(b.name,120);
        if (!name) return json(res,400,{error:'invalid_fields'});
        const inserted = await supabaseRequest(table,{method:'POST',body:{name,slug:slug(name),...(table==='categories'?{icon:clean(b.icon,40)}:{})},prefer:'return=representation'});
        return json(res,201,{[table.slice(0,-1)]:inserted?.[0]});
      }
      const taxonomyRoute = path.match(/^\/api\/admin\/(categories|brands)\/([0-9a-f-]{36})$/i);
      if (taxonomyRoute && req.method === 'PATCH') {
        const table=taxonomyRoute[1], id=taxonomyRoute[2], b=await readBody(req), update={updated_at:new Date().toISOString()};
        if (typeof b.active==='boolean') update.active=b.active;
        if (typeof b.name==='string' && clean(b.name,120)) { update.name=clean(b.name,120); update.slug=slug(update.name); }
        if (table==='categories' && typeof b.icon==='string') update.icon=clean(b.icon,40);
        const rows=await supabaseRequest(supabaseTable(table,`id=eq.${id}`),{method:'PATCH',body:update,prefer:'return=representation'});
        return rows?.length?json(res,200,{[table.slice(0,-1)]:rows[0]}):json(res,404,{error:'not_found'});
      }
      if (taxonomyRoute && req.method === 'DELETE') {
        const table=taxonomyRoute[1], id=taxonomyRoute[2], foreignKey=table==='categories'?'category_id':'brand_id';
        const linked=await supabaseRequest(supabaseTable('products',new URLSearchParams({select:'id',[foreignKey]:`eq.${id}`,limit:'1'}).toString()));
        if(linked?.length) return json(res,409,{error:'taxonomy_in_use'});
        const deleted=await supabaseRequest(supabaseTable(table,`id=eq.${id}`),{method:'DELETE',prefer:'return=representation'});
        return deleted?.length?json(res,200,{message:'deleted'}):json(res,404,{error:'not_found'});
      }
      const inventoryRoute=path.match(/^\/api\/admin\/products\/([0-9a-f-]{36})\/inventory$/i);
      if(inventoryRoute && req.method==='GET') {
        const query=new URLSearchParams({select:'*',product_id:`eq.${inventoryRoute[1]}`,order:'created_at.desc'}).toString();
        return json(res,200,{movements:await supabaseRequest(supabaseTable('inventory_movements',query))});
      }
      if(inventoryRoute && req.method==='POST') {
        const b=await readBody(req), delta=Number(b.delta), reason=clean(b.reason,240);
        if(!Number.isSafeInteger(delta)||delta===0||!reason) return json(res,400,{error:'invalid_fields'});
        try {
          const product=await supabaseRequest('rpc/adjust_inventory',{method:'POST',body:{p_product_id:inventoryRoute[1],p_delta:delta,p_reason:reason,p_admin_reference:admin(req).email}});
          return json(res,200,{product:supabaseProductShape(product),movement:(await supabaseRequest(supabaseTable('inventory_movements',new URLSearchParams({select:'*',product_id:`eq.${inventoryRoute[1]}`,order:'created_at.desc',limit:'1'}).toString())))[0]});
        } catch(error) { if(error.code==='P0002') return json(res,409,{error:'insufficient_stock_or_not_found'}); throw error; }
      }
      if (req.method === 'POST' && path === '/api/admin/products') {
        const b = await readBody(req); const p = normalizeProduct(b);
        if (p.error) return json(res,400,{ error:'invalid_fields' });
        try {
          const skuRows=await supabaseRequest(supabaseTable('products','select=id,sku'));
          if(skuRows.some(row=>row.sku.trim().toUpperCase()===p.sku.toUpperCase())) return json(res,409,{error:'sku_exists'});
          const saved = await supabaseRequest('rpc/save_product', { method:'POST', body:{ p_product_id:null, p_sku:p.sku, p_name:p.name, p_description:p.description, p_category_name:p.category, p_category_slug:slug(p.category), p_brand_name:p.brand, p_brand_slug:p.brand?slug(p.brand):'', p_price:p.price, p_stock_quantity:p.stock, p_image:p.image, p_label:p.label, p_admin_reference:admin(req).email, p_active:p.active } });
          return json(res,201,{ product:supabaseProductShape(saved), id:saved.id });
        } catch(error) { if(error.code==='23505') return json(res,409,{error:'sku_exists'}); throw error; }
      }
      if (req.method === 'POST' && path === '/api/admin/products/import') {
        const b=await readBody(req), rows=Array.isArray(b.products)?b.products:[];
        if(!rows.length||rows.length>500) return json(res,400,{error:'invalid_import_size'});
        const normalized=rows.map((row,index)=>({row:Number(row.row)||index+2,product:normalizeProduct(row)}));
        const seen=new Set(), duplicates=new Set();
        for(const entry of normalized) { const key=entry.product.sku?.toUpperCase(); if(key&&seen.has(key)) duplicates.add(key); if(key) seen.add(key); }
        const requested=[...seen];
        const existing=requested.length?await supabaseRequest(supabaseTable('products','select=sku')):[];
        const existingSkus=new Set((existing||[]).map(row=>row.sku.toUpperCase()));
        const results=[];
        for(const entry of normalized) {
          const {row,product}=entry, sku=product.sku?.toUpperCase();
          if(product.error) { results.push({row,sku:product.sku||'',status:'error',error:'invalid_fields'}); continue; }
          if(duplicates.has(sku)) { results.push({row,sku:product.sku,status:'error',error:'duplicate_in_file'}); continue; }
          if(existingSkus.has(sku)) { results.push({row,sku:product.sku,status:'error',error:'sku_exists'}); continue; }
          try {
            const saved=await supabaseRequest('rpc/save_product',{method:'POST',body:{p_product_id:null,p_sku:product.sku,p_name:product.name,p_description:product.description,p_category_name:product.category,p_category_slug:slug(product.category),p_brand_name:product.brand,p_brand_slug:product.brand?slug(product.brand):'',p_price:product.price,p_stock_quantity:product.stock,p_image:product.image,p_label:product.label,p_admin_reference:admin(req).email,p_active:product.active}});
            existingSkus.add(sku); results.push({row,sku:product.sku,status:'saved',id:saved.id});
          } catch(error) { results.push({row,sku:product.sku,status:'error',error:error.code==='23505'?'sku_exists':'database_error'}); }
        }
        return json(res,200,{results,created:results.filter(result=>result.status==='saved').length,failed:results.filter(result=>result.status==='error').length});
      }
      const productId = path.match(/^\/api\/admin\/products\/([0-9a-f-]{36})$/i);
      const restoreProduct = path.match(/^\/api\/admin\/products\/([0-9a-f-]{36})\/restore$/i);
      if (restoreProduct && req.method === 'PATCH') {
        const rows=await supabaseRequest(supabaseTable('products',`id=eq.${restoreProduct[1]}`),{method:'PATCH',body:{active:false,archived_at:null,updated_at:new Date().toISOString()},prefer:'return=representation'});
        return rows?.length?json(res,200,{message:'restored',product:supabaseProductShape(await supabaseRequest(supabaseTable('products',new URLSearchParams({select:'*,categories(name),brands(name)',id:`eq.${restoreProduct[1]}`,limit:'1'}).toString()))[0])}):json(res,404,{error:'not_found'});
      }
      if (productId && req.method === 'PUT') {
        const b = await readBody(req); const p = normalizeProduct(b);
        if (p.error) return json(res,400,{ error:'invalid_fields' });
        try {
          const skuRows=await supabaseRequest(supabaseTable('products',new URLSearchParams({select:'id,sku'}).toString()));
          if(skuRows.some(row=>row.id!==productId[1]&&row.sku.trim().toUpperCase()===p.sku.toUpperCase())) return json(res,409,{error:'sku_exists'});
          const saved = await supabaseRequest('rpc/save_product', { method:'POST', body:{ p_product_id:productId[1], p_sku:p.sku, p_name:p.name, p_description:p.description, p_category_name:p.category, p_category_slug:slug(p.category), p_brand_name:p.brand, p_brand_slug:p.brand?slug(p.brand):'', p_price:p.price, p_stock_quantity:p.stock, p_image:p.image, p_label:p.label, p_admin_reference:admin(req).email, p_inventory_reason:clean(b.inventoryReason || 'تحديث المنتج من لوحة الإدارة',240), p_active:p.active } });
          return saved ? json(res,200,{ product:supabaseProductShape(saved), message:'updated' }) : json(res,404,{error:'not_found'});
        } catch(error) { if(error.code==='23505') return json(res,409,{error:'sku_exists'}); if(error.code==='P0002') return json(res,404,{error:'not_found'}); throw error; }
      }
      if (productId && req.method === 'DELETE') {
        const result = await supabaseRequest(supabaseTable('products', `id=eq.${productId[1]}`), { method:'PATCH', body:{active:false,archived_at:new Date().toISOString(),updated_at:new Date().toISOString()}, prefer:'return=representation' });
        return result?.length ? json(res,200,{message:'archived'}) : json(res,404,{error:'not_found'});
      }
      const collections = { contacts: 'contact_messages', quotes: 'quote_requests', wholesale: 'wholesale_applications' };
      for (const [name, table] of Object.entries(collections)) if (req.method === 'GET' && path === `/api/admin/${name}`) {
        const items=await supabaseRequest(supabaseTable(table,'select=*&order=created_at.desc'));
        return json(res,200,{items});
      }
      if (req.method==='GET' && path==='/api/admin/orders') {
        const orders=await supabaseRequest(supabaseTable('orders',new URLSearchParams({select:'*,order_items(*)',order:'created_at.desc'}).toString()));
        return json(res,200,{orders});
      }
      if (req.method==='GET' && path==='/api/admin/customers') {
        const customers=await supabaseRequest(supabaseTable('users',new URLSearchParams({select:'id,email,name,phone,role,approved,created_at',order:'created_at.desc'}).toString()));
        return json(res,200,{customers});
      }
      const orderStatusRoute=path.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})\/status$/i);
      if(orderStatusRoute&&req.method==='PATCH') {
        const status=clean((await readBody(req)).status,30);
        if(!['pending','confirmed','processing','shipped','delivered','cancelled'].includes(status)) return json(res,400,{error:'invalid_status'});
        try { const order=await supabaseRequest('rpc/set_order_status',{method:'POST',body:{p_order_id:orderStatusRoute[1],p_status:status,p_admin_reference:admin(req).email}}); if(order?.status==='expired') return json(res,409,{error:'reservation_expired',order}); return json(res,200,{order,message:'updated'}); }
        catch(error) { if(error.code==='P0002') return json(res,404,{error:'not_found'}); if(error.code==='22023') return json(res,409,{error:'invalid_transition'}); if(error.code==='PGRST202'||error.code==='42883') return json(res,503,{error:'order_schema_not_applied'}); throw error; }
      }
      const statusRoute = path.match(/^\/api\/admin\/(contacts|quotes|wholesale)\/([0-9a-f-]{36})\/status$/i);
      if (statusRoute && req.method === 'PATCH') {
        const map = { contacts:['contact_messages',['new','read','closed']], quotes:['quote_requests',['new','reviewing','quoted','closed']], wholesale:['wholesale_applications',['pending','approved','rejected']] };
        const [table, statuses] = map[statusRoute[1]]; const b=await readBody(req); const status=clean(b.status,20);
        if (!statuses.includes(status)) return json(res,400,{ error:'invalid_status' });
        if(statusRoute[1]==='wholesale') {
          try { await supabaseRequest('rpc/set_wholesale_status',{method:'POST',body:{p_application_id:statusRoute[2],p_status:status}}); }
          catch(error) { if(error.code==='P0002') return json(res,404,{error:'not_found'}); throw error; }
        } else {
          const updated=await supabaseRequest(supabaseTable(table,`id=eq.${statusRoute[2]}`),{method:'PATCH',body:{status},prefer:'return=representation'});
          if(!updated?.length) return json(res,404,{error:'not_found'});
        }
        return json(res,200,{ message:'updated' });
      }
      if (req.method === 'GET' && path === '/api/admin/branches') return json(res,200,{ branches:await supabaseRequest(supabaseTable('branches','select=*&order=created_at.asc')) });
      if (req.method === 'POST' && path === '/api/admin/branches') { const b=await readBody(req); const name=clean(b.name,140), address=clean(b.address,350), maps=clean(b.mapsUrl,500); if(!name||!address) return json(res,400,{error:'invalid_fields'}); const rows=await supabaseRequest('branches',{method:'POST',body:{name,address,maps_url:maps},prefer:'return=representation'}); return json(res,201,{branch:rows[0],id:rows[0]?.id}); }
      if (req.method === 'GET' && path === '/api/admin/settings') return json(res,200,{ settings:await supabaseRequest(supabaseTable('site_settings','select=key,value&order=key.asc')) });
      if (req.method === 'PUT' && path === '/api/admin/settings') {
        const b=await readBody(req), entries=Object.entries(b);
        if(entries.some(([key,value])=>!publicSettingKeys.has(key)||typeof value!=='string'||value.length>1000)) return json(res,400,{error:'invalid_setting'});
        if(b.delivery_enabled!==undefined&&!['true','false'].includes(b.delivery_enabled.toLowerCase())) return json(res,400,{error:'invalid_delivery_setting'});
        if(b.delivery_fee!==undefined&&(!/^\d+(\.\d{1,2})?$/.test(b.delivery_fee)||Number(b.delivery_fee)<0)) return json(res,400,{error:'invalid_delivery_fee'});
        const values=Object.fromEntries(entries.map(([key,value])=>[key,clean(value,1000)]));
        const settings=await supabaseRequest('rpc/save_site_settings',{method:'POST',body:{p_settings:values}});
        return json(res,200,{settings,message:'saved'});
      }
      return json(res,404,{ error:'not_found' });
    }
    return json(res,404,{ error:'not_found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (error?.code === 'supabase_not_configured') return json(res,503,{error:'supabase_not_configured'});
    if (error?.code?.startsWith('supabase_')) return json(res,502,{error:'database_unavailable'});
    if (message === 'too_large') return json(res,413,{ error:'request_too_large' });
    if (error?.code === 'image_too_large') return json(res,413,{ error:'image_too_large', maxBytes:productImageMaxBytes });
    if (error?.code === 'image_required') return json(res,400,{ error:'image_required' });
    if (error?.code === 'invalid_image_type' || error?.code === 'invalid_image_upload') return json(res,400,{ error:error.code });
    if (message === 'invalid_json') return json(res,400,{ error:'invalid_json' });
    if (error?.code?.startsWith('storage_')) return json(res,502,{ error:'image_storage_unavailable' });
    console.error('[API] request failed', { method: req.method, path, status: error?.status || 500, code: error?.code || 'internal_error' });
    return json(res,500,{ error:'server_error' });
  }
});

  server.listen(port, process.env.API_HOST || '127.0.0.1', () => {
    console.log(`Dar Al Handasa API listening at http://${process.env.API_HOST || '127.0.0.1'}:${port}`);
    console.info('[API] WhatsApp reservation worker status', { environment: appEnvironment, enabled: reservationWorkerEnabled, scheduled: false, running: false, reason: reservationWorkerDisabledReason });
    if (!reservationWorkerEnabled) return;
    let sweepRunning = false;
    let lastSweepError = '';
    const sweep = async () => {
      if (sweepRunning) return;
      sweepRunning = true;
      reservationWorkerStatus.running = true;
      reservationWorkerStatus.lastRunAt = new Date().toISOString();
      console.info('[API] WhatsApp reservation sweep started');
      try {
        const expiredCount = await supabaseRequest('rpc/expire_whatsapp_reservations', { method: 'POST', body: { p_batch_size: 100 } });
        lastSweepError = '';
        reservationWorkerStatus.lastSuccessAt = new Date().toISOString();
        reservationWorkerStatus.lastErrorCode = null;
        console.info('[API] WhatsApp reservation sweep completed', { expiredCount: Number.isInteger(expiredCount) ? expiredCount : null });
      } catch (error) {
        const code = error?.code || 'unknown';
        reservationWorkerStatus.lastErrorCode = code;
        if (code !== lastSweepError) console.error('[API] WhatsApp reservation sweep failed', { code });
        lastSweepError = code;
      } finally {
        sweepRunning = false;
        reservationWorkerStatus.running = false;
      }
    };
    const initialSweep = setTimeout(sweep, 2000);
    initialSweep.unref?.();
    const sweepTimer = setInterval(sweep, 60_000);
    sweepTimer.unref?.();
    reservationWorkerStatus.scheduled = true;
  });

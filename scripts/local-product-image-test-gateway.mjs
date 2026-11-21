import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readFile, rename, writeFile, unlink, lstat, realpath } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const HOST = '127.0.0.1';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3104;
const GUARD_PORT = 3000;
const BACKEND_PORT = 3103;
const FRONTEND_ORIGIN = 'http://127.0.0.1:4200';
const PRODUCT_NAME = 'TEMPORARY IMAGE WORKFLOW TEST - DO NOT PUBLISH';
const MAX_JSON_BYTES = 100_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + 64 * 1024;
const GATEWAY_LIFETIME_MS = 30 * 60 * 1000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const IMAGE_PATH = new RegExp(`^/api/admin/products/(${UUID})/image$`, 'i');
const PRODUCT_PATH = new RegExp(`^/api/admin/products/(${UUID})$`, 'i');
const IMAGE_URL_PATH = new RegExp(`^/storage/v1/object/public/product-images/products/(${UUID})/(${UUID})\\.(?:jpg|png|webp)$`);
const ALLOWED_CREATE_FIELDS = new Set(['sku','name','description','brand','category','price','stock','image','label','inventoryReason','active']);
const ALLOWED_EDIT_FIELDS = ALLOWED_CREATE_FIELDS;
const STATES = new Set(['ready','creating','bound','image_pending','product_update_pending','uncertain']);

function json(res, status, body) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': FRONTEND_ORIGIN, vary: 'Origin' });
  res.end(JSON.stringify(body));
}

export function requestBuffered({ port, path, method, authorization, contentType = 'application/json', body = Buffer.alloc(0), maxBytes = 2 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: HOST, port, path, method, headers: {
      accept: 'application/json', authorization: authorization || '', origin: FRONTEND_ORIGIN,
      'content-type': contentType, 'content-length': String(body.length)
    }, timeout: 15_000 }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > maxBytes) { request.destroy(new Error('upstream_response_too_large')); return; } chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode || 502, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('timeout', () => request.destroy(new Error('upstream_timeout'))); request.on('error', reject); request.end(body);
  });
}

function streamProxy(req, res, port) {
  const upstream = httpRequest({ hostname: HOST, port, path: req.url, method: req.method, headers: { accept: req.headers.accept || '*/*', authorization: req.headers.authorization || '', origin: FRONTEND_ORIGIN } }, reply => {
    const headers = { ...reply.headers }; delete headers.connection; delete headers['transfer-encoding'];
    res.writeHead(reply.statusCode || 502, headers); reply.pipe(res);
  });
  upstream.on('error', () => json(res, 502, { error: 'test_gateway_upstream_unavailable' })); req.pipe(upstream);
}

async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error(), { code: 'request_too_large' }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function parseJsonBody(buffer) { try { return JSON.parse(buffer.toString('utf8')); } catch { throw Object.assign(new Error(), { code: 'invalid_json' }); } }
function hasOnlyFields(body, allowed) { return body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => allowed.has(key)); }

export async function validateImageMultipart(rawBody, contentType) {
  let fileCount = 0; let fieldCount = 0; let fileSize = 0; let invalid = false; let mime = '';
  const parser = Busboy({ headers: { 'content-type': contentType }, limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 } });
  await new Promise((resolve, reject) => {
    parser.on('file', (field, stream, info) => { fileCount++; mime = String(info.mimeType || '').toLowerCase(); if (field !== 'image' || fileCount !== 1) invalid = true; stream.on('data', chunk => { fileSize += chunk.length; if (fileSize > MAX_IMAGE_BYTES) invalid = true; }); stream.on('limit', () => { invalid = true; }); stream.on('error', reject); });
    parser.on('field', () => { fieldCount++; invalid = true; }); parser.on('filesLimit', () => { invalid = true; }); parser.on('fieldsLimit', () => { invalid = true; }); parser.on('error', reject); parser.on('finish', resolve); Readable.from([rawBody]).pipe(parser);
  });
  if (invalid || fileCount !== 1 || fieldCount !== 0 || fileSize < 1 || !['image/png','image/jpeg','image/webp'].includes(mime)) throw Object.assign(new Error(), { code: 'invalid_image_request' });
}

export function validateCreateBody(body, { products, categories, brands }) {
  if (!hasOnlyFields(body, ALLOWED_CREATE_FIELDS)) return 'unexpected_fields';
  if (typeof body.sku !== 'string' || body.sku !== body.sku.trim() || body.sku !== body.sku.toUpperCase() || !/^IMGTEST-[A-Z0-9][A-Z0-9-]{7,59}$/.test(body.sku)) return 'sku_not_test_scoped';
  if (!Array.isArray(products) || products.some(product => String(product.sku || '').toUpperCase() === body.sku)) return 'sku_already_exists_or_catalog_unavailable';
  if (body.name !== PRODUCT_NAME || body.active !== false || body.stock !== 0 || body.image !== '') return 'test_product_invariants_failed';
  if (typeof body.price !== 'number' || !Number.isFinite(body.price) || body.price < 0) return 'invalid_price';
  if (typeof body.category !== 'string' || !Array.isArray(categories) || !categories.some(item => item.name === body.category && item.active === true)) return 'category_not_active_existing_reference';
  if (typeof body.brand !== 'string' || !Array.isArray(brands) || !brands.some(item => item.name === body.brand && item.active === true)) return 'brand_not_active_existing_reference';
  if (body.inventoryReason !== undefined && body.inventoryReason !== '') return 'inventory_reason_not_allowed';
  return '';
}
export function validateEditBody(body, bound) {
  if (!hasOnlyFields(body, ALLOWED_EDIT_FIELDS)) return 'unexpected_fields';
  for (const field of ['sku','name','description','brand','category','price','stock','image','label','active']) if (body[field] !== bound[field]) return 'test_product_field_change_blocked';
  if (body.active !== false || body.stock !== 0 || (body.inventoryReason !== undefined && body.inventoryReason !== '')) return 'test_product_invariants_failed';
  return '';
}
function decodeJson(response) { try { return JSON.parse(response?.body?.toString('utf8') || ''); } catch { return null; } }
async function readAdminJson(path, authorization, requestFn, guardPort) {
  const response = await requestFn({ port: guardPort, path, method: 'GET', authorization, maxBytes: 8 * 1024 * 1024 });
  if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(), { code: 'admin_read_failed' });
  return decodeJson(response);
}
function productFromCatalog(payload, sku) { return Array.isArray(payload?.products) ? payload.products.filter(item => item?.sku === sku) : null; }
function validBoundProduct(product, body) {
  return product && new RegExp(`^${UUID}$`, 'i').test(product.id || '') && product.sku === body.sku && product.name === PRODUCT_NAME && product.active === false && Number(product.stock) === 0 && product.category === body.category && product.brand === body.brand && Number(product.price) === body.price;
}
function matchesExpectedProduct(product, expected) {
  if (!product || !expected) return false;
  for (const field of ['sku','name','description','brand','category','price','stock','image','label','active']) {
    const actual = ['price','stock'].includes(field) ? Number(product[field]) : (field === 'description' || field === 'label') ? (product[field] || '') : product[field];
    const wanted = ['price','stock'].includes(field) ? Number(expected[field]) : (field === 'description' || field === 'label') ? (expected[field] || '') : expected[field];
    if (actual !== wanted) return false;
  }
  return true;
}
function publicObjectFromImageUrl(value, productId) {
  try { const url = new URL(value); const match = url.pathname.match(IMAGE_URL_PATH); return url.protocol === 'https:' && url.hostname === 'ipegazjnkejasorskdur.supabase.co' && !url.search && !url.hash && match && match[1].toLowerCase() === productId.toLowerCase() ? url.pathname : null; } catch { return null; }
}
async function readExactMissingObjectError(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) return false;
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return false; }
      chunks.push(Buffer.from(value));
    }
  } catch { return false; }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return false; }
  const keys = Object.keys(payload || {}).sort();
  return keys.length === 4 && keys.join(',') === 'code,error,message,statusCode'
    && payload.statusCode === '404'
    && payload.error === 'not_found'
    && payload.message === 'Object not found'
    && payload.code === 'NoSuchKey';
}

export async function headPublicObject(url, fetchFn = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'ipegazjnkejasorskdur.supabase.co' || !publicObjectFromImageUrl(url, parsed.pathname.match(IMAGE_URL_PATH)?.[1] || '')) return 0;
  try {
    const head = await fetchFn(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (head.status === 200) return 200;
    if (![400,404].includes(head.status)) return 0;
    await head.body?.cancel().catch(() => {});

    // Supabase Storage can report a missing public object as HTTP 400 on HEAD.
    // Probe only this exact URL with a one-byte GET and accept absence solely
    // when the bounded JSON body is the canonical NoSuchKey response.
    const probe = await fetchFn(url, { method: 'GET', headers: { range: 'bytes=0-0', accept: 'application/json, image/*' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (probe.status === 200 || probe.status === 206) { await probe.body?.cancel().catch(() => {}); return 200; }
    if (![400,404].includes(probe.status)) { await probe.body?.cancel().catch(() => {}); return 0; }
    return await readExactMissingObjectError(probe) ? 404 : 0;
  } catch { return 0; }
}

export function createMemoryStateStore(initial = null) {
  let value = initial ? structuredClone(initial) : { status: 'ready', sessionId: randomUUID() };
  if (!value.sessionId) value.sessionId = randomUUID();
  let held = false;
  return { async load() { return structuredClone(value); }, async save(next) { value = structuredClone(next); }, async acquire() { if (held) return false; held = true; return true; }, async release() { held = false; }, async isHeld() { return held; }, async initialize() { if (value) return false; value = { status: 'ready', sessionId: randomUUID() }; return true; } };
}

function validatePersistentState(value) {
  if (!value || !STATES.has(value.status) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.sessionId || '') || Object.keys(value).some(k => !['status','sessionId','sku','productId','productName','pending','image','boundFields','createdAt'].includes(k))) return false;
  if (value.status === 'ready') return Object.keys(value).every(k => ['status','sessionId'].includes(k));
  if (typeof value.sku !== 'string' || !/^IMGTEST-[A-Z0-9][A-Z0-9-]{7,59}$/.test(value.sku) || value.productName !== PRODUCT_NAME) return false;
  if (['bound','image_pending','product_update_pending'].includes(value.status) && !new RegExp(`^${UUID}$`, 'i').test(value.productId || '')) return false;
  if (value.status === 'creating') {
    const body = value.pending?.body;
    if (!value.pending || Object.keys(value.pending).some(k => !['body','startedAt'].includes(k)) || !body || Object.keys(body).some(k => !ALLOWED_CREATE_FIELDS.has(k)) || body.sku !== value.sku || body.name !== PRODUCT_NAME || body.active !== false || body.stock !== 0 || body.image !== '' || typeof body.category !== 'string' || typeof body.brand !== 'string') return false;
  }
  if (value.status === 'bound') {
    const fields = value.boundFields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(k => !['description','brand','category','price','stock','image','label'].includes(k)) || typeof fields.brand !== 'string' || typeof fields.category !== 'string' || !Number.isFinite(Number(fields.price)) || Number(fields.stock) !== 0 || typeof fields.image !== 'string' || fields.image !== (value.image || '')) return false;
  }
  if (value.status === 'image_pending' && (!value.pending || Object.keys(value.pending).some(k => !['operation','previousImage','expectedImage','objectPath','startedAt'].includes(k)) || !['replace','remove'].includes(value.pending.operation) || typeof value.pending.previousImage !== 'string')) return false;
  if (value.status === 'product_update_pending' && (typeof value.pending?.expectedImage !== 'string' || !value.pending.expectedFields || typeof value.pending.expectedFields !== 'object' || Array.isArray(value.pending.expectedFields) || Object.keys(value.pending.expectedFields).some(k => !ALLOWED_EDIT_FIELDS.has(k)))) return false;
  if (value.status === 'uncertain' && value.productId !== undefined && !new RegExp(`^${UUID}$`, 'i').test(value.productId)) return false;
  if (value.image !== undefined && typeof value.image !== 'string') return false;
  return true;
}

function normalizedPath(value) { return resolve(value).replace(/[\\/]+$/, '').toLowerCase(); }
function isWithinPath(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..');
}
async function ensureDirectoryTree(directory, trustedRoot, create) {
  const target = resolve(directory); const root = resolve(trustedRoot);
  if (!isWithinPath(root, target)) throw new Error('gateway_state_path_outside_trusted_root');
  const parsed = parse(target); let current = parsed.root;
  const components = target.slice(parsed.root.length).split(sep).filter(Boolean);
  for (const component of components) {
    current = join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw new Error('gateway_state_directory_unavailable');
      try { await mkdir(current); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw new Error('gateway_state_directory_unavailable'); }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('gateway_state_reparse_path_blocked');
    const canonical = await realpath(current);
    if (normalizedPath(canonical) !== normalizedPath(current)) throw new Error('gateway_state_reparse_path_blocked');
  }
  const canonicalRoot = await realpath(root);
  if (!isWithinPath(canonicalRoot, await realpath(target))) throw new Error('gateway_state_reparse_path_blocked');
  return target;
}
async function assertRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('gateway_state_file_invalid');
}

function windowsAcl(path, kind = 'file') {
  if (process.platform !== 'win32') throw new Error('windows_native_state_permissions_required');
  const account = `${process.env.USERDOMAIN || '.'}\\${process.env.USERNAME || ''}`;
  if (account.endsWith('\\')) throw new Error('gateway_state_acl_unavailable');
  const inherit = kind === 'directory' ? ['/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']
    : kind === 'marker-directory' ? ['/inheritance:r', '/remove:g', account, '/remove:d', account, '/grant:r', `${account}:(RX)`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/deny', `${account}:(DC)`]
    : kind === 'marker' ? ['/inheritance:r', '/grant:r', `${account}:(R)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)']
      : ['/inheritance:r', '/grant:r', `${account}:(F)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'];
  const result = spawnSync('icacls.exe', [path, ...inherit], { windowsHide: true, stdio: 'ignore' });
  if (result.error || result.status !== 0) throw new Error('gateway_state_acl_unavailable');
}

function namedMutexScript(mutexName, parentPid) {
  return `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$parentId=${parentPid};$name='${mutexName}';$m=$null;$owned=$false;try{$p=Get-Process -Id $parentId -ErrorAction Stop;$started=$p.StartTime.ToUniversalTime().Ticks;$m=New-Object System.Threading.Mutex($false,$name);try{$owned=$m.WaitOne(0)}catch [System.Threading.AbandonedMutexException]{$owned=$true};if(-not $owned){[Console]::Out.WriteLine('BUSY');exit 3};[Console]::Out.WriteLine('LOCKED');while($true){try{$p=Get-Process -Id $parentId -ErrorAction Stop;if($p.StartTime.ToUniversalTime().Ticks -ne $started){break}}catch{break};Start-Sleep -Milliseconds 150}}catch{[Console]::Error.WriteLine('mutex_helper_failed');exit 4}finally{if($owned){try{$m.ReleaseMutex()}catch{}};if($m){$m.Dispose()}}`;
}
async function acquireWindowsMutex(mutexName) {
  if (process.platform !== 'win32') throw new Error('windows_native_mutex_required');
  const encoded = Buffer.from(namedMutexScript(mutexName, process.pid), 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',encoded], { windowsHide: true, stdio: ['ignore','pipe','ignore'] });
  let output = ''; let settled = false;
  const lock = await new Promise((resolveLock, rejectLock) => {
    const timeout = setTimeout(() => { if (!settled) { settled = true; child.kill(); rejectLock(new Error('gateway_mutex_timeout')); } }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!settled && output.includes('LOCKED')) { settled = true; clearTimeout(timeout); resolveLock(true); }
      else if (!settled && output.includes('BUSY')) { settled = true; clearTimeout(timeout); resolveLock(false); }
    });
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timeout); rejectLock(error); } });
    child.once('close', () => { if (!settled) { settled = true; clearTimeout(timeout); rejectLock(new Error('gateway_mutex_helper_exited')); } });
  });
  return lock ? child : (child.kill(), null);
}

export function createFileStateStore(path, { markerPath = join(dirname(path), '.gateway-state-marker', `${parse(path).name}.initialized`), projectRoot = PROJECT_ROOT, markerRoot = dirname(markerPath) } = {}) {
  const statePath = resolve(path); const initMarkerPath = resolve(markerPath);
  const stateDir = dirname(statePath); const markerDir = dirname(initMarkerPath);
  if (normalizedPath(stateDir) === normalizedPath(markerDir)) throw new Error('gateway_marker_must_use_separate_directory');
  const mutexName = `Local\\DarAlhandsaImageTest-${createHash('sha256').update(normalizedPath(statePath)).digest('hex').slice(0,40)}`;
  let mutexChild = null;
  async function validatePaths(createDirs = false) {
    await ensureDirectoryTree(stateDir, projectRoot, createDirs);
    await ensureDirectoryTree(markerDir, markerRoot, createDirs);
  }
  async function existsAsRegularFile(target) {
    try { await assertRegularFile(target); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function readMarker() {
    await assertRegularFile(initMarkerPath);
    const marker = JSON.parse(await readFile(initMarkerPath, 'utf8'));
    if (marker?.version !== 1 || !/^[0-9a-f-]{36}$/i.test(marker.sessionId || '') || !/^[0-9a-f]{64}$/.test(marker.integrityKey || '') || normalizedPath(marker.statePath || '') !== normalizedPath(statePath)) throw new Error('gateway_marker_corrupt_or_inconsistent');
    return marker;
  }
  async function saveEnvelope(payload, marker, initial = false) {
    const envelope = { payload, mac: createHmac('sha256', Buffer.from(marker.integrityKey, 'hex')).update(JSON.stringify(payload)).digest('hex') };
    if (initial) {
      await writeFile(statePath, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
      windowsAcl(statePath);
      return;
    }
    const temp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 }); windowsAcl(temp);
      await rename(temp, statePath);
      windowsAcl(statePath);
    } finally { await unlink(temp).catch(() => {}); }
  }
  async function load() {
    if (process.platform !== 'win32') throw new Error('windows_native_state_permissions_required');
    await validatePaths(false);
    windowsAcl(stateDir, 'directory');
    if (normalizedPath(markerDir) !== normalizedPath(stateDir)) windowsAcl(markerDir, 'marker-directory');
    const marker = await readMarker(); await assertRegularFile(statePath);
    windowsAcl(initMarkerPath, 'marker');
    const envelope = JSON.parse(await readFile(statePath, 'utf8'));
    if (!envelope?.payload || !/^[0-9a-f]{64}$/.test(envelope.mac || '') || !validatePersistentState(envelope.payload) || envelope.payload.sessionId !== marker.sessionId) throw new Error('gateway_state_corrupt_or_inconsistent');
    const expected = createHmac('sha256', Buffer.from(marker.integrityKey, 'hex')).update(JSON.stringify(envelope.payload)).digest();
    const actual = Buffer.from(envelope.mac, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('gateway_state_integrity_failed');
    return envelope.payload;
  }
  async function save(payload) {
    if (process.platform !== 'win32' || !validatePersistentState(payload)) throw new Error('gateway_state_invalid');
    await validatePaths(false); windowsAcl(stateDir, 'directory'); const marker = await readMarker();
    if (payload.sessionId !== marker.sessionId) throw new Error('gateway_state_session_mismatch');
    await saveEnvelope(payload, marker, false);
  }
  return {
    load, save,
    async initialize() {
      if (process.platform !== 'win32') throw new Error('windows_native_state_permissions_required');
      await validatePaths(true);
      if (!(await this.acquire())) return false;
      try {
        const stateExists = await existsAsRegularFile(statePath); const markerExists = await existsAsRegularFile(initMarkerPath);
        if (stateExists && markerExists) return false;
        if (stateExists || markerExists) throw new Error('gateway_state_initialization_inconsistent_manual_recovery_required');
        windowsAcl(stateDir, 'directory');
        if (normalizedPath(markerDir) !== normalizedPath(stateDir)) windowsAcl(markerDir, 'directory');
        const marker = { version: 1, sessionId: randomUUID(), integrityKey: randomBytes(32).toString('hex'), statePath };
        await writeFile(initMarkerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
        windowsAcl(initMarkerPath, 'marker');
        await saveEnvelope({ status: 'ready', sessionId: marker.sessionId }, marker, true);
        windowsAcl(initMarkerPath, 'marker');
        if (normalizedPath(markerDir) !== normalizedPath(stateDir)) windowsAcl(markerDir, 'marker-directory');
        return true;
      } finally { await this.release(); }
    },
    async acquire() {
      if (process.platform !== 'win32') throw new Error('windows_native_mutex_required');
      if (mutexChild) return false;
      mutexChild = await acquireWindowsMutex(mutexName);
      return Boolean(mutexChild);
    },
    async isHeld() { return Boolean(mutexChild && mutexChild.exitCode === null); },
    async release() {
      if (!mutexChild) return;
      const child = mutexChild; mutexChild = null;
      if (child.exitCode !== null) return;
      await new Promise(resolveExit => { child.once('close', resolveExit); try { child.kill(); } catch { resolveExit(); } });
    }
  };
}

export function createTestGateway({ requestFn = requestBuffered, proxyFn = streamProxy, headObjectFn = headPublicObject, stateStore = createMemoryStateStore(), port = PORT, guardPort = GUARD_PORT, backendPort = BACKEND_PORT, lifetimeMs = GATEWAY_LIFETIME_MS, logger = console } = {}) {
  let state = null; let expired = false; let draining = false; let failClosed = false; let inFlightRequests = 0; let lockReleased = false; let writes = 0; let writeBusy = false; let startedAt = 0; let expiry = null; const loginAttempts = [];
  async function setState(next) {
    const value = { ...next, sessionId: state?.sessionId || next.sessionId };
    try {
      if (stateStore.isHeld && !(await stateStore.isHeld())) throw new Error('gateway_mutex_lost');
      await stateStore.save(value); state = value;
    } catch (error) { failClosed = true; throw error; }
  }
  async function releaseLockIfIdle() {
    if (!draining || inFlightRequests !== 0 || lockReleased) return;
    lockReleased = true;
    await stateStore.release();
  }
  function beginDrain() {
    if (draining) return;
    draining = true; expired = true;
    if (server.listening) server.close(() => { void releaseLockIfIdle(); });
    void releaseLockIfIdle();
  }
  async function verifyProduct(authorization) {
    const data = await readAdminJson('/api/admin/products', authorization, requestFn, guardPort);
    const rows = productFromCatalog(data, state.sku);
    if (!rows) throw new Error('catalog_response_uninspectable');
    return rows;
  }
  async function reconcile(authorization) {
    if (state.status === 'ready' || state.status === 'bound') return true;
    if (state.status === 'uncertain') return false;
    if (state.status === 'creating') {
      const rows = await verifyProduct(authorization);
      if (rows.length !== 1 || !validBoundProduct(rows[0], state.pending.body)) { await setState({ ...state, status: 'uncertain' }); return false; }
      const product = rows[0];
      await setState({ status: 'bound', sku: state.sku, productId: product.id, productName: PRODUCT_NAME, image: product.image || '', boundFields: { description: product.description || '', brand: product.brand, category: product.category, price: Number(product.price), stock: 0, image: product.image || '', label: product.label || '' } }); return false;
    }
    if (state.status === 'image_pending' || state.status === 'product_update_pending') {
      const rows = await verifyProduct(authorization);
      if (rows.length !== 1 || rows[0].id !== state.productId) { await setState({ ...state, status: 'uncertain' }); return false; }
      const product = rows[0]; const pending = state.pending;
      let outcome = product.image === pending.expectedImage;
      if (pending.expectedFields) outcome &&= matchesExpectedProduct(product, pending.expectedFields);
      if (pending.objectPath && pending.expectedImage) outcome &&= await headObjectFn(pending.expectedImage) === 200;
      if (pending.previousImage && pending.previousImage !== pending.expectedImage && ['replace','remove'].includes(pending.operation)) outcome &&= await headObjectFn(pending.previousImage) === 404;
      if (!outcome) { await setState({ ...state, status: 'uncertain' }); return false; }
      await setState({ status: 'bound', sku: state.sku, productId: state.productId, productName: PRODUCT_NAME, image: product.image || '', boundFields: { description: product.description || '', brand: product.brand, category: product.category, price: Number(product.price), stock: 0, image: product.image || '', label: product.label || '' } }); return false;
    }
    return false;
  }
  const server = createServer(async (req, res) => {
    inFlightRequests++;
    try {
    if (!state || expired) return json(res, expired ? 410 : 503, { error: expired ? 'test_gateway_expired' : 'test_gateway_state_unavailable' });
    if (failClosed || (stateStore.isHeld && !(await stateStore.isHeld()))) { failClosed = true; beginDrain(); return json(res, 503, { error: 'test_gateway_lock_or_state_unavailable' }); }
    const expectedHost = `127.0.0.1:${server.address()?.port || port}`;
    if (req.headers.host !== expectedHost) return json(res, 403, { error: 'test_gateway_host_blocked' });
    if (req.headers.origin !== FRONTEND_ORIGIN) return json(res, 403, { error: 'test_gateway_origin_blocked' });
    if (req.method === 'OPTIONS') {
      if (req.headers['access-control-request-method'] && !['GET','POST','PUT','DELETE'].includes(req.headers['access-control-request-method'])) return json(res, 403, { error: 'test_gateway_preflight_blocked' });
      const requestedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
      if (requestedHeaders.some(x => !['authorization','content-type'].includes(x))) return json(res, 403, { error: 'test_gateway_preflight_blocked' });
      res.writeHead(204, { 'access-control-allow-origin': FRONTEND_ORIGIN, 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type', vary: 'Origin' }); return res.end();
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/')) return proxyFn(req, res, guardPort);
    if (req.method === 'POST' && req.url === '/api/admin/login') {
      const now = Date.now(); while (loginAttempts.length && loginAttempts[0] < now - 5 * 60_000) loginAttempts.shift();
      if (loginAttempts.length >= 5) return json(res, 429, { error: 'login_rate_limited' });
      loginAttempts.push(now);
      try {
        const type = String(req.headers['content-type'] || '');
        if (!type.toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'invalid_login_request' });
        const body = await readBody(req, 16 * 1024);
        const result = await requestFn({ port: guardPort, path: req.url, method: 'POST', contentType: type, body, maxBytes: 64 * 1024 });
        res.writeHead(result.status, { 'content-type': result.headers['content-type'] || 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': FRONTEND_ORIGIN, vary: 'Origin' });
        return res.end(result.body);
      } catch (error) { return json(res, error?.code === 'request_too_large' ? 413 : 502, { error: error?.code === 'request_too_large' ? 'request_too_large' : 'test_gateway_upstream_unavailable' }); }
    }
    if (Date.now() - startedAt >= lifetimeMs) { beginDrain(); return json(res, 410, { error: 'test_gateway_expired' }); }
    if (writeBusy) return json(res, 409, { error: 'test_gateway_write_in_progress' });
    if (state.status === 'uncertain') return json(res, 423, { error: 'test_gateway_uncertain_read_only_reconciliation_required' });
    const authorization = req.headers.authorization || '';
    if (!/^Bearer\s+\S+$/i.test(authorization)) return json(res, 401, { error: 'admin_auth_required' });
    if (writes >= 20) return json(res, 429, { error: 'test_gateway_write_limit' });
    writeBusy = true;
    try {
      if (state.status !== 'ready' && state.status !== 'bound') { const mayWrite = await reconcile(authorization); if (!mayWrite) return json(res, 423, { error: 'test_gateway_state_reconciled_retry_read_only' }); }
      if (req.method === 'POST' && req.url === '/api/admin/products') {
        if (state.status !== 'ready') return json(res, 403, { error: 'one_test_product_only' });
        const raw = await readBody(req, MAX_JSON_BYTES); const body = parseJsonBody(raw);
        const [productsData, categoryData, brandData] = await Promise.all([readAdminJson('/api/admin/products', authorization, requestFn, guardPort), readAdminJson('/api/admin/categories', authorization, requestFn, guardPort), readAdminJson('/api/admin/brands', authorization, requestFn, guardPort)]);
        const invalid = validateCreateBody(body, { products: productsData?.products, categories: categoryData?.categories, brands: brandData?.brands });
        if (invalid) return json(res, 403, { error: 'test_gateway_write_blocked', reason: invalid });
        await setState({ status: 'creating', sku: body.sku, productName: PRODUCT_NAME, pending: { body, startedAt: Date.now() } });
        writes++;
        let response; try { response = await requestFn({ port: backendPort, path: req.url, method: 'POST', authorization, contentType: 'application/json', body: raw }); } catch {}
        const returnedProductId = decodeJson(response)?.product?.id || decodeJson(response)?.id || null;
        const rows = await verifyProduct(authorization).catch(() => null);
        if (Array.isArray(rows) && rows.length === 1 && validBoundProduct(rows[0], body) && (!returnedProductId || returnedProductId === rows[0].id)) {
          const product = rows[0]; await setState({ status: 'bound', sku: body.sku, productId: product.id, productName: PRODUCT_NAME, image: product.image || '', boundFields: { description: product.description || '', brand: product.brand, category: product.category, price: Number(product.price), stock: 0, image: product.image || '', label: product.label || '' } });
          if (response && response.status >= 200 && response.status < 300) { res.writeHead(response.status, { 'content-type': response.headers['content-type'] || 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': FRONTEND_ORIGIN, vary: 'Origin' }); return res.end(response.body); }
          return json(res, 409, { error: 'test_product_created_reconciled', productId: product.id });
        }
        await setState({ status: 'uncertain', sku: body.sku, productName: PRODUCT_NAME, pending: { operation: 'create', startedAt: Date.now() } });
        return json(res, 502, { error: 'test_product_creation_uncertain_manual_reconciliation_required' });
      }
      const bound = state.status === 'bound' ? { sku: state.sku, name: PRODUCT_NAME, ...state.boundFields, stock: 0, active: false, image: state.image || '' } : null;
      const imageMatch = req.url?.match(IMAGE_PATH); const productMatch = req.url?.match(PRODUCT_PATH);
      if (imageMatch && imageMatch[1].toLowerCase() === state.productId?.toLowerCase() && ['POST','DELETE'].includes(req.method)) {
        const oldImage = state.image || '';
        let raw = Buffer.alloc(0); let contentType = String(req.headers['content-type'] || 'application/json'); let operation = req.method === 'POST' ? 'replace' : 'remove';
        if (req.method === 'POST') { if (!contentType.toLowerCase().startsWith('multipart/form-data;')) return json(res, 415, { error: 'invalid_image_request' }); raw = await readBody(req, MAX_MULTIPART_BYTES); await validateImageMultipart(raw, contentType); }
        else { raw = await readBody(req, 0); if (raw.length) return json(res, 400, { error: 'unexpected_delete_body' }); }
        // Since the eventual object URL is returned by the upstream, persist intent before the write.
        await setState({ status: 'image_pending', sku: state.sku, productId: state.productId, productName: PRODUCT_NAME, image: oldImage, pending: { operation, previousImage: oldImage, expectedImage: req.method === 'DELETE' ? '' : null, startedAt: Date.now() } });
        writes++;
        let response; try { response = await requestFn({ port: backendPort, path: req.url, method: req.method, authorization, contentType, body: raw }); } catch {}
        const rows = await verifyProduct(authorization).catch(() => null); const product = Array.isArray(rows) && rows.length === 1 ? rows[0] : null; const parsed = decodeJson(response);
        let valid = false;
        if (product && product.id === state.productId) {
          if (req.method === 'DELETE') valid = product.image === '' && parsed?.image === '' && (!oldImage || await headObjectFn(oldImage) === 404);
          else valid = typeof parsed?.image === 'string' && publicObjectFromImageUrl(parsed.image, state.productId) && product.image === parsed.image && await headObjectFn(parsed.image) === 200 && (!oldImage || oldImage === parsed.image || await headObjectFn(oldImage) === 404);
        }
        if (!valid || !response || response.status < 200 || response.status >= 300) { await setState({ status: 'uncertain', sku: state.sku, productId: state.productId, productName: PRODUCT_NAME, image: oldImage, pending: { operation, previousImage: oldImage, startedAt: Date.now() } }); return json(res, 502, { error: 'test_image_operation_uncertain_manual_reconciliation_required' }); }
        await setState({ status: 'bound', sku: state.sku, productId: state.productId, productName: PRODUCT_NAME, image: product.image || '', boundFields: { description: product.description || '', brand: product.brand, category: product.category, price: Number(product.price), stock: 0, image: product.image || '', label: product.label || '' } });
        res.writeHead(response.status, { 'content-type': response.headers['content-type'] || 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': FRONTEND_ORIGIN, vary: 'Origin' }); return res.end(response.body);
      }
      if (req.method === 'PUT' && productMatch && productMatch[1].toLowerCase() === state.productId?.toLowerCase() && bound) {
        const raw = await readBody(req, MAX_JSON_BYTES); const body = parseJsonBody(raw); const invalid = validateEditBody(body, bound);
        if (invalid) return json(res, 403, { error: 'test_gateway_write_blocked', reason: invalid });
        const expectedFields = Object.fromEntries(['sku','name','description','brand','category','price','stock','image','label','active'].map(field => [field, body[field]]));
        await setState({ status: 'product_update_pending', sku: state.sku, productId: state.productId, productName: PRODUCT_NAME, image: state.image || '', pending: { expectedImage: state.image || '', expectedFields, startedAt: Date.now() } }); writes++;
        const response = await requestFn({ port: backendPort, path: req.url, method: 'PUT', authorization, contentType: 'application/json', body: raw });
        const rows = await verifyProduct(authorization).catch(() => null);
        if (!response || response.status < 200 || response.status >= 300 || !Array.isArray(rows) || rows.length !== 1 || rows[0].id !== state.productId || !matchesExpectedProduct(rows[0], expectedFields)) { await setState({ status: 'uncertain', sku: state.sku, productId: state.productId, productName: PRODUCT_NAME, image: state.image || '', pending: { operation: 'update', startedAt: Date.now() } }); return json(res, 502, { error: 'test_product_update_uncertain_manual_reconciliation_required' }); }
        await setState({ status: 'bound', sku: state.sku, productId: state.productId, productName: PRODUCT_NAME, image: state.image || '', boundFields: { description: body.description || '', brand: body.brand, category: body.category, price: body.price, stock: 0, image: state.image || '', label: body.label || '' } });
        res.writeHead(response.status, { 'content-type': response.headers['content-type'] || 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': FRONTEND_ORIGIN, vary: 'Origin' }); return res.end(response.body);
      }
      return json(res, 403, { error: 'test_gateway_write_blocked' });
    } catch (error) {
      const code = error?.code === 'request_too_large' ? 'request_too_large' : error?.code === 'invalid_json' ? 'invalid_json' : error?.code === 'invalid_image_request' ? 'invalid_image_request' : 'test_gateway_preflight_failed';
      logger.warn('[image test gateway] Request refused safely', { code }); return json(res, code === 'request_too_large' ? 413 : code === 'invalid_json' ? 400 : 403, { error: code });
    } finally { writeBusy = false; }
    } finally {
      inFlightRequests--;
      await releaseLockIfIdle();
    }
  });
  return { server, async start() {
    if (draining || expired) throw new Error('gateway_runtime_expired');
    if (!(await stateStore.acquire())) throw new Error('gateway_state_lock_exists');
    lockReleased = false;
    try { state = await stateStore.load(); }
    catch { await stateStore.release(); lockReleased = true; throw new Error('gateway_state_missing_or_corrupt'); }
    if (!state || !STATES.has(state.status)) { await stateStore.release(); lockReleased = true; throw new Error('gateway_state_missing_or_corrupt'); }
    startedAt = Date.now(); expiry = setTimeout(() => { beginDrain(); logger.info('[image test gateway] Short-lived listener expired.'); }, lifetimeMs); expiry.unref();
    return state;
  }, close: async () => { if (expiry) clearTimeout(expiry); if (!draining) { draining = true; expired = true; } if (server.listening) await new Promise(resolveClose => server.close(() => resolveClose())); await releaseLockIfIdle(); }, state: () => state ? structuredClone(state) : null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const statePath = resolve(root, '.product-image-test-run', 'phase2.1-safety', 'gateway-state.json');
  const localAppData = process.env.LOCALAPPDATA;
  const markerId = createHash('sha256').update(normalizedPath(root)).digest('hex').slice(0,32);
  const markerPath = localAppData ? join(localAppData, 'DarAlhandsa-ProductImageTest', `${markerId}.marker`) : '';
  const makeStateStore = () => {
    if (!markerPath) throw new Error('gateway_marker_location_unavailable');
    return createFileStateStore(statePath, { markerPath, projectRoot: root, markerRoot: localAppData });
  };
  if (resolve(process.cwd()) !== root) { console.error('Temporary gateway refused: start it from A:\\DarAlhandsa.'); process.exitCode = 2; }
  else if (process.argv.includes('--initialize')) {
    let store; try { store = makeStateStore(); } catch { console.error('State initialization refused: protected marker storage is unavailable.'); process.exitCode = 1; }
    if (store) store.initialize().then(ok => { console.info(ok ? 'Local gateway runtime state initialized once.' : 'State already exists; refusing to reset it.'); process.exitCode = ok ? 0 : 2; }).catch(error => { console.error(`State initialization failed safely: ${error?.message === 'gateway_state_initialization_inconsistent_manual_recovery_required' ? 'manual_recovery_required' : 'marker_or_state_check_failed'}.`); process.exitCode = 1; });
  } else {
    let gateway; try { gateway = createTestGateway({ stateStore: makeStateStore() }); } catch { console.error('Temporary gateway refused: protected marker storage is unavailable.'); process.exitCode = 1; }
    if (!gateway) process.exitCode = 1;
    else
    gateway.start().then(() => {
      gateway.server.on('error', error => { console.error('[image test gateway] Could not start:', error.code || 'listen_failed'); process.exitCode = 1; });
      gateway.server.listen(PORT, HOST, () => console.info(`Temporary product-image test gateway listening at http://${HOST}:${PORT}; reads remain through the read-only guard.`));
    }).catch(() => { console.error('Temporary gateway refused: missing, locked, or invalid runtime state.'); process.exitCode = 1; });
    process.once('SIGINT', () => gateway.close().finally(() => process.exit())); process.once('SIGTERM', () => gateway.close().finally(() => process.exit()));
  }
}

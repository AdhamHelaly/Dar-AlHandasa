import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env.staging');
const productionRef = 'ipegazjnkejasorskdur';

function readEnvFile(path) {
  if (!existsSync(path)) throw new Error('Missing .env.staging. Copy .env.staging.example and configure a dedicated staging project first.');
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const env = readEnvFile(envPath);
const suite = process.argv.find(value => value.startsWith('--suite='))?.slice('--suite='.length);
assert(['checkout', 'expiration', 'all'].includes(suite), 'Choose --suite=checkout, --suite=expiration, or --suite=all.');
assert(process.argv.includes('--confirm-staging-writes'), 'This suite creates and cancels test orders. Add --confirm-staging-writes to proceed.');
assert(env.APP_ENV === 'staging', '.env.staging must set APP_ENV=staging.');
const stagingRef = env.STAGING_SUPABASE_PROJECT_REF || '';
assert(/^[a-z0-9]{20}$/.test(stagingRef), 'Set STAGING_SUPABASE_PROJECT_REF to the separate staging project ref.');
assert(stagingRef !== productionRef, 'Production project ref is blocked by this test script.');
let configuredRef = '';
try {
  const supabaseUrl = new URL(env.SUPABASE_URL);
  configuredRef = supabaseUrl.hostname.endsWith('.supabase.co') ? supabaseUrl.hostname.split('.')[0] : '';
} catch { /* Configuration is reported below without showing credential values. */ }
assert(configuredRef === stagingRef, 'SUPABASE_URL does not match STAGING_SUPABASE_PROJECT_REF.');
assert(env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_SERVICE_ROLE_KEY.length >= 20 && !/replace-with|your[-_ ]/i.test(env.SUPABASE_SERVICE_ROLE_KEY), 'Configure a dedicated staging service key in .env.staging.');
assert(env.SESSION_SECRET && env.SESSION_SECRET.length >= 32 && !/replace-with|your[-_ ]/i.test(env.SESSION_SECRET), 'Configure a unique staging SESSION_SECRET.');
assert(env.ADMIN_EMAIL && env.ADMIN_PASSWORD && !/example\.invalid|replace-with/i.test(`${env.ADMIN_EMAIL} ${env.ADMIN_PASSWORD}`), 'Configure staging admin credentials in .env.staging.');
assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.STAGING_TEST_PRODUCT_ID || '') && !/^00000000-0000-4000-8000-000000000000$/i.test(env.STAGING_TEST_PRODUCT_ID), 'Set STAGING_TEST_PRODUCT_ID to a disposable active staging product.');
const apiUrl = new URL(env.STAGING_API_URL || 'http://127.0.0.1:3000/api');
assert(['127.0.0.1', 'localhost', '::1'].includes(apiUrl.hostname), 'Staging test API must be a loopback address; remote and production API hosts are blocked.');
const apiBase = apiUrl.href.replace(/\/+$/, '');
const productId = env.STAGING_TEST_PRODUCT_ID;
const runId = randomUUID();
const fakePhone = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
const customer = {
  name: `Staging order ${runId.slice(0, 8)}`,
  email: `order-${runId}@example.invalid`,
  phone: `0000${fakePhone}`,
  governorate: 'Staging only',
  city: 'Staging only',
  address: `Disposable staging fixture ${runId}`
};
let adminToken = '';
const createdOrderIds = new Set();

async function request(path, { method = 'GET', body, token = adminToken } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  let data = null;
  try { data = await response.json(); } catch { /* Return status only; never log server bodies. */ }
  return { status: response.status, data };
}

function pass(message) { console.log(`PASS ${message}`); }

async function verifyTargetAndLogin(requireWorker) {
  const health = await request('/health', { token: '' });
  assert(health.status === 200 && health.data?.status === 'ok', 'Staging API health check failed; no order was created.');
  assert(health.data.environment === 'staging' && health.data.supabaseProjectRef === stagingRef, 'API is not connected to the configured staging project; no order was created.');
  if (requireWorker) assert(health.data.reservationWorker?.enabled && health.data.reservationWorker?.scheduled, 'Staging expiry suite requires the worker enabled and scheduled; no order was created.');
  const login = await request('/admin/login', { method: 'POST', token: '', body: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } });
  assert(login.status === 200 && login.data?.token, 'Staging admin login failed; no order was created.');
  adminToken = login.data.token;
  pass(`API health and staging target ${stagingRef} verified${requireWorker ? ' with expiry worker scheduled' : ''}`);
}

async function loadProduct() {
  const result = await request('/admin/products');
  assert(result.status === 200 && Array.isArray(result.data?.products), 'Could not read staging fixture product.');
  const product = result.data.products.find(row => row.id === productId);
  assert(product?.active && Number.isSafeInteger(Number(product.stock)), 'Staging fixture must be active and have an integer stock balance.');
  return product;
}

async function loadMovements() {
  const result = await request(`/admin/products/${productId}/inventory`);
  assert(result.status === 200 && Array.isArray(result.data?.movements), 'Could not read staging fixture inventory movements.');
  return result.data.movements;
}

async function createOrder(method, quantity, idempotencyKey, overrides = {}) {
  const result = await request('/orders', {
    method: 'POST', token: '',
    body: { ...customer, method, items: [{ id: productId, quantity }], idempotencyKey, ...overrides }
  });
  if (result.data?.orderId) createdOrderIds.add(result.data.orderId);
  return result;
}

async function cancelOrder(orderId) {
  const result = await request(`/admin/orders/${orderId}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
  assert(result.status === 200, `Could not cancel staging order ${orderId.slice(0, 8)} for cleanup.`);
}

async function getOrder(orderId) {
  const result = await request('/admin/orders');
  assert(result.status === 200 && Array.isArray(result.data?.orders), 'Could not read staging orders.');
  return result.data.orders.find(order => order.id === orderId);
}

async function runCheckoutSuite() {
  const baseline = await loadProduct();
  assert(Number(baseline.stock) >= 1, 'Staging fixture needs at least one unit of stock.');

  const beforeWebsiteMovements = await loadMovements();
  const websiteKey = randomUUID();
  const website = await createOrder('website', 1, websiteKey, { items: [{ id: productId, quantity: 1, price: 0.01 }] });
  assert(website.status === 201 && website.data?.orderId, 'Website checkout did not create one staging order.');
  assert(Number(website.data.items?.[0]?.price) === Number(baseline.price), 'Submitted frontend price was trusted instead of the staging database price.');
  const websiteRetry = await createOrder('website', 1, websiteKey);
  assert(websiteRetry.status === 200 && websiteRetry.data?.orderId === website.data.orderId && websiteRetry.data?.replayed === true, 'Website retry did not replay the same order.');
  const conflict = await createOrder('website', 1, websiteKey, { address: `${customer.address} changed` });
  assert(conflict.status === 409 && conflict.data?.error === 'idempotency_conflict', 'Changed payload with same key was not rejected.');
  assert(Number((await loadProduct()).stock) === Number(baseline.stock) - 1, 'Website order did not deduct exactly one unit.');
  assert((await loadMovements()).length === beforeWebsiteMovements.length + 1, 'Website replay caused an unexpected stock movement.');
  const websiteOrder = await getOrder(website.data.orderId);
  assert(websiteOrder?.status === 'pending', 'Website order did not remain pending before cancellation.');
  await cancelOrder(website.data.orderId);
  await cancelOrder(website.data.orderId);
  assert(Number((await loadProduct()).stock) === Number(baseline.stock), 'Repeated cancellation did not restore stock exactly once.');
  assert((await loadMovements()).length === beforeWebsiteMovements.length + 2, 'Cancellation/replay inventory movement count is incorrect.');
  pass('website checkout, idempotent retry, payload conflict, stock deduction, cancellation, and one-time restoration');

  const beforeWhatsAppMovements = await loadMovements();
  const whatsappKey = randomUUID();
  const firstWhatsAppAttempts = await Promise.all([1, 2, 3].map(() => createOrder('whatsapp', 1, whatsappKey)));
  const whatsapp = firstWhatsAppAttempts.find(result => result.status === 201);
  assert(whatsapp?.data?.orderId && whatsapp.data?.whatsappUrl && whatsapp.data?.reservationExpiresAt, 'Concurrent WhatsApp checkout did not return its initial order, link, and expiry.');
  assert(firstWhatsAppAttempts.filter(result => result.status === 201).length === 1 && firstWhatsAppAttempts.every(result => [200, 201].includes(result.status) && result.data?.orderId === whatsapp.data.orderId && result.data?.whatsappUrl === whatsapp.data.whatsappUrl), 'Concurrent same-key WhatsApp submissions created inconsistent orders or messages.');
  assert(Number((await loadProduct()).stock) === Number(baseline.stock) - 1, 'WhatsApp retries reserved more than one unit.');
  assert((await loadMovements()).length === beforeWhatsAppMovements.length + 1, 'WhatsApp retries created more than one stock movement.');
  await cancelOrder(whatsapp.data.orderId);
  await cancelOrder(whatsapp.data.orderId);
  assert(Number((await loadProduct()).stock) === Number(baseline.stock), 'WhatsApp cancellation did not restore the fixture stock exactly once.');
  assert((await loadMovements()).length === beforeWhatsAppMovements.length + 2, 'WhatsApp cancellation movement count is incorrect.');
  pass('WhatsApp retries preserve the same order and prepared link; repeated reservation/cancellation restores once');

  const stockBeforeRace = Number((await loadProduct()).stock);
  const quantity = Math.floor(stockBeforeRace / 2) + 1;
  const raced = await Promise.all([
    createOrder('website', quantity, randomUUID()),
    createOrder('website', quantity, randomUUID())
  ]);
  const winners = raced.filter(result => result.status === 201 && result.data?.orderId);
  const rejected = raced.filter(result => result.status === 409 && result.data?.error === 'insufficient_stock');
  assert(winners.length === 1 && rejected.length === 1, 'Concurrent distinct orders did not yield one stock-safe winner and one insufficient-stock response.');
  assert(Number((await loadProduct()).stock) === stockBeforeRace - quantity, 'Concurrent stock deduction was not atomic.');
  await cancelOrder(winners[0].data.orderId);
  assert(Number((await loadProduct()).stock) === stockBeforeRace, 'Concurrent order cleanup did not restore staging stock.');
  pass('concurrent distinct requests are serialized against staging stock');
}

async function runExpirationSuite() {
  const health = await request('/health', { token: '' });
  assert(health.data?.reservationWorker?.enabled && health.data?.reservationWorker?.scheduled, 'The isolated staging expiry worker must be enabled and scheduled before creating an expiring reservation.');
  const baseline = await loadProduct();
  assert(Number(baseline.stock) >= 1, 'Staging fixture needs at least one unit of stock.');
  const beforeMovements = await loadMovements();
  const key = randomUUID();
  const order = await createOrder('whatsapp', 1, key);
  assert(order.status === 201 && order.data?.orderId && order.data?.reservationExpiresAt, 'Could not create staging expiry fixture.');
  const replay = await createOrder('whatsapp', 1, key);
  assert(replay.status === 200 && replay.data?.orderId === order.data.orderId, 'Expiry fixture retry changed the order ID.');
  assert(Number((await loadProduct()).stock) === Number(baseline.stock) - 1, 'Expiry fixture deducted stock more than once.');
  const expiresAt = Date.parse(order.data.reservationExpiresAt);
  assert(Number.isFinite(expiresAt), 'Reservation expiry timestamp is invalid.');
  pass('staging WhatsApp reservation created; waiting for its real 30-minute expiry and scheduled worker');

  const deadline = expiresAt + 6 * 60_000;
  let expiredOrder = null;
  while (Date.now() < deadline) {
    const wait = Math.min(15_000, Math.max(1000, expiresAt + 15_000 - Date.now()));
    await new Promise(resolveWait => setTimeout(resolveWait, wait));
    expiredOrder = await getOrder(order.data.orderId);
    if (expiredOrder?.status === 'expired') break;
  }
  if (expiredOrder?.status !== 'expired') {
    await cancelOrder(order.data.orderId).catch(() => {});
    throw new Error('Staging worker did not expire the reservation within six minutes after its deadline; cleanup was attempted only in staging.');
  }
  assert(Number((await loadProduct()).stock) === Number(baseline.stock), 'Expiry did not restore staging stock to its starting quantity.');
  const movements = await loadMovements();
  const expirationMovements = movements.filter(row => row.admin_reference === `order:${order.data.orderId}` && String(row.reason).includes('انتهاء مهلة'));
  assert(expirationMovements.length === 1, 'Expiration did not create exactly one restoration movement.');
  const afterExpiryRetry = await createOrder('whatsapp', 1, key);
  assert(afterExpiryRetry.status === 409 && afterExpiryRetry.data?.error === 'reservation_expired', 'Retry after expiry did not safely report the expired reservation.');
  assert(Number((await loadProduct()).stock) === Number(baseline.stock), 'Retry after expiry changed staging stock.');
  assert((await loadMovements()).filter(row => row.admin_reference === `order:${order.data.orderId}` && String(row.reason).includes('انتهاء مهلة')).length === 1, 'Repeated expiry caused duplicate restoration.');
  const newAttempt = await createOrder('whatsapp', 1, randomUUID());
  assert(newAttempt.status === 201 && newAttempt.data?.orderId && newAttempt.data.orderId !== order.data.orderId, 'A genuinely new attempt after server-confirmed expiry did not receive a new order ID.');
  await cancelOrder(newAttempt.data.orderId);
  assert(Number((await loadProduct()).stock) === Number(baseline.stock), 'New attempt staging cleanup did not restore stock.');
  pass('scheduled expiry restores staging stock once; retries after expiry do not reserve again');
}

async function cleanupPendingOrders() {
  for (const orderId of createdOrderIds) {
    const order = await getOrder(orderId).catch(() => null);
    if (order?.status === 'pending') await cancelOrder(orderId).catch(() => {});
  }
}

try {
  await verifyTargetAndLogin(suite === 'expiration');
  if (suite === 'checkout' || suite === 'all') await runCheckoutSuite();
  if (suite === 'expiration' || suite === 'all') await runExpirationSuite();
  console.log('Staging order suite completed. No production API or project was targeted.');
} finally {
  await cleanupPendingOrders();
  adminToken = '';
}

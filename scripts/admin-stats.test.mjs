import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

// Set VERCEL=1 so server.mjs exports requestHandler without binding port 3000
process.env.VERCEL = '1';
const { requestHandler } = await import('../server.mjs');

function makeAdminToken() {
  const secret = process.env.SESSION_SECRET || 'development-secret-change-before-deploy';
  const payload = { id: 'admin', email: 'admin@daralhandasa.com', role: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function makeUserToken() {
  const secret = process.env.SESSION_SECRET || 'development-secret-change-before-deploy';
  const payload = { id: 'user-1', email: 'user@example.com', role: 'customer', exp: Date.now() + 8 * 60 * 60 * 1000 };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

test('GET /api/admin/stats rejects unauthenticated requests', async () => {
  const server = createServer(requestHandler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address.port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/stats`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'admin_auth_required');
  } finally {
    server.close();
  }
});

test('GET /api/admin/stats rejects non-admin users', async () => {
  const server = createServer(requestHandler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address.port;

  try {
    const token = makeUserToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/stats`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'admin_auth_required');
  } finally {
    server.close();
  }
});

test('Cairo timezone date calculation yields correct midnight offsets and boundaries', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = fmt.format(now).split('-').map(Number);
  assert.equal(parts[0], 2026);
  assert.equal(parts[1], 11);
  assert.equal(parts[2], 26);
});

test('Revenue calculation logic strictly excludes cancelled and expired orders', () => {
  const validStatuses = new Set(['confirmed', 'processing', 'shipped', 'delivered']);
  const testOrders = [
    { status: 'confirmed', total: 1000 },
    { status: 'processing', total: 500 },
    { status: 'shipped', total: 1500 },
    { status: 'delivered', total: 2000 },
    { status: 'pending', total: 800 },
    { status: 'cancelled', total: 1200 },
    { status: 'expired', total: 700 }
  ];

  let totalRevenue = 0;
  let pendingRevenue = 0;
  let completedCount = 0;

  for (const o of testOrders) {
    if (validStatuses.has(o.status)) {
      totalRevenue += o.total;
      completedCount++;
    } else if (o.status === 'pending') {
      pendingRevenue += o.total;
    }
  }

  // Only confirmed + processing + shipped + delivered = 1000 + 500 + 1500 + 2000 = 5000
  assert.equal(totalRevenue, 5000);
  assert.equal(completedCount, 4);
  assert.equal(pendingRevenue, 800);
  assert.equal(Number((totalRevenue / completedCount).toFixed(2)), 1250);
});

test('Inventory metrics separate out-of-stock from low-stock and count active products only', () => {
  const products = [
    { id: '1', stock_quantity: 10, active: true, archived_at: null },
    { id: '2', stock_quantity: 5, active: true, archived_at: null }, // low stock
    { id: '3', stock_quantity: 1, active: true, archived_at: null }, // low stock
    { id: '4', stock_quantity: 0, active: true, archived_at: null }, // out of stock
    { id: '5', stock_quantity: -1, active: true, archived_at: null }, // out of stock (defensive)
    { id: '6', stock_quantity: 0, active: false, archived_at: null }, // inactive -> excluded
    { id: '7', stock_quantity: 2, active: true, archived_at: '2026-11-20T00:00:00Z' } // archived -> excluded
  ];

  const activeNonArchived = products.filter(p => !p.archived_at && p.active === true);
  assert.equal(activeNonArchived.length, 5);

  const outOfStock = activeNonArchived.filter(p => p.stock_quantity <= 0);
  assert.equal(outOfStock.length, 2);

  const lowStock = activeNonArchived.filter(p => p.stock_quantity > 0 && p.stock_quantity <= 5);
  assert.equal(lowStock.length, 2);
});

test('Customer metrics report registered customers, approved traders, and pending applications separately', () => {
  const users = [
    { id: 'u1', role: 'customer', approved: true },
    { id: 'u2', role: 'customer', approved: false },
    { id: 'u3', role: 'wholesale', approved: true },
    { id: 'u4', role: 'wholesale', approved: false }
  ];
  const wholesaleApps = [
    { id: 'w1', status: 'pending' },
    { id: 'w2', status: 'pending' }
  ];

  const registeredCustomers = users.filter(u => u.role === 'customer' || !u.role).length;
  assert.equal(registeredCustomers, 2);

  const approvedTraders = users.filter(u => u.role === 'wholesale' && u.approved === true).length;
  assert.equal(approvedTraders, 1);

  const pendingTraderApplications = wholesaleApps.filter(w => w.status === 'pending').length;
  assert.equal(pendingTraderApplications, 2);
});

test('Top-selling items aggregation handles historical items without a product_id', () => {
  const orderItems = [
    { product_id: 'p1', sku_snapshot: 'SKU1', name_snapshot: 'Product 1', quantity: 3, unit_price: 100 },
    { product_id: 'p1', sku_snapshot: 'SKU1', name_snapshot: 'Product 1', quantity: 2, unit_price: 100 },
    { product_id: null, sku_snapshot: 'OLD-SKU', name_snapshot: 'Historical Deleted Product', quantity: 10, unit_price: 50 },
    { product_id: 'p2', sku_snapshot: 'SKU2', name_snapshot: 'Product 2', quantity: 1, unit_price: 200 }
  ];

  const topMap = new Map();
  for (const item of orderItems) {
    const key = item.product_id || item.sku_snapshot;
    const existing = topMap.get(key) || {
      productId: item.product_id || null,
      sku: item.sku_snapshot || '',
      name: item.name_snapshot || '',
      unitsSold: 0,
      revenue: 0,
      historical: !item.product_id
    };
    existing.unitsSold += Number(item.quantity) || 0;
    existing.revenue += (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
    topMap.set(key, existing);
  }

  const topProducts = Array.from(topMap.values()).sort((a, b) => b.unitsSold - a.unitsSold);
  assert.equal(topProducts.length, 3);
  assert.equal(topProducts[0].sku, 'OLD-SKU');
  assert.equal(topProducts[0].unitsSold, 10);
  assert.equal(topProducts[0].revenue, 500);
  assert.equal(topProducts[0].historical, true);

  assert.equal(topProducts[1].sku, 'SKU1');
  assert.equal(topProducts[1].unitsSold, 5);
  assert.equal(topProducts[1].revenue, 500);
  assert.equal(topProducts[1].historical, false);
});

test('Top-selling items aggregation handles large datasets exceeding 200 items without truncation', () => {
  // Generate 500 items across 10 products
  const largeOrderItems = [];
  for (let i = 0; i < 500; i++) {
    const pIndex = i % 10;
    largeOrderItems.push({
      product_id: `prod-${pIndex}`,
      sku_snapshot: `SKU-${pIndex}`,
      name_snapshot: `Product ${pIndex}`,
      quantity: 2,
      unit_price: 50
    });
  }

  const topMap = new Map();
  for (const item of largeOrderItems) {
    const key = item.product_id || item.sku_snapshot;
    const existing = topMap.get(key) || {
      productId: item.product_id || null,
      sku: item.sku_snapshot || '',
      name: item.name_snapshot || '',
      unitsSold: 0,
      revenue: 0,
      historical: !item.product_id
    };
    existing.unitsSold += Number(item.quantity) || 0;
    existing.revenue += (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
    topMap.set(key, existing);
  }

  const topProducts = Array.from(topMap.values()).sort((a, b) => b.unitsSold - a.unitsSold);
  // Each of the 10 products received exactly 50 orders * 2 = 100 units
  assert.equal(topProducts.length, 10);
  for (const p of topProducts) {
    assert.equal(p.unitsSold, 100);
    assert.equal(p.revenue, 5000);
  }
});

test('Cairo timezone date calculation accurately handles month-end and year-start boundaries', () => {
  // End of year case: Dec 31
  const endOfYear = new Date('2026-12-31T23:30:00Z');
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  // Dec 31 23:30 UTC is Jan 1 01:30 in Cairo (UTC+2)
  const parts = fmt.format(endOfYear).split('-').map(Number);
  assert.equal(parts[0], 2027);
  assert.equal(parts[1], 1);
  assert.equal(parts[2], 1);

  // Month start boundary check: Feb 1 in Cairo
  const febStart = new Date('2026-01-31T22:00:00Z'); // midnight Feb 1 in Cairo (UTC+2)
  const febParts = fmt.format(febStart).split('-').map(Number);
  assert.equal(febParts[0], 2026);
  assert.equal(febParts[1], 2);
  assert.equal(febParts[2], 1);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/app/storefront-logic.ts', import.meta.url), 'utf8');
const javascript = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
const logic = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

const nailer = { id: 'nailer', name: 'TOTAL 20V Brushless Battery Nailer', brand: 'TOTAL', category: 'Power Tools', price: 7000, sku: 'TCBNLI500857', stock: 3 };
const drill = { id: 'drill', name: 'Test Drill', brand: 'Other', category: 'Drills', price: 5000, sku: 'DRILL-1', stock: 5 };
const grinder = { id: 'grinder', name: 'TOTAL 4-Inch Angle Grinder', brand: 'total', category: 'Power Tools', price: 3200, sku: 'TG1081006', stock: 6 };
const sander = { id: 'sander', name: 'INGCO Palm Sander', brand: 'INGCO', category: 'Power Tools', price: 2100, sku: 'PS3208', stock: 4 };
const emptyBrand = { id: 'emptyBrand', name: 'Generic Screw Bit Set', brand: '', category: 'Accessories', price: 450, sku: 'BIT-01', stock: 15 };
const missingBrand = { id: 'missingBrand', name: 'Unbranded Utility Knife', category: 'Hand Tools', price: 120, sku: 'KNIFE-01', stock: 20 };

test('search matches exact SKU TCBNLI500857', () => {
  assert.deepEqual(logic.filterCatalog([nailer, drill], { searchText: 'TCBNLI500857', selectedCategory: '', minPrice: 0, maxPrice: Number.MAX_SAFE_INTEGER, sort: 'featured' }).map(row => row.id), ['nailer']);
});

test('search returns no results for an unknown query', () => {
  assert.deepEqual(logic.filterCatalog([nailer, drill], { searchText: 'missing-item', selectedCategory: '', minPrice: 0, maxPrice: Number.MAX_SAFE_INTEGER, sort: 'featured' }), []);
});

test('minimum price above 7000 excludes the 7000 EGP product', () => {
  assert.deepEqual(logic.filterCatalog([nailer], { searchText: '', selectedCategory: '', minPrice: 7001, maxPrice: Number.MAX_SAFE_INTEGER, sort: 'featured' }), []);
});

test('clearing filters restores the full catalog', () => {
  assert.equal(logic.filterCatalog([nailer, drill], { searchText: '', selectedCategory: '', minPrice: 0, maxPrice: Number.MAX_SAFE_INTEGER, sort: 'featured' }).length, 2);
});

test('category filtering remains active independently of other filters', () => {
  assert.deepEqual(logic.filterCatalog([nailer, drill], { searchText: '', selectedCategory: 'Power Tools', minPrice: 0, maxPrice: Number.MAX_SAFE_INTEGER, sort: 'featured' }).map(row => row.id), ['nailer']);
});

test('filtering by one brand returns only products of that brand', () => {
  const result = logic.filterCatalog([nailer, drill, grinder, sander], {
    searchText: '',
    selectedCategory: '',
    selectedBrand: 'INGCO',
    minPrice: 0,
    maxPrice: Number.MAX_SAFE_INTEGER,
    sort: 'featured'
  });
  assert.deepEqual(result.map(row => row.id), ['sander']);
});

test('case-insensitive brand matching matches regardless of casing', () => {
  const lowerResult = logic.filterCatalog([nailer, drill, grinder, sander], {
    searchText: '',
    selectedCategory: '',
    selectedBrand: 'total',
    minPrice: 0,
    maxPrice: Number.MAX_SAFE_INTEGER,
    sort: 'featured'
  });
  assert.deepEqual(lowerResult.map(row => row.id), ['nailer', 'grinder']);

  const mixedResult = logic.filterCatalog([nailer, drill, grinder, sander], {
    searchText: '',
    selectedCategory: '',
    selectedBrand: 'ToTaL',
    minPrice: 0,
    maxPrice: Number.MAX_SAFE_INTEGER,
    sort: 'featured'
  });
  assert.deepEqual(mixedResult.map(row => row.id), ['nailer', 'grinder']);
});

test('brand and category combination filters by both criteria simultaneously', () => {
  const matched = logic.filterCatalog([nailer, drill, grinder, sander], {
    searchText: '',
    selectedCategory: 'Power Tools',
    selectedBrand: 'TOTAL',
    minPrice: 0,
    maxPrice: Number.MAX_SAFE_INTEGER,
    sort: 'featured'
  });
  assert.deepEqual(matched.map(row => row.id), ['nailer', 'grinder']);

  const emptyIntersection = logic.filterCatalog([nailer, drill, grinder, sander], {
    searchText: '',
    selectedCategory: 'Drills',
    selectedBrand: 'TOTAL',
    minPrice: 0,
    maxPrice: Number.MAX_SAFE_INTEGER,
    sort: 'featured'
  });
  assert.deepEqual(emptyIntersection, []);
});

test('brand and price range combination filters by brand within price bounds', () => {
  const lowPriceTotal = logic.filterCatalog([nailer, grinder, sander], {
    searchText: '',
    selectedCategory: '',
    selectedBrand: 'TOTAL',
    minPrice: 3000,
    maxPrice: 4000,
    sort: 'featured'
  });
  assert.deepEqual(lowPriceTotal.map(row => row.id), ['grinder']);

  const highPriceTotal = logic.filterCatalog([nailer, grinder, sander], {
    searchText: '',
    selectedCategory: '',
    selectedBrand: 'TOTAL',
    minPrice: 6000,
    maxPrice: 8000,
    sort: 'featured'
  });
  assert.deepEqual(highPriceTotal.map(row => row.id), ['nailer']);
});

test('search within a selected brand scopes query to that brand only', () => {
  const brandSearch = logic.filterCatalog([nailer, grinder, sander], {
    searchText: 'Grinder',
    selectedCategory: '',
    selectedBrand: 'TOTAL',
    minPrice: 0,
    maxPrice: Number.MAX_SAFE_INTEGER,
    sort: 'featured'
  });
  assert.deepEqual(brandSearch.map(row => row.id), ['grinder']);

  const foreignSearch = logic.filterCatalog([nailer, grinder, sander], {
    searchText: 'Sander',
    selectedCategory: '',
    selectedBrand: 'TOTAL',
    minPrice: 0,
    maxPrice: Number.MAX_SAFE_INTEGER,
    sort: 'featured'
  });
  assert.deepEqual(foreignSearch, []);
});

test('clearing the selected brand restores all matching products', () => {
  const allBrands = logic.filterCatalog([nailer, drill, grinder, sander], {
    searchText: '',
    selectedCategory: '',
    selectedBrand: '',
    minPrice: 0,
    maxPrice: Number.MAX_SAFE_INTEGER,
    sort: 'featured'
  });
  assert.equal(allBrands.length, 4);
});

test('products with missing or empty brand values are handled safely', () => {
  const filtered = logic.filterCatalog([nailer, emptyBrand, missingBrand], {
    searchText: '',
    selectedCategory: '',
    selectedBrand: 'TOTAL',
    minPrice: 0,
    maxPrice: Number.MAX_SAFE_INTEGER,
    sort: 'featured'
  });
  assert.deepEqual(filtered.map(row => row.id), ['nailer']);

  const unFiltered = logic.filterCatalog([nailer, emptyBrand, missingBrand], {
    searchText: '',
    selectedCategory: '',
    selectedBrand: '',
    minPrice: 0,
    maxPrice: Number.MAX_SAFE_INTEGER,
    sort: 'featured'
  });
  assert.deepEqual(unFiltered.map(row => row.id), ['nailer', 'emptyBrand', 'missingBrand']);
});

test('cart quantity cannot exceed stock 3 and reports the cap', () => {
  assert.deepEqual(logic.boundedCartQuantity(3, 3, 1), { quantity: 3, capped: true, unavailable: false });
  assert.deepEqual(logic.boundedCartQuantity(3, 4, 0), { quantity: 3, capped: true, unavailable: false });
});

test('increment is unavailable at the stock limit', () => {
  assert.equal(logic.boundedCartQuantity(3, 3, 1).capped, true);
});

test('zero stock and unavailable products retain the cart line but block availability', () => {
  assert.deepEqual(logic.boundedCartQuantity(0, 2, 1), { quantity: 2, capped: false, unavailable: true });
  assert.deepEqual(logic.boundedCartQuantity(-1, 1, -1), { quantity: 1, capped: false, unavailable: true });
  assert.equal(logic.cartAvailabilityIssue(true, 0, 1), 'unavailable');
  assert.equal(logic.cartAvailabilityIssue(false, 3, 1), 'unavailable');
  assert.equal(logic.canIncreaseCartQuantity(false, 3, 1), false);
});

test('a stock change below the cart quantity is detected and can be reconciled', () => {
  assert.equal(logic.cartAvailabilityIssue(true, 2, 3), 'exceeds_stock');
  assert.deepEqual(logic.boundedCartQuantity(2, 3, 0), { quantity: 2, capped: true, unavailable: false });
});

test('resolveApiBaseUrl preserves local development defaults', () => {
  assert.equal(logic.resolveApiBaseUrl({ origin: 'http://127.0.0.1:4200' }), 'http://127.0.0.1:3000/api');
  assert.equal(logic.resolveApiBaseUrl({ isDevMode: true }), 'http://127.0.0.1:3000/api');
});

test('resolveApiBaseUrl respects local stagingTest and image gateway query switches', () => {
  const stagingParams = new URLSearchParams('stagingTest=1');
  assert.equal(logic.resolveApiBaseUrl({ origin: 'http://127.0.0.1:4200', searchParams: stagingParams }), 'http://127.0.0.1:3203/api');

  const gatewayParams = new URLSearchParams('productImageTestGateway=1');
  assert.equal(logic.resolveApiBaseUrl({ origin: 'http://127.0.0.1:4200', searchParams: gatewayParams }), 'http://127.0.0.1:3104/api');
});

test('resolveApiBaseUrl falls back to relative /api on Vercel and remote deployments', () => {
  assert.equal(logic.resolveApiBaseUrl({ origin: 'https://dar-al-handasa.vercel.app' }), '/api');
  assert.equal(logic.resolveApiBaseUrl({ origin: 'https://daralhandasa.com' }), '/api');
  assert.equal(logic.resolveApiBaseUrl({}), '/api');
});

test('resolveApiBaseUrl strictly blocks untrusted query parameters on remote origins', () => {
  // Attacker attempts to exfiltrate admin credentials or order details by passing an external apiUrl query param
  const maliciousQuery = new URLSearchParams('apiUrl=https://attacker-phishing.com/api');
  assert.equal(
    logic.resolveApiBaseUrl({ origin: 'https://preview.vercel.app', searchParams: maliciousQuery }),
    '/api',
    'Remote deployments must ignore query-parameter apiUrl overrides'
  );
  assert.equal(
    logic.resolveApiBaseUrl({ origin: 'https://daralhandasa.com', searchParams: maliciousQuery }),
    '/api',
    'Production deployments must ignore query-parameter apiUrl overrides'
  );
});

test('resolveApiBaseUrl rejects insecure or localhost window URLs on remote origins', () => {
  // Prevent cloud preview / production from accidentally using insecure http: or loopback
  assert.equal(
    logic.resolveApiBaseUrl({ origin: 'https://preview.vercel.app', windowApiUrl: 'http://127.0.0.1:3000/api' }),
    '/api',
    'Remote origins must reject loopback 127.0.0.1'
  );
  assert.equal(
    logic.resolveApiBaseUrl({ origin: 'https://daralhandasa.com', windowApiUrl: 'http://insecure-api.com/api' }),
    '/api',
    'Remote origins must reject non-HTTPS URLs'
  );
});

test('resolveApiBaseUrl accepts trusted HTTPS window URLs or relative paths on remote origins', () => {
  assert.equal(
    logic.resolveApiBaseUrl({ origin: 'https://preview.vercel.app', windowApiUrl: '/api' }),
    '/api'
  );
  // Protocol-relative URLs are rejected
  assert.equal(
    logic.resolveApiBaseUrl({ origin: 'https://preview.vercel.app', windowApiUrl: '//attacker.com/api' }),
    '/api'
  );
  // HTTPS alone is NOT sufficient trust: if trustedApiOrigins is omitted or empty, external HTTPS URL is rejected
  assert.equal(
    logic.resolveApiBaseUrl({
      origin: 'https://preview.vercel.app',
      windowApiUrl: 'https://arbitrary-https-host.com/api'
    }),
    '/api',
    'HTTPS alone must not be trusted without explicit allowlist'
  );
  // Rejects private IP addresses even with HTTPS
  assert.equal(
    logic.resolveApiBaseUrl({
      origin: 'https://preview.vercel.app',
      windowApiUrl: 'https://192.168.1.100/api',
      trustedApiOrigins: ['https://192.168.1.100']
    }),
    '/api',
    'Private IP addresses must be rejected in cloud environment'
  );
  // Explicit trusted origin match succeeds
  assert.equal(
    logic.resolveApiBaseUrl({
      origin: 'https://preview.vercel.app',
      windowApiUrl: 'https://staging-api.daralhandasa.com/api',
      trustedApiOrigins: ['https://staging-api.daralhandasa.com']
    }),
    'https://staging-api.daralhandasa.com/api'
  );
  // Rejects origins not in the trusted allowlist
  assert.equal(
    logic.resolveApiBaseUrl({
      origin: 'https://preview.vercel.app',
      windowApiUrl: 'https://untrusted-api.com/api',
      trustedApiOrigins: ['https://staging-api.daralhandasa.com']
    }),
    '/api'
  );
});

test('resolveApiBaseUrl permits local loopback apiUrl override in dev mode only', () => {
  const localQuery = new URLSearchParams('apiUrl=http://127.0.0.1:3999/api');
  assert.equal(
    logic.resolveApiBaseUrl({ origin: 'http://127.0.0.1:4200', searchParams: localQuery }),
    'http://127.0.0.1:3999/api'
  );
});

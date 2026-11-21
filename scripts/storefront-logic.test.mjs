import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/app/storefront-logic.ts', import.meta.url), 'utf8');
const javascript = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
const logic = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

const nailer = { id: 'nailer', name: 'TOTAL 20V Brushless Battery Nailer', brand: 'TOTAL', category: 'Power Tools', price: 7000, sku: 'TCBNLI500857', stock: 3 };
const drill = { id: 'drill', name: 'Test Drill', brand: 'Other', category: 'Drills', price: 5000, sku: 'DRILL-1', stock: 5 };

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

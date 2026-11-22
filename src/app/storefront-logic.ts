export type CatalogProduct = {
  id: string;
  name: string;
  brand: string;
  category: string;
  price: number;
  sku: string;
};

export type CatalogFilters = {
  searchText: string;
  selectedCategory: string;
  selectedBrand?: string;
  minPrice: number;
  maxPrice: number;
  sort: string;
};

export function filterCatalog<T extends CatalogProduct>(products: T[], filters: CatalogFilters): T[] {
  const selectedBrand = filters.selectedBrand?.trim().toLocaleLowerCase() || '';
  let rows = products.filter(product =>
    (!filters.selectedCategory || product.category === filters.selectedCategory)
    && (!selectedBrand || (typeof product.brand === 'string' && product.brand.trim().toLocaleLowerCase() === selectedBrand))
    && product.price >= filters.minPrice
    && product.price <= filters.maxPrice
  );

  const query = filters.searchText.trim().toLocaleLowerCase();
  if (query) {
    rows = rows.filter(product =>
      `${product.name} ${product.brand || ''} ${product.category} ${product.sku}`.toLocaleLowerCase().includes(query)
    );
  }

  if (filters.sort === 'low') rows = [...rows].sort((a, b) => a.price - b.price);
  if (filters.sort === 'high') rows = [...rows].sort((a, b) => b.price - a.price);
  if (filters.sort === 'name') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return rows;
}

export function boundedCartQuantity(stock: number, current: number, delta: number): { quantity: number; capped: boolean; unavailable: boolean } {
  if (!Number.isSafeInteger(stock) || stock < 1) {
    return { quantity: Math.max(1, current), capped: false, unavailable: true };
  }

  const requested = current + delta;
  const quantity = Math.max(1, Math.min(stock, requested));
  return { quantity, capped: requested > stock || current > stock, unavailable: false };
}

export function cartAvailabilityIssue(active: boolean | undefined, stock: number, quantity: number): 'unavailable' | 'exceeds_stock' | '' {
  if (active === false || stock < 1) return 'unavailable';
  if (quantity > stock) return 'exceeds_stock';
  return '';
}

export function canIncreaseCartQuantity(active: boolean | undefined, stock: number, quantity: number): boolean {
  return active !== false && stock > 0 && quantity < stock;
}

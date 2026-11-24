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

export interface ApiUrlResolutionOptions {
  isDevMode?: boolean;
  origin?: string;
  searchParams?: URLSearchParams | null;
  windowApiUrl?: string | null;
  trustedApiOrigins?: string[];
}

export function isLoopbackOrigin(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

export function isSecureCloudApiUrl(urlStr: string, trustedOrigins?: string[]): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
    ) {
      return false;
    }
    // HTTPS alone is NOT considered sufficient trust.
    // Any cloud API override must match an explicit trusted-origin allowlist.
    if (!trustedOrigins || trustedOrigins.length === 0) {
      return false;
    }
    return trustedOrigins.some(trusted => {
      try {
        const trustedParsed = new URL(trusted);
        return parsed.origin.toLowerCase() === trustedParsed.origin.toLowerCase();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function resolveApiBaseUrl(options: ApiUrlResolutionOptions = {}): string {
  const origin = (options.origin || '').trim();
  const search = options.searchParams;

  const isLocalDev = Boolean(options.isDevMode)
    || origin === 'http://127.0.0.1:4200'
    || origin === 'http://localhost:4200';

  if (isLocalDev) {
    const stagingRequested = search?.get('stagingTest') === '1'
      && search?.get('productImageTestGateway') !== '1';
    const imageTestGatewayRequested = search?.get('productImageTestGateway') === '1'
      && search?.get('stagingTest') !== '1';

    if (stagingRequested) return 'http://127.0.0.1:3203/api';
    if (imageTestGatewayRequested) return 'http://127.0.0.1:3104/api';

    const localOverride = search?.get('apiUrl')?.trim();
    if (localOverride && isLoopbackOrigin(localOverride)) {
      return localOverride.replace(/\/+$/, '');
    }

    return 'http://127.0.0.1:3000/api';
  }

  // Cloud Preview / Production: URL query parameters (apiUrl) and untrusted localStorage
  // are strictly ignored to prevent phishing and admin token exfiltration to arbitrary origins.
  const windowConfig = (options.windowApiUrl || '').trim();
  if (windowConfig) {
    if (windowConfig.startsWith('/') && !windowConfig.startsWith('//')) {
      return windowConfig.replace(/\/+$/, '');
    }
    if (isSecureCloudApiUrl(windowConfig, options.trustedApiOrigins)) {
      return windowConfig.replace(/\/+$/, '');
    }
  }

  return '/api';
}

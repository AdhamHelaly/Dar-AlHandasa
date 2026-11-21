import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectorRef, Component, computed, isDevMode, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LucideBoxes, LucideBuilding2, LucideHeadset, LucideLandmark, LucideMenu, LucideSearch, LucideShoppingCart, LucideUserRound, LucideWalletCards } from '@lucide/angular';
import { siFacebook, siInstagram, siWhatsapp } from 'simple-icons';
import { filter, finalize, timeout } from 'rxjs';
import { boundedCartQuantity, canIncreaseCartQuantity as canIncreaseCartLine, cartAvailabilityIssue, filterCatalog } from './storefront-logic';

type Product = { id: string; name: string; description: string; brand: string; category: string; price: number; sku: string; stock: number; image: string; label?: string; active?: boolean; archivedAt?: string | null };
type AdminProductsResponse = { products: Product[] };
type AdminProductFilter = 'all' | 'published' | 'unpublished' | 'archived';
type ImportRow = { row: number; sku: string; name: string; category: string; brand: string; description: string; price: number; stock: number; image: string; active: boolean; errors: string[] };
type CartLine = { product: Product; quantity: number };
type SiteSettings = { business_name?: string; currency?: string; phone?: string; whatsapp?: string; whatsapp_link?: string; instapay_number?: string; wallet_number?: string; facebook_url?: string; instagram_url?: string; email?: string; business_hours?: string; address?: string; delivery_enabled?: string; delivery_fee?: string; delivery_note?: string; hero_title?: string; hero_subtitle?: string; hero_description?: string };

const imageTestGatewayRequested = isDevMode()
  && typeof window !== 'undefined'
  && window.location.origin === 'http://127.0.0.1:4200'
  && new URLSearchParams(window.location.search).get('productImageTestGateway') === '1';
const API = `${imageTestGatewayRequested ? 'http://127.0.0.1:3104' : 'http://127.0.0.1:3000'}/api`;
const OFFICIAL_CONTACT: SiteSettings = {
  phone: '01099005307', whatsapp: '01099005307', whatsapp_link: 'https://wa.me/201099005307',
  instapay_number: '01099005307', wallet_number: '01500074015',
  facebook_url: 'https://www.facebook.com/share/1P9meyfK2R/',
  instagram_url: 'https://www.instagram.com/dar.alhandasah2?igsh=MTlpOXBsOHM5NmM3Mw=='
};
@Component({
  selector: 'app-root', standalone: true, imports: [CommonModule, FormsModule, RouterLink, RouterLinkActive, RouterOutlet, LucideBoxes, LucideBuilding2, LucideHeadset, LucideLandmark, LucideMenu, LucideSearch, LucideShoppingCart, LucideUserRound, LucideWalletCards],
  templateUrl: './app.html', styleUrl: './app.scss'
})
export class App {
  readonly brandIcons = { whatsapp: siWhatsapp, facebook: siFacebook, instagram: siInstagram };
  private readonly filterRevision = signal(0);
  private productsState: Product[] = [];
  get products(): Product[] { return this.productsState; }
  set products(value: Product[]) { this.productsState = value; this.filterRevision.update(revision => revision + 1); }
  private searchTextState = '';
  get searchText(): string { return this.searchTextState; }
  set searchText(value: string) { this.searchTextState = value; this.filterRevision.update(revision => revision + 1); }
  private selectedCategoryState = '';
  get selectedCategory(): string { return this.selectedCategoryState; }
  set selectedCategory(value: string) { this.selectedCategoryState = value; this.filterRevision.update(revision => revision + 1); }
  private sortState = 'featured';
  get sort(): string { return this.sortState; }
  set sort(value: string) { this.sortState = value; this.filterRevision.update(revision => revision + 1); }
  private minPriceState = 0;
  get minPrice(): number { return this.minPriceState; }
  set minPrice(value: number) { this.minPriceState = value; this.filterRevision.update(revision => revision + 1); }
  private maxPriceState = Number.MAX_SAFE_INTEGER;
  get maxPrice(): number { return this.maxPriceState; }
  set maxPrice(value: number) { this.maxPriceState = value; this.filterRevision.update(revision => revision + 1); }
  productsLoading = true;
  productsError = '';
  private productsRequestId = 0;
  categories: { id?: string; name: string; icon: string }[] = [];
  page = 'home';
  searchOpen = false;
  mobileMenu = false;
  cartOpen = false;
  selectedProduct: Product | undefined;
  message = '';
  contactForm = { name: '', phone: '', email: '', subject: '', details: '' };
  quoteForm = { name: '', phone: '', email: '', company: '', activity: '', governorate: '', city: '', address: '', products: '', quantity: '', details: '' };
  quoteItems: { name: string; quantity: number; reference: string }[] = [{ name: '', quantity: 1, reference: '' }];
  wholesaleForm = { firstName: '', lastName: '', phone: '', email: '', company: '', governorate: '', city: '', address: '', activity: '', tax: '' };
  wholesalePassword = '';
  wholesalePasswordConfirmation = '';
  accountMode: 'login' | 'register' = 'login';
  accountForm = { name: '', phone: '', email: '', password: '' };
  accountUser: { name: string; email: string; role: string } | null = this.readUser();
  adminEmail = '';
  adminPassword = '';
  adminToken = localStorage.getItem('dar-handasa-admin-token') || '';
  adminTab = 'products';
  adminProducts: Product[] = [];
  adminProductsLoading = false;
  adminProductsError = '';
  adminProductFilter: AdminProductFilter = 'all';
  adminQuotes: any[] = [];
  adminContacts: any[] = [];
  adminWholesale: any[] = [];
  adminProduct = { sku: '', name: '', description: '', brand: '', category: '', price: 0, stock: 0, image: '', label: '', inventoryReason: '', active: true };
  adminEditId: string | null = null;
  adminProductBusy = false;
  adminImageFile: File | null = null;
  adminImagePreviewUrl = '';
  adminImageUploadProgress = 0;
  adminImageError = '';
  adminImageRemoveBusy = false;
  importPreview: ImportRow[] = [];
  importFileName = '';
  importBusy = false;
  importResults: { row: number; sku: string; status: string; error?: string }[] = [];
  newSettingDraft = { key: 'delivery_enabled', value: 'true' };
  checkoutBusy = false;
  checkoutError = '';
  whatsappOrderUrl = '';
  whatsappOrderId = '';
  whatsappReservationExpiresAt = '';
  whatsappReservationExpired = false;
  private whatsappReservationExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private memoryOrderAttempt: { storageKey: string; idempotencyKey: string } | null = null;
  private whatsappAttemptStorageKey = '';
  orderForm = { name: '', phone: '', email: '', governorate: '', city: '', address: '' };
  adminOrders: any[] = [];
  adminOrdersLoading = false;
  adminOrdersError = '';
  orderSearch = '';
  orderStatusFilter = 'all';
  orderDateFrom = '';
  orderDateTo = '';
  adminOrderPage = 1;
  readonly adminOrderPageSize = 20;
  adminCustomers: any[] = [];
  adminBranches: any[] = [];
  adminBranch = { name: '', address: '', mapsUrl: '' };
  adminSettings: any[] = [];
  adminCategories: any[] = [];
  adminBrands: any[] = [];
  taxonomyDraft = { name: '', type: 'categories' as 'categories' | 'brands' };
  inventoryMovements: Record<string, any[]> = {};
  inventoryDraft: Record<string, { delta:number; reason:string }> = {};
  inventoryBusy = new Set<string>();
  siteSettings: SiteSettings = { ...OFFICIAL_CONTACT };
  publicBranches: any[] = [];
  cart = signal<CartLine[]>(this.readCart());
  cartCount = computed(() => this.cart().reduce((sum, line) => sum + line.quantity, 0));
  cartTotal = computed(() => this.cart().reduce((sum, line) => sum + line.product.price * line.quantity, 0));
  cartHasUnavailableItems = computed(() => this.cart().some(line => !!this.cartLineIssue(line)));
  filteredProducts = computed(() => {
    this.filterRevision();
    return filterCatalog(this.products, {
      searchText: this.searchText,
      selectedCategory: this.selectedCategory,
      minPrice: this.minPrice,
      maxPrice: this.maxPrice,
      sort: this.sort
    });
  });

  constructor(private router: Router, private http: HttpClient, private cdr: ChangeDetectorRef) {
    this.router.events.pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd)).subscribe(() => {
      this.syncPage(); this.mobileMenu = false; window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    this.syncPage();
    this.loadProducts();
    this.loadSiteInfo();
    this.loadCategories();
    if (this.adminToken) this.loadAdminData();
  }
  private syncPage() {
    const url = this.router.url.split('?')[0];
    const bits = url.split('/').filter(Boolean);
    this.page = bits[0] || 'home';
    if (this.page === 'product') {
      const sku = decodeURIComponent(bits[1] || '').toLowerCase();
      this.selectedProduct = this.products.find(product => product.sku.toLowerCase() === sku);
    } else {
      this.selectedProduct = undefined;
    }
    if (this.page === 'shop') { this.selectedCategory = new URLSearchParams(location.search).get('category') || ''; this.searchText = ''; }
    if (this.page === 'search') this.searchText = new URLSearchParams(location.search).get('q') || this.searchText;
    this.cdr.markForCheck();
  }
  private readCart(): CartLine[] {
    try { const saved = localStorage.getItem('dar-handasa-cart'); return saved ? JSON.parse(saved) as CartLine[] : []; } catch { return []; }
  }
  private readUser() { try { return JSON.parse(localStorage.getItem('dar-handasa-user') || 'null') as { name: string; email: string; role: string } | null; } catch { return null; } }
  loadProducts() {
    const requestId = ++this.productsRequestId;
    this.productsLoading = true;
    this.productsError = '';
    this.cdr.markForCheck();

    this.http.get<{ products: Product[] }>(`${API}/products`).subscribe({
      next: response => {
        if (requestId !== this.productsRequestId) return;
        if (!Array.isArray(response?.products)) {
          this.productsLoading = false;
          this.productsError = 'تعذر قراءة كتالوج المتجر. أعد المحاولة بعد التحقق من اتصال الخادم.';
          this.cdr.markForCheck();
          return;
        }
        this.products = response.products;
        const live = new Map(this.products.map(product => [product.id, product]));
        this.cart.set(this.cart().map(line => {
          const product = live.get(line.product.id);
          // Keep unavailable items visible so customers can resolve them explicitly.
          return product ? { ...line, product } : { ...line, product: { ...line.product, stock: 0, active: false } };
        }));
        this.saveCart();
        this.productsLoading = false;
        this.productsError = '';
        // Resolve the current URL after the data arrives, regardless of whether
        // initial navigation or the request completed first.
        this.syncPage();
        this.cdr.markForCheck();
      },
      error: error => {
        if (requestId !== this.productsRequestId) return;
        this.productsLoading = false;
        this.productsError = error?.error?.error === 'supabase_not_configured'
          ? 'اتصال قاعدة بيانات المتجر غير مضبوط حالياً.'
          : 'تعذر تحميل كتالوج المتجر. تحقق من الاتصال ثم أعد المحاولة.';
        this.cdr.markForCheck();
      }
    });
  }
  private loadCategories() { this.http.get<{ categories: { id: string; name: string; icon?: string }[] }>(`${API}/categories`).subscribe({ next: response => { this.categories = (response.categories || []).map(row => ({ ...row, icon:row.icon || '⚙' })); this.cdr.markForCheck(); }, error: () => { this.categories = []; this.cdr.markForCheck(); } }); }
  private loadSiteInfo() { this.http.get<{ settings: SiteSettings; branches: any[] }>(`${API}/site`).subscribe({ next: response => { this.siteSettings = { ...OFFICIAL_CONTACT, ...(response.settings || {}) }; this.publicBranches = response.branches || []; this.cdr.markForCheck(); }, error: () => {} }); }
  private saveCart() { localStorage.setItem('dar-handasa-cart', JSON.stringify(this.cart())); }
  addToCart(product: Product, quantity = 1) {
    if (product.stock < 1 || product.active === false) { this.showMessage('هذا المنتج غير متاح حالياً.'); return; }
    const rows = [...this.cart()]; const line = rows.find(row => row.product.id === product.id);
    const current = line?.quantity || 0;
    const update = boundedCartQuantity(product.stock, current, quantity);
    if (line) { line.product = product; line.quantity = update.quantity; } else rows.push({ product, quantity: update.quantity });
    this.cart.set(rows); this.saveCart();
    this.showMessage(update.capped ? `الكمية المتاحة لهذا المنتج ${product.stock} فقط.` : 'أضيف المنتج إلى السلة');
  }
  changeQuantity(id: string, delta: number) {
    const rows = this.cart().map(row => {
      if (row.product.id !== id) return row;
      const update = boundedCartQuantity(row.product.stock, row.quantity, delta);
      if (update.unavailable) this.showMessage('هذا المنتج غير متاح حالياً. يمكنك إزالته من السلة.');
      else if (update.capped) this.showMessage(`الكمية المتاحة الآن ${row.product.stock} فقط؛ تم ضبط السلة عليها.`);
      return { ...row, quantity: update.quantity };
    });
    this.cart.set(rows); this.saveCart();
  }
  cartLineIssue(line: CartLine): string {
    const issue = cartAvailabilityIssue(line.product.active, line.product.stock, line.quantity);
    if (issue === 'unavailable') return 'هذا المنتج غير متاح حالياً. أزله من السلة قبل إتمام الطلب.';
    if (issue === 'exceeds_stock') return `المتاح الآن ${line.product.stock} فقط. خفّض الكمية قبل إتمام الطلب.`;
    return '';
  }
  canIncreaseCartQuantity(line: CartLine): boolean {
    return canIncreaseCartLine(line.product.active, line.product.stock, line.quantity);
  }
  removeFromCart(id: string) { this.cart.set(this.cart().filter(row => row.product.id !== id)); this.saveCart(); }
  showMessage(text: string) { this.message = text; window.setTimeout(() => this.message = '', 2800); }
  openProduct(product: Product) { this.router.navigate(['/product', product.sku]); }
  goShop(category = '') { this.selectedCategory = category; this.router.navigate(['/shop'], { queryParams: category ? { category } : {} }); }
  doSearch() { this.searchOpen = false; this.router.navigate(['/search'], { queryParams: { q: this.searchText.trim() } }); }
  clearFilters() { this.selectedCategory = ''; this.minPrice = 0; this.maxPrice = Number.MAX_SAFE_INTEGER; this.sort = 'featured'; this.router.navigate(['/shop']); }
  submitUnavailable(formName: string, valid: boolean | null) {
    if (valid !== true) { this.showMessage('راجع الحقول المطلوبة وتأكد من صحة رقم الهاتف والبريد الإلكتروني.'); return; }
    this.showMessage(`النموذج جاهز، لكن لم يتم إرساله: يلزم ربط ${formName} بخادم الموقع أولاً.`);
  }
  async submitApi(path: string, formName: string, valid: boolean | null, payload: unknown) {
    if (valid !== true) { this.showMessage('راجع الحقول المطلوبة وتأكد من صحة رقم الهاتف والبريد الإلكتروني.'); return; }
    try {
      const result = await this.http.post<{ message?: string }>(`${API}/${path}`, payload).toPromise();
      this.showMessage(result?.message || `تم حفظ ${formName} للمراجعة.`);
    } catch (error: any) {
      const reason = error?.error?.error;
      const messages: Record<string, string> = { email_exists: 'هذا البريد مسجل بالفعل.', invalid_fields: 'راجع الحقول المطلوبة وصيغتها.', too_many_requests: 'وصلت إلى الحد المؤقت للمحاولات، حاول لاحقاً.', pending_approval: 'طلب حساب التاجر بانتظار اعتماد الإدارة.', invalid_credentials: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.', admin_not_configured: 'إعداد دخول الإدارة غير مكتمل في ملف البيئة.' };
      this.showMessage(messages[reason] || `تعذر حفظ ${formName}. تأكد من تشغيل خدمة الموقع الخلفية.`);
    }
  }
  registerWholesale(valid: boolean | null, password: string, confirmation: string) {
    if (password !== confirmation) { this.showMessage('كلمتا المرور غير متطابقتين.'); return; }
    if (password.length < 10) { this.showMessage('كلمة المرور يجب أن تحتوي على 10 أحرف على الأقل.'); return; }
    this.submitApi('wholesale', 'طلب تسجيل التاجر', valid, { ...this.wholesaleForm, password });
  }
  addQuoteItem() { this.quoteItems = [...this.quoteItems, { name: '', quantity: 1, reference: '' }]; }
  removeQuoteItem(index: number) { if (this.quoteItems.length > 1) this.quoteItems = this.quoteItems.filter((_, i) => i !== index); }
  submitQuote(valid: boolean | null) {
    if (this.quoteItems.some(item => !item.name.trim() || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1)) { this.showMessage('أدخل اسم كل منتج والكمية المطلوبة.'); return; }
    const products = this.quoteItems.map(item => `${item.name.trim()}${item.reference.trim() ? ` (${item.reference.trim()})` : ''}: ${item.quantity}`).join('\n');
    const quantity = this.quoteItems.reduce((total, item) => total + Number(item.quantity), 0);
    this.submitApi('quotes', 'طلب عرض السعر', valid, { ...this.quoteForm, products, quantity });
  }
  async submitAccount(valid: boolean | null) {
    if (valid !== true) { this.showMessage('أكمل البيانات المطلوبة وتأكد من صحة البريد والهاتف.'); return; }
    const endpoint = this.accountMode === 'register' ? 'auth/register' : 'auth/login';
    try {
      const result = await this.http.post<{ token: string; user: { name: string; email: string; role: string } }>(`${API}/${endpoint}`, this.accountForm).toPromise();
      if (result?.token && result.user) { localStorage.setItem('dar-handasa-user-token', result.token); localStorage.setItem('dar-handasa-user', JSON.stringify(result.user)); this.accountUser = result.user; this.showMessage('تم تسجيل الدخول بنجاح.'); }
    } catch (error: any) {
      const reason = error?.error?.error;
      const messages: Record<string, string> = { email_exists: 'هذا البريد مسجل بالفعل.', invalid_fields: 'تحقق من البيانات وكلمة المرور (10 أحرف على الأقل).', invalid_credentials: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.', pending_approval: 'حساب التاجر بانتظار مراجعة الإدارة.', too_many_requests: 'محاولات كثيرة. حاول مرة أخرى لاحقاً.' };
      this.showMessage(messages[reason] || 'تعذر الاتصال بخدمة الحسابات.');
    }
  }
  logout() { localStorage.removeItem('dar-handasa-user-token'); localStorage.removeItem('dar-handasa-user'); this.accountUser = null; this.showMessage('تم تسجيل الخروج.'); }
  async adminLogin(valid: boolean | null) {
    if (valid !== true) { this.showMessage('أدخل البريد وكلمة المرور.'); return; }
    try { const result = await this.http.post<{ token: string }>(`${API}/admin/login`, { email: this.adminEmail, password: this.adminPassword }).toPromise(); if (result?.token) { this.adminToken = result.token; localStorage.setItem('dar-handasa-admin-token', result.token); this.showMessage('تم فتح لوحة الإدارة.'); this.loadAdminData(); } }
    catch (error: any) { this.showMessage(error?.error?.error === 'admin_not_configured' ? 'عرّف ADMIN_EMAIL وADMIN_PASSWORD وSESSION_SECRET لتفعيل الدخول.' : 'بيانات دخول الإدارة غير صحيحة أو الخادم غير متصل.'); }
  }
  adminHeaders() { return { Authorization: `Bearer ${this.adminToken}` }; }
  loadAdminData() {
    this.loadAdminProducts();
    const get = (path: string, cb: (data: any) => void) => this.http.get<any>(`${API}/admin/${path}`, { headers: this.adminHeaders() }).subscribe({ next: cb, error: error => this.showMessage(error?.status === 401 ? 'انتهت جلسة الإدارة. سجّل الدخول مرة أخرى.' : `تعذر تحميل بيانات الإدارة${error?.status ? ` (HTTP ${error.status})` : ''}.`) });
    get('quotes', data => this.adminQuotes = Array.isArray(data?.items) ? data.items : []); get('contacts', data => this.adminContacts = Array.isArray(data?.items) ? data.items : []); get('wholesale', data => this.adminWholesale = Array.isArray(data?.items) ? data.items : []); get('branches', data => this.adminBranches = Array.isArray(data?.branches) ? data.branches : []); get('settings', data => this.adminSettings = Array.isArray(data?.settings) ? data.settings : []); get('categories', data => this.adminCategories = Array.isArray(data?.categories) ? data.categories : []); get('brands', data => this.adminBrands = Array.isArray(data?.brands) ? data.brands : []);
    this.loadAdminOrders();
    get('customers', data => this.adminCustomers = Array.isArray(data?.customers) ? data.customers : []);
  }
  loadAdminOrders() {
    this.adminOrdersLoading = true;
    this.adminOrdersError = '';
    this.http.get<{ orders: any[] }>(`${API}/admin/orders`, { headers: this.adminHeaders() }).pipe(
      timeout({ first: 15000 }),
      finalize(() => { this.adminOrdersLoading = false; this.cdr.markForCheck(); })
    ).subscribe({
      next: result => {
        this.adminOrders = Array.isArray(result?.orders) ? result.orders : [];
        this.adminOrderPage = Math.min(this.adminOrderPage, this.adminOrderPageCount);
      },
      error: error => {
        this.adminOrdersError = error?.status === 401 ? 'انتهت جلسة الإدارة. سجّل الدخول مرة أخرى.' : `تعذر تحميل الطلبات${error?.status ? ` (HTTP ${error.status})` : ''}.`;
      }
    });
  }
  get filteredAdminOrders(): any[] {
    const query = this.orderSearch.trim().toLocaleLowerCase();
    const phoneQuery = query.replace(/\D/g, '');
    const from = this.orderDateFrom ? new Date(`${this.orderDateFrom}T00:00:00`).getTime() : null;
    const through = this.orderDateTo ? new Date(`${this.orderDateTo}T23:59:59.999`).getTime() : null;
    return this.adminOrders.filter(order => {
      const id = String(order.id || '').toLocaleLowerCase();
      const phone = String(order.customer_phone || '').replace(/\D/g, '');
      const created = Date.parse(order.created_at || '');
      return (!query || id.includes(query) || (phoneQuery.length > 0 && phone.includes(phoneQuery)))
        && (this.orderStatusFilter === 'all' || order.status === this.orderStatusFilter)
        && (from === null || (Number.isFinite(created) && created >= from))
        && (through === null || (Number.isFinite(created) && created <= through));
    });
  }
  get adminOrderPageCount(): number { return Math.max(1, Math.ceil(this.filteredAdminOrders.length / this.adminOrderPageSize)); }
  get paginatedAdminOrders(): any[] {
    const start = (this.adminOrderPage - 1) * this.adminOrderPageSize;
    return this.filteredAdminOrders.slice(start, start + this.adminOrderPageSize);
  }
  get firstVisibleAdminOrder(): number { return this.filteredAdminOrders.length ? (this.adminOrderPage - 1) * this.adminOrderPageSize + 1 : 0; }
  get lastVisibleAdminOrder(): number { return Math.min(this.adminOrderPage * this.adminOrderPageSize, this.filteredAdminOrders.length); }
  resetAdminOrderPage() { this.adminOrderPage = 1; }
  clearAdminOrderFilters() { this.orderSearch='';this.orderStatusFilter='all';this.orderDateFrom='';this.orderDateTo='';this.adminOrderPage=1; }
  changeAdminOrderPage(delta: number) { this.adminOrderPage = Math.max(1, Math.min(this.adminOrderPageCount, this.adminOrderPage + delta)); }
  loadAdminProducts() {
    if (!this.adminToken) { this.adminProductsError = 'سجّل الدخول لتحميل منتجات الإدارة.'; return; }
    this.adminProductsLoading = true;
    this.adminProductsError = '';
    this.http.get<AdminProductsResponse>(`${API}/admin/products`, { headers: this.adminHeaders() }).pipe(
      timeout({ first: 15000 }),
      finalize(() => {
        this.adminProductsLoading = false;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: response => {
        if (!response || !Array.isArray(response.products)) {
          this.adminProducts = [];
          this.adminProductsError = 'استجابة قائمة المنتجات غير متوقعة. أعد المحاولة.';
          console.error('[admin catalog] Invalid response shape; expected { products: Product[] }.');
        } else {
          this.adminProducts = response.products.map(product => ({ ...product, active: product.active === true, archivedAt: product.archivedAt ?? null }));
        }
        this.cdr.markForCheck();
      },
      error: error => {
        const status = Number(error?.status) || 0;
        this.adminProductsError = error?.name === 'TimeoutError' ? 'استغرق تحميل المنتجات وقتاً أطول من المتوقع. تحقق من الاتصال ثم أعد المحاولة.' : status === 401 ? 'انتهت جلسة الإدارة. سجّل الدخول مرة أخرى.' : status === 0 ? 'تعذر الاتصال بخادم الإدارة. تحقق من تشغيل الخادم ثم أعد المحاولة.' : `تعذر تحميل المنتجات (HTTP ${status}). أعد المحاولة.`;
        console.error('[admin catalog] Product request failed:', { status, code: error?.error?.error || error?.name || 'request_failed' });
        this.showMessage(this.adminProductsError);
        if (status === 401) {
          this.adminToken = '';
          localStorage.removeItem('dar-handasa-admin-token');
          this.adminProducts = [];
        }
        this.cdr.markForCheck();
      }
    });
  }
  get filteredAdminProducts(): Product[] {
    if (this.adminProductFilter === 'archived') return this.adminProducts.filter(product => Boolean(product.archivedAt));
    if (this.adminProductFilter === 'unpublished') return this.adminProducts.filter(product => !product.archivedAt && product.active !== true);
    if (this.adminProductFilter === 'published') return this.adminProducts.filter(product => !product.archivedAt && product.active === true);
    return this.adminProducts;
  }
  adminProductStatus(product: Product) { return product.archivedAt ? 'مؤرشف' : product.active ? 'منشور' : 'مسودة غير منشورة'; }
  async previewProductWorkbook(file: File | null) {
    this.importPreview = []; this.importResults = []; this.importFileName = file?.name || '';
    if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) { this.showMessage('ملف Excel لا يحتوي على ورقة بيانات.'); return; }
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
      if (!raw.length) { this.showMessage('لم يتم العثور على صفوف بيانات في الملف.'); return; }
      const aliases: Record<string, string[]> = {
        sku:['sku','code','product code','كود المنتج','الكود'], name:['name','product name','اسم المنتج','الاسم'], category:['category','التصنيف','الفئة'], brand:['brand','العلامة التجارية','الماركة'], description:['description','الوصف'], price:['price','السعر','السعر (ج.م)'], stock:['stock','quantity','stock quantity','المخزون','كمية المخزون','الكمية'], image:['image','image url','الصورة','رابط الصورة'], active:['active','published','نشط','منشور','إظهار المنتج في المتجر']
      };
      const normalizeHeader=(value: string)=>value.trim().toLocaleLowerCase().replace(/[\s_-]+/g,' ');
      const lookup=(row: Record<string,unknown>, field: string)=>{const key=Object.keys(row).find(header=>aliases[field].includes(normalizeHeader(header)));return key?row[key]:'';};
      const seen=new Set<string>();
      this.importPreview=raw.map((source,index)=>{
        const value=(field:string)=>String(lookup(source,field)??'').trim();
        const sku=value('sku'), name=value('name'), category=value('category'), priceText=value('price'), stockText=value('stock');
        const price=Number(priceText), stock=Number(stockText), errors:string[]=[];
        if(!sku) errors.push('الكود مطلوب');
        if(!name) errors.push('اسم المنتج مطلوب');
        if(!category) errors.push('التصنيف مطلوب');
        if(!priceText||!Number.isFinite(price)||price<0) errors.push('السعر غير صالح');
        if(stockText===''||!Number.isSafeInteger(stock)||stock<0) errors.push('المخزون يجب أن يكون عدداً صحيحاً غير سالب');
        const normalizedSku=sku.toLocaleUpperCase();
        if(normalizedSku&&seen.has(normalizedSku)) errors.push('SKU مكرر داخل الملف');
        if(normalizedSku&&this.adminProducts.some(product=>product.sku.toLocaleUpperCase()===normalizedSku)) errors.push('SKU موجود بالفعل في قاعدة البيانات');
        if(normalizedSku) seen.add(normalizedSku);
        const activeText=value('active').toLocaleLowerCase();
        const active=!['false','0','no','لا','مسودة','غير منشور'].includes(activeText);
        return {row:index+2,sku,name,category,brand:value('brand'),description:value('description'),price,stock,image:value('image'),active,errors};
      });
      this.showMessage(`تمت معاينة ${this.importPreview.length} صفاً؛ راجع الأخطاء قبل الحفظ.`);
    } catch (error) {
      console.error('[admin import] Workbook parse failed', {name:file.name});
      this.showMessage('تعذر قراءة الملف. استخدم ملف Excel بصيغة XLS أو XLSX.');
    }
  }
  importValidProducts() {
    if(this.importBusy) return;
    const rows=this.importPreview.filter(row=>!row.errors.length);
    if(!rows.length) { this.showMessage('لا توجد صفوف صالحة للاستيراد.'); return; }
    this.importBusy=true;
    this.http.post<{results: {row:number;sku:string;status:string;error?:string}[];created:number;failed:number}>(`${API}/admin/products/import`,{products:rows.map(({row,...product})=>({...product,row}))},{headers:this.adminHeaders()})
      .pipe(finalize(()=>{this.importBusy=false;this.cdr.markForCheck();}))
      .subscribe({next:response=>{this.importResults=response.results||[];this.showMessage(`تم استيراد ${response.created} منتج؛ تعذر استيراد ${response.failed} صف.`);this.loadAdminData();this.loadProducts();this.loadCategories();},error:error=>{console.error('[admin import] Save failed',{status:error?.status||0,code:error?.error?.error||'request_failed'});this.showMessage('تعذر استيراد الملف. بقيت المعاينة كما هي؛ أعد المحاولة بعد التحقق من الاتصال.');}});
  }
  async downloadImportTemplate() {
    const XLSX=await import('xlsx');
    const worksheet=XLSX.utils.aoa_to_sheet([['SKU','Name','Category','Brand','Description','Price','Stock','Image','Active']]);
    const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,worksheet,'Products');XLSX.writeFile(workbook,'dar-al-handasa-products-template.xlsx');
  }
  saveAdminProduct(valid: boolean | null) {
    if (this.adminProductBusy) return;
    if (valid !== true) { this.showMessage('أكمل الحقول المطلوبة.'); return; }
    this.adminProductBusy = true;
    this.adminImageError = '';
    const editing = Boolean(this.adminEditId);
    const request = this.adminEditId ? this.http.put<{ product: Product }>(`${API}/admin/products/${this.adminEditId}`, this.adminProduct, { headers: this.adminHeaders() }) : this.http.post<{ product: Product; id: string }>(`${API}/admin/products`, this.adminProduct, { headers: this.adminHeaders() });
    request.subscribe({
      next: response => {
        const saved = response?.product;
        if (this.adminImageFile && saved?.id) {
          this.adminEditId = saved.id;
          this.uploadAdminProductImage(saved.id, this.adminImageFile).then(result => {
            this.adminProduct.image = result.image;
            this.clearAdminImageSelection();
            this.completeAdminProductSave(editing);
          }).catch(error => {
            this.adminProduct.image = saved.image || this.adminProduct.image;
            this.adminProductBusy = false;
            this.adminImageError = error?.message || 'تعذر رفع الصورة؛ بقيت الصورة المحفوظة كما هي ويمكن إعادة المحاولة.';
            this.showMessage(this.adminImageError);
            this.loadAdminData(); this.loadProducts();
            this.cdr.markForCheck();
          });
          return;
        }
        this.completeAdminProductSave(editing);
      },
      error: error => {
        this.adminProductBusy = false;
        this.showMessage(error?.error?.error === 'sku_exists' ? 'كود المنتج مستخدم بالفعل.' : error?.error?.error === 'supabase_not_configured' ? 'Supabase غير مربوط. لم يتم حفظ التغييرات.' : 'تعذر حفظ المنتج في قاعدة البيانات؛ التغييرات ما زالت في النموذج.');
      }
    });
  }
  private completeAdminProductSave(editing: boolean) {
    this.showMessage(editing ? 'تم تحديث المنتج وصورته في المتجر.' : this.adminProduct.active ? 'تم حفظ المنتج وصورته ونشره في المتجر.' : 'تم حفظ المنتج وصورته كمسودة غير منشورة.');
    this.adminEditId = null;
    this.adminProduct = { sku: '', name: '', description: '', brand: '', category: '', price: 0, stock: 0, image: '', label: '', inventoryReason: '', active: true };
    this.clearAdminImageSelection();
    this.adminProductBusy = false;
    this.adminImageUploadProgress = 0;
    this.loadAdminData(); this.loadProducts(); this.loadCategories();
    this.cdr.markForCheck();
  }
  async selectAdminProductImage(file: File | null) {
    this.clearAdminImageSelection();
    this.adminImageError = '';
    if (!file) return;
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!allowedTypes.has(file.type)) { this.adminImageError = 'اختر صورة JPG أو PNG أو WebP صالحة.'; return; }
    if (file.size <= 0 || file.size > 20 * 1024 * 1024) { this.adminImageError = 'حجم الصورة يتجاوز الحد الأعلى المسموح به.'; return; }
    try {
      const bitmap = await createImageBitmap(file);
      const readable = bitmap.width > 0 && bitmap.height > 0 && bitmap.width <= 10000 && bitmap.height <= 10000 && bitmap.width * bitmap.height <= 40000000;
      bitmap.close();
      if (!readable) throw new Error('image_not_readable');
      this.adminImageFile = file;
      this.adminImagePreviewUrl = URL.createObjectURL(file);
    } catch {
      this.adminImageError = 'تعذر قراءة الصورة. اختر ملف صورة سليم بصيغة JPG أو PNG أو WebP.';
    }
    this.cdr.markForCheck();
  }
  private uploadAdminProductImage(productId: string, file: File): Promise<{ image: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append('image', file, file.name);
      xhr.open('POST', `${API}/admin/products/${productId}/image`);
      xhr.setRequestHeader('Authorization', `Bearer ${this.adminToken}`);
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) this.adminImageUploadProgress = Math.min(100, Math.round(event.loaded * 100 / event.total));
        this.cdr.markForCheck();
      };
      xhr.onerror = () => reject(new Error('تعذر الاتصال بخادم الصور. بقيت الصورة الحالية محفوظة.'));
      xhr.onabort = () => reject(new Error('تم إيقاف رفع الصورة. بقيت الصورة الحالية محفوظة.'));
      xhr.onload = () => {
        let response: any = {};
        try { response = JSON.parse(xhr.responseText || '{}'); } catch { /* report a generic upload failure below */ }
        if (xhr.status >= 200 && xhr.status < 300 && typeof response.image === 'string') resolve(response as { image: string });
        else {
          const maxBytes = Number(response.maxBytes);
          const maxMb = Number.isFinite(maxBytes) && maxBytes > 0 ? (maxBytes / (1024 * 1024)).toLocaleString('ar-EG', { maximumFractionDigits: 1 }) : '5';
          reject(new Error(response.error === 'image_too_large' ? `الحد الأقصى لحجم الصورة ${maxMb} ميجابايت.` : response.error === 'invalid_image_type' ? 'محتوى الملف لا يطابق صورة JPG أو PNG أو WebP.' : response.error === 'admin_auth_required' ? 'انتهت جلسة الإدارة؛ سجّل الدخول مجدداً.' : 'تعذر رفع الصورة؛ بقيت الصورة الحالية محفوظة.'));
        }
      };
      xhr.send(form);
    });
  }
  private clearAdminImageSelection() {
    if (this.adminImagePreviewUrl) URL.revokeObjectURL(this.adminImagePreviewUrl);
    this.adminImagePreviewUrl = '';
    this.adminImageFile = null;
    const input = document.querySelector<HTMLInputElement>('#admin-product-image-file');
    if (input) input.value = '';
  }
  discardAdminImageSelection() { this.clearAdminImageSelection(); this.adminImageError = ''; this.cdr.markForCheck(); }
  removeAdminProductImage() {
    if (!this.adminEditId) {
      this.clearAdminImageSelection(); this.adminProduct.image = ''; this.adminImageError = '';
      return;
    }
    if (this.adminImageRemoveBusy || !window.confirm('هل تريد إزالة صورة المنتج المحفوظة؟')) return;
    this.adminImageRemoveBusy = true;
    this.http.delete<{ image: string }>(`${API}/admin/products/${this.adminEditId}/image`, { headers: this.adminHeaders() }).subscribe({
      next: response => {
        this.adminProduct.image = response.image;
        this.clearAdminImageSelection(); this.adminImageRemoveBusy = false;
        this.adminProducts = this.adminProducts.map(product => product.id === this.adminEditId ? { ...product, image: '' } : product);
        this.loadProducts(); this.showMessage('تمت إزالة مرجع الصورة.'); this.cdr.markForCheck();
      },
      error: () => { this.adminImageRemoveBusy = false; this.adminImageError = 'تعذرت إزالة الصورة؛ لم يتغير المرجع المحفوظ.'; this.showMessage(this.adminImageError); this.cdr.markForCheck(); }
    });
  }
  onProductImageError(event: Event) {
    const image = event.target as HTMLImageElement;
    if (!image || image.dataset['fallbackApplied']) return;
    image.dataset['fallbackApplied'] = 'true';
    image.src = 'assets/hero-tools.png';
  }
  editAdminProduct(product: Product) { this.clearAdminImageSelection(); this.adminImageError = ''; this.adminEditId = product.id; this.adminProduct = { sku: product.sku, name: product.name, description: product.description || '', brand: product.brand, category: product.category, price: product.price, stock: product.stock, image: product.image, label: product.label || '', inventoryReason: '', active: product.active !== false }; window.scrollTo({ top: 0, behavior: 'smooth' }); }
  cancelEditProduct() { this.clearAdminImageSelection(); this.adminImageError = ''; this.adminEditId = null; this.adminProduct = { sku: '', name: '', description: '', brand: '', category: '', price: 0, stock: 0, image: '', label: '', inventoryReason: '', active: true }; }
  archiveProduct(id: string) { this.http.delete(`${API}/admin/products/${id}`, { headers: this.adminHeaders() }).subscribe({ next: () => { this.showMessage('تمت أرشفة المنتج في قاعدة البيانات.'); this.loadAdminData(); this.loadProducts(); }, error: () => this.showMessage('تعذر أرشفة المنتج في قاعدة البيانات.') }); }
  restoreProduct(id: string) { this.http.patch(`${API}/admin/products/${id}/restore`,{}, {headers:this.adminHeaders()}).subscribe({next:()=>{this.showMessage('تمت استعادة المنتج كمسودة غير منشورة.');this.loadAdminData();},error:()=>this.showMessage('تعذرت استعادة المنتج.')}); }
  loadInventory(id: string) { this.http.get<{movements:any[]}>(`${API}/admin/products/${id}/inventory`,{headers:this.adminHeaders()}).subscribe({next:r=>this.inventoryMovements[id]=r.movements||[],error:()=>this.showMessage('تعذر تحميل سجل المخزون.')}); }
  getInventoryDraft(id: string) { return this.inventoryDraft[id] ||= {delta:0,reason:''}; }
  submitInventoryAdjustment(id: string) { const draft=this.getInventoryDraft(id); this.adjustInventory(id,Number(draft.delta),draft.reason); }
  adjustInventory(id: string, delta: number, reason: string) {
    if(this.inventoryBusy.has(id)) return;
    if (!Number.isSafeInteger(delta) || delta === 0 || !reason.trim()) { this.showMessage('أدخل كمية تعديل وسبباً واضحاً.'); return; }
    this.inventoryBusy.add(id);
    this.http.post<{product:Product;movement:any}>(`${API}/admin/products/${id}/inventory`,{delta,reason},{headers:this.adminHeaders()}).subscribe({next:r=>{this.inventoryBusy.delete(id);this.inventoryDraft[id]={delta:0,reason:''};this.showMessage('تم تحديث المخزون وحفظ حركة التعديل.'); this.inventoryMovements[id]=[r.movement,...(this.inventoryMovements[id]||[])]; this.loadAdminData(); this.loadProducts();},error:()=>{this.inventoryBusy.delete(id);this.showMessage('تعذر تحديث المخزون؛ لم يتم حفظ التعديل.');}});
  }
  saveTaxon(valid: boolean | null) {
    if(valid!==true || !this.taxonomyDraft.name.trim()) { this.showMessage('أدخل اسماً صالحاً.'); return; }
    this.http.post(`${API}/admin/${this.taxonomyDraft.type}`,{name:this.taxonomyDraft.name},{headers:this.adminHeaders()}).subscribe({next:()=>{this.taxonomyDraft.name='';this.loadAdminData();this.loadCategories();this.showMessage('تمت إضافة العنصر إلى قاعدة البيانات.');},error:()=>this.showMessage('تعذر الحفظ؛ لم تتغير البيانات.')});
  }
  toggleTaxon(type:'categories'|'brands', taxon:any) {
    this.http.patch(`${API}/admin/${type}/${taxon.id}`,{active:!taxon.active},{headers:this.adminHeaders()}).subscribe({next:()=>{this.loadAdminData();this.loadCategories();this.showMessage(taxon.active?'تمت أرشفة العنصر.':'تم تفعيل العنصر.');},error:()=>this.showMessage('تعذر تعديل العنصر في قاعدة البيانات.')});
  }
  renameTaxon(type:'categories'|'brands', taxon:any) {
    this.http.patch(`${API}/admin/${type}/${taxon.id}`,{name:taxon.name},{headers:this.adminHeaders()}).subscribe({next:()=>{this.loadAdminData();this.loadCategories();this.loadProducts();this.showMessage('تم تحديث الاسم في قاعدة البيانات.');},error:()=>this.showMessage('تعذر تحديث الاسم؛ راجع ارتباطات المنتجات.')});
  }
  deleteTaxon(type:'categories'|'brands', taxon:any) {
    if(!window.confirm(`حذف ${taxon.name} نهائياً؟ إذا كان مرتبطاً بمنتج، أعد تصنيف المنتج أو أرشف العنصر.`)) return;
    this.http.delete(`${API}/admin/${type}/${taxon.id}`,{headers:this.adminHeaders()}).subscribe({next:()=>{this.loadAdminData();this.loadCategories();this.showMessage('تم حذف العنصر غير المرتبط من قاعدة البيانات.');},error:error=>this.showMessage(error?.error?.error==='taxonomy_in_use'?'العنصر مرتبط بمنتجات. أعد تصنيف المنتجات أولاً أو استخدم الأرشفة.':'تعذر حذف العنصر؛ لم تتغير البيانات.')});
  }
  setAdminStatus(collection: string, row: any, status: string) { this.http.patch(`${API}/admin/${collection}/${row.id}/status`, { status }, { headers: this.adminHeaders() }).subscribe({ next: () => { this.showMessage('تم تحديث الحالة.'); this.loadAdminData(); }, error: () => this.showMessage('تعذر تحديث الحالة.') }); }
  setOrderStatus(order:any,status:string) { this.http.patch(`${API}/admin/orders/${order.id}/status`,{status},{headers:this.adminHeaders()}).subscribe({next:()=>{this.showMessage('تم تحديث حالة الطلب.');this.loadAdminOrders();},error:error=>{if(error?.error?.error==='reservation_expired'){this.showMessage('انتهت مهلة حجز واتساب وأُعيد المخزون.');this.loadAdminOrders();return;}this.showMessage('تعذر تحديث حالة الطلب.');this.loadAdminOrders();}}); }
  saveBranch(valid: boolean | null) { if (valid !== true) { this.showMessage('أدخل اسم الفرع والعنوان.'); return; } this.http.post(`${API}/admin/branches`, this.adminBranch, { headers: this.adminHeaders() }).subscribe({ next: () => { this.adminBranch = { name: '', address: '', mapsUrl: '' }; this.loadAdminData(); this.loadSiteInfo(); this.showMessage('تم حفظ الفرع.'); }, error: () => this.showMessage('تعذر حفظ الفرع.') }); }
  saveSettings() { const body = Object.fromEntries(this.adminSettings.map(s => [s.key,s.value])); this.http.put(`${API}/admin/settings`, body, { headers: this.adminHeaders() }).subscribe({ next: () => { this.loadSiteInfo(); this.showMessage('تم حفظ إعدادات الموقع.'); }, error: () => this.showMessage('تعذر حفظ الإعدادات.') }); }
  addCurrentSetting() { const {key,value}=this.newSettingDraft,normalized=key.trim(); const allowed=['business_name','currency','phone','whatsapp','whatsapp_link','instapay_number','wallet_number','facebook_url','instagram_url','email','business_hours','address','delivery_enabled','delivery_fee','delivery_note','hero_title','hero_subtitle','hero_description']; if(!allowed.includes(normalized)){this.showMessage('اختر مفتاحاً معتمداً من إعدادات التوصيل أو بيانات التواصل أو نصوص الرئيسية.');return;} if(this.adminSettings.some(row=>row.key===normalized)){this.showMessage('الإعداد موجود بالفعل؛ عدّل قيمته من القائمة.');return;} this.adminSettings=[...this.adminSettings,{key:normalized,value}];this.newSettingDraft={key:'',value:''}; }
  private async getOrderAttempt(method:'website'|'whatsapp', items:{id:string;quantity:number}[]) {
    const canonical={
      name:this.orderForm.name.trim(),email:this.orderForm.email.trim().toLowerCase(),
      phone:this.orderForm.phone.trim(),governorate:this.orderForm.governorate.trim(),
      city:this.orderForm.city.trim(),address:this.orderForm.address.trim(),method,
      items:[...items].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)
    };
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical)));
    const signature=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
    const storageKey=`dar-handasa-order-key:${signature}`;
    let idempotencyKey='';
    try {
      idempotencyKey=sessionStorage.getItem(storageKey)||'';
      if(!idempotencyKey){idempotencyKey=crypto.randomUUID();sessionStorage.setItem(storageKey,idempotencyKey);}
    } catch {
      if(this.memoryOrderAttempt?.storageKey===storageKey) idempotencyKey=this.memoryOrderAttempt.idempotencyKey;
      else idempotencyKey=crypto.randomUUID();
      this.memoryOrderAttempt={storageKey,idempotencyKey};
    }
    return {idempotencyKey,storageKey};
  }
  placeOrder(method:'website'|'whatsapp') {
    if(this.checkoutBusy||!this.cart().length) return;
    if(this.productsLoading||this.productsError) { this.checkoutError='تعذر التحقق من المخزون الحالي. انتظر تحديث الكتالوج أو أعد المحاولة.'; return; }
    if(this.cartHasUnavailableItems()) { this.checkoutError='توجد منتجات غير متاحة أو بكميات تتجاوز المخزون. راجع السلة قبل إتمام الطلب.'; return; }
    this.checkoutBusy=true;this.checkoutError='';
    if(method==='whatsapp') this.whatsappOrderUrl='';
    const items=this.cart().map(line=>({id:line.product.id,quantity:line.quantity}));
    void this.getOrderAttempt(method,items).then(attempt=>{
      this.http.post<{orderId:string;total:number;items:Product[];whatsappUrl?:string;reservationExpiresAt?:string;message?:string}>(`${API}/orders`,{...this.orderForm,method,items,idempotencyKey:attempt.idempotencyKey})
        .pipe(finalize(()=>{this.checkoutBusy=false;this.cdr.markForCheck();}))
        .subscribe({next:response=>{
          if(method==='whatsapp'&&response.whatsappUrl){
            this.whatsappAttemptStorageKey=attempt.storageKey;
            this.whatsappOrderId=response.orderId;
            if(!response.reservationExpiresAt||!this.watchWhatsAppReservationExpiry(response.reservationExpiresAt)){
              this.checkoutError='تم تسجيل محاولة واتساب، لكن تعذر التحقق من مهلة الحجز. أعد المحاولة بنفس البيانات للتحقق من الطلب دون إنشاء محاولة جديدة.';
              return;
            }
            this.whatsappOrderUrl=response.whatsappUrl;
            this.showMessage(this.whatsappReservationExpired?'قد تكون مهلة الحجز انتهت. تحقق من حالة الطلب قبل فتح واتساب.':'تم تجهيز الطلب وحجز المخزون لمدة 30 دقيقة. يمكنك إعادة فتح رابط واتساب للطلب نفسه.');return;
          }
          try { sessionStorage.removeItem(attempt.storageKey); } catch { /* The in-memory attempt is cleared below. */ }
          if(this.memoryOrderAttempt?.storageKey===attempt.storageKey) this.memoryOrderAttempt=null;
          this.clearWhatsAppReservationTimer();
          this.whatsappOrderId='';this.whatsappOrderUrl='';this.whatsappAttemptStorageKey='';this.whatsappReservationExpiresAt='';this.whatsappReservationExpired=false;
          this.cart.set([]);this.saveCart();this.showMessage(`تم تسجيل الطلب ${response.orderId.slice(0,8)} بإجمالي ${this.money(response.total)}.`);this.router.navigate(['/account/orders']);
        },error:error=>{
          const code=error?.error?.error;
          if(code==='reservation_expired') {
            this.clearOrderAttempt(attempt.storageKey);
            this.clearWhatsAppReservationTimer();
            this.whatsappOrderId='';this.whatsappReservationExpiresAt='';this.whatsappReservationExpired=false;
          }
          this.checkoutError=code==='insufficient_stock'?'الكمية المطلوبة غير متاحة حالياً. حدّث السلة وحاول مجدداً.':code==='product_unavailable'?'أحد المنتجات لم يعد منشوراً أو متاحاً. حدّث السلة قبل الطلب.':code==='reservation_expired'?'أكد الخادم انتهاء مهلة حجز واتساب وأُعيد المخزون. أُغلقت المحاولة السابقة؛ اضغط تجهيز طلب واتساب لبدء حجز جديد.':code==='idempotency_conflict'?'تغيرت تفاصيل الطلب أثناء إعادة المحاولة. راجع البيانات ثم أرسل الطلب من جديد.':code==='order_already_processed'?'الطلب نفسه موجود وحالته لم تعد معلقة؛ لم يتم إنشاء طلب آخر. لم تُمسح هوية المحاولة.' :code==='invalid_order'?'التوصيل غير متاح حالياً أو توجد بيانات ناقصة؛ تواصل مع الشركة.':code==='order_schema_not_applied'?'خدمة الطلبات تنتظر تطبيق ترحيل قاعدة البيانات. لم يتم إنشاء الطلب.':'تعذر تسجيل الطلب. لم يتم تأكيده؛ أعد المحاولة بنفس التفاصيل لإكمال المحاولة بأمان.';
          this.showMessage(this.checkoutError);
        }});
    }).catch(()=>{
      this.checkoutBusy=false;this.checkoutError='تعذر تجهيز محاولة آمنة للطلب في هذا المتصفح. حدّث المتصفح ثم أعد المحاولة.';this.showMessage(this.checkoutError);this.cdr.markForCheck();
    });
  }
  private clearWhatsAppReservationTimer() {
    if(this.whatsappReservationExpiryTimer) clearTimeout(this.whatsappReservationExpiryTimer);
    this.whatsappReservationExpiryTimer=null;
  }
  private watchWhatsAppReservationExpiry(expiresAt:string): boolean {
    const expiry=Date.parse(expiresAt);
    if(!Number.isFinite(expiry)) return false;
    this.clearWhatsAppReservationTimer();
    this.whatsappReservationExpiresAt=new Date(expiry).toISOString();
    const remaining=expiry-Date.now();
    this.whatsappReservationExpired=remaining<=0;
    if(remaining>0) this.whatsappReservationExpiryTimer=setTimeout(()=>{this.whatsappReservationExpired=true;this.cdr.markForCheck();},remaining);
    return true;
  }
  checkWhatsAppReservation() {
    if(!this.whatsappOrderId||!this.whatsappAttemptStorageKey) return;
    this.placeOrder('whatsapp');
  }
  private clearOrderAttempt(storageKey:string) {
    try { sessionStorage.removeItem(storageKey); } catch { /* session storage can be disabled by browser policy */ }
    if(this.memoryOrderAttempt?.storageKey===storageKey) this.memoryOrderAttempt=null;
    if(this.whatsappAttemptStorageKey===storageKey) { this.whatsappAttemptStorageKey=''; this.whatsappOrderUrl=''; }
  }
  adminLogout() { this.adminToken = ''; localStorage.removeItem('dar-handasa-admin-token'); this.adminProducts = []; }
  money(value: number) { return new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 }).format(value) + ` ${this.siteSettings.currency || 'EGP'}`; }
  deliveryFee() { const value=Number(this.siteSettings.delivery_fee||0); return Number.isFinite(value)&&value>=0?value:0; }
  deliveryEnabled() { return !['false','0','no','لا'].includes(String(this.siteSettings.delivery_enabled??'true').trim().toLowerCase()); }
  async copyPaymentNumber(value: string, label: string) {
    const exactNumber = label === 'InstaPay' ? OFFICIAL_CONTACT.instapay_number! : OFFICIAL_CONTACT.wallet_number!;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(exactNumber); copied = true; }
    } catch { /* Fall through to the legacy copy path when clipboard permissions are unavailable. */ }
    if (!copied) {
      const field = document.createElement('textarea');
      field.value = exactNumber;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.appendChild(field); field.select();
      try { copied = document.execCommand('copy'); } finally { field.remove(); }
    }
    this.showMessage(copied
      ? (label === 'InstaPay' ? 'تم نسخ رقم InstaPay بنجاح' : 'تم نسخ رقم المحفظة بنجاح')
      : 'تعذر النسخ تلقائياً. يرجى تحديد الرقم ونسخه يدوياً.');
  }
}

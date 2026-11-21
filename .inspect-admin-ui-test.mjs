import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const url = `${process.env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/products?sku=eq.TCBNLI500857&select=sku,price,stock_quantity,active,archived_at`;
const response = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } });
const rows = await response.json();
if (!response.ok) throw new Error(`supabase_read_${response.status}`);
console.log(JSON.stringify(rows.map(({sku, price, stock_quantity, active, archived_at}) => ({sku, price, stock_quantity, active, archived_at}))));

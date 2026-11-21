function credentials() {
  return { projectUrl: process.env.SUPABASE_URL?.replace(/\/+$/, ''), serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

export function isSupabaseConfigured() { const { projectUrl, serviceRoleKey } = credentials(); return Boolean(projectUrl && serviceRoleKey); }

export async function supabaseRequest(path, { method = 'GET', body, prefer } = {}) {
  const { projectUrl, serviceRoleKey } = credentials();
  if (!projectUrl || !serviceRoleKey) {
    const error = new Error('supabase_not_configured');
    error.code = 'supabase_not_configured';
    throw error;
  }
  const response = await fetch(`${projectUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(data?.message || `Supabase request failed (${response.status})`);
    error.code = data?.code || `supabase_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return data;
}

export function supabaseTable(table, query = '') { return `${table}${query ? `?${query}` : ''}`; }

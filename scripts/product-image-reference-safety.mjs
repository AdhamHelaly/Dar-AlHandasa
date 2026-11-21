const URL_TOKEN = /https?:\/\/[^\s"'<>]+/gi;
const URL_END_PUNCTUATION = /[),.;!?\]}]+$/g;

function parseCandidate(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'ipegazjnkejasorskdur.supabase.co' || url.username || url.password || url.search || url.hash) return null;
    const decodedPath = decodeURIComponent(url.pathname);
    const match = decodedPath.match(/^\/storage\/v1\/object\/public\/product-images\/(products\/([0-9a-f-]{36}\/[^/]+))$/i);
    if (!match) return null;
    return { origin: url.origin.toLowerCase(), path: decodedPath, pathFolded: decodedPath.toLowerCase() };
  } catch { return null; }
}

function decodePercentRuns(value) {
  let malformed = false;
  const decoded = value.replace(/(?:%[0-9a-f]{2})+|%(?![0-9a-f]{2})/gi, token => {
    if (token === '%' || /^%(?![0-9a-f]{2})/i.test(token)) { malformed = true; return token; }
    try { return decodeURIComponent(token); }
    catch { malformed = true; return token; }
  });
  return { value: decoded, malformed };
}

function snapshotVariants(snapshot) {
  const variants = new Set([snapshot]);
  let jsonParsed = false;
  try {
    const parsed = JSON.parse(snapshot);
    jsonParsed = true;
    const collect = value => {
      if (typeof value === 'string') variants.add(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(parsed);
  } catch { /* Plain-text snapshots are expected; they are scanned below. */ }

  // Recognize common JSON string escaping even when the snapshot embeds JSON in prose.
  for (const value of [...variants]) variants.add(value.replace(/\\\//g, '/').replace(/\\u([0-9a-f]{4})/gi, (_all, hex) => String.fromCharCode(parseInt(hex, 16))));
  let malformedPercent = false;
  let excessiveEncoding = false;
  for (let pass = 0; pass < 16; pass++) {
    let changed = false;
    for (const value of [...variants]) {
      const decoded = decodePercentRuns(value);
      malformedPercent ||= decoded.malformed;
      if (decoded.value !== value) { variants.add(decoded.value); changed = true; }
    }
    if (!changed) break;
    if (pass === 15) excessiveEncoding = true;
  }
  return { variants: [...variants], malformedPercent, jsonParsed, excessiveEncoding };
}

function compareUrlToken(token, target) {
  try {
    const url = new URL(token);
    if (url.username || url.password) return 'ambiguous';
    let path;
    try { path = decodeURIComponent(url.pathname); }
    catch { return url.hostname.toLowerCase() === 'ipegazjnkejasorskdur.supabase.co' ? 'ambiguous' : 'different'; }
    const origin = url.origin.toLowerCase();
    if (origin === target.origin && path === target.path) return 'same';
    if (origin === target.origin && path.toLowerCase() === target.pathFolded) return 'ambiguous';
    // HTTP vs HTTPS or a non-default port on the same project can still resolve to the same object.
    if (url.hostname.toLowerCase() === 'ipegazjnkejasorskdur.supabase.co'
      && path.toLowerCase() === target.pathFolded) return path === target.path ? 'ambiguous' : 'ambiguous';
    return 'different';
  } catch {
    return /ipegazjnkejasorskdur\.supabase\.co|product-images|storage/i.test(token) ? 'ambiguous' : 'different';
  }
}

/**
 * quote_requests.products is free-form text. Return a deletion decision only when every
 * relevant representation is confidently inspected. Ambiguity always blocks deletion.
 */
export function inspectQuoteSnapshotImageReference(rows, exactPublicUrl) {
  const target = parseCandidate(exactPublicUrl);
  if (!Array.isArray(rows) || !target) return { inspectable: false, referenced: false, ambiguous: true, reason: 'candidate_or_snapshot_uninspectable' };

  for (const row of rows) {
    if (typeof row?.products !== 'string') return { inspectable: false, referenced: false, ambiguous: true, reason: 'quote_snapshot_not_text' };
    const { variants, malformedPercent, jsonParsed, excessiveEncoding } = snapshotVariants(row.products);
    let ambiguous = excessiveEncoding;
    let recognizedCandidateHost = false;
    const targetObjectKey = target.path.split('/product-images/')[1];
    for (const variant of variants) {
      if (targetObjectKey && variant.includes(targetObjectKey)) return { inspectable: true, referenced: true, ambiguous: false, reason: 'exact_storage_object_path_reference' };
      if (targetObjectKey && variant.toLowerCase().includes(targetObjectKey.toLowerCase())) ambiguous = true;
      for (const rawToken of variant.match(URL_TOKEN) || []) {
        const token = rawToken.replace(URL_END_PUNCTUATION, '');
        try { if (new URL(token).hostname.toLowerCase() === 'ipegazjnkejasorskdur.supabase.co') recognizedCandidateHost = true; } catch {}
        const result = compareUrlToken(token, target);
        if (result === 'same') return { inspectable: true, referenced: true, ambiguous: false, reason: 'exact_storage_object_reference' };
        if (result === 'ambiguous') ambiguous = true;
      }
    }
    const targetHost = exactPublicUrl.match(/^https?:\/\/([^/]+)/i)?.[1]?.toLowerCase() || '';
    const hasCandidateHints = variants.some(value => {
      const normalized = value.toLowerCase();
      return normalized.includes(targetHost) || normalized.includes('product-images') || normalized.includes('/storage/v1/object') || (targetObjectKey && normalized.includes(targetObjectKey.toLowerCase()));
    });
    if (hasCandidateHints && !recognizedCandidateHost) ambiguous = true;
    const encodedSchemeHint = /(?:https?%3a|%68%74%74%70(?:%73)?%3a)/i.test(row.products);
    if (malformedPercent && (hasCandidateHints || encodedSchemeHint)) ambiguous = true;
    if (!jsonParsed && /\\u(?:002f|003a|002e)/i.test(row.products) && hasCandidateHints) ambiguous = true;
    if (ambiguous) return { inspectable: false, referenced: false, ambiguous: true, reason: 'quote_snapshot_url_ambiguous' };
  }
  return { inspectable: true, referenced: false, ambiguous: false, reason: 'no_matching_storage_object_reference' };
}

export function inspectStorageUrlReferenceValues(values, exactPublicUrl) {
  if (!Array.isArray(values)) return { inspectable: false, referenced: false, ambiguous: true, reason: 'image_references_uninspectable' };
  if (values.some(value => value !== null && value !== '' && typeof value !== 'string')) return { inspectable: false, referenced: false, ambiguous: true, reason: 'image_reference_not_text' };
  return inspectQuoteSnapshotImageReference(values.filter(value => typeof value === 'string' && value !== '').map(products => ({ products })), exactPublicUrl);
}

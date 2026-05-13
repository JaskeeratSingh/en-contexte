


export const $ = (id) => document.getElementById(id);

export const escapeHtml = (s) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ============================================================
   IndexedDB layer
   ============================================================ */

export function todayStr() {
  const d = new Date();
  // Use local-time YYYY-MM-DD so "today" matches the user's perception
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


export function yesterdayStr(fromIso) {
  const [y, m, d] = fromIso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

export function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}


export function normForCompare(s, { strict = false } = {}) {
  let v = (s || '').trim().toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[«»"]/g, '');
  if (!strict) v = stripDiacritics(v);
  return v;
}


export function checkTypedAnswer(typed, correct) {
  // Strict mode: case-insensitive but accent-sensitive. With accent helper
  // buttons available, users can always type the exact correct form.
  // Returns 'right' | 'wrong'.
  if (!typed) return 'wrong';
  const a = normForCompare(typed, { strict: true });
  const b = normForCompare(correct, { strict: true });
  return a === b ? 'right' : 'wrong';
}

/* ============================================================
   Gameplay
   ============================================================ */

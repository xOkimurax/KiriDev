// Motor de filtros y orden para tablas/listas. PURO (sin dependencias): el MISMO archivo vive en server/src/filters.js y web/src/components/filters.js
// (el build de la web no ve la carpeta del servidor). Si se cambia uno, copiar al otro: `node scripts/check-filters-sync.mjs` lo verifica.
//
// Especificación:  { match: 'all' | 'any', conds: [{ field, op, value, value2 }], sort: { field, dir: 'asc' | 'desc' } | null }

/** Grupo de comportamiento de cada tipo de campo. */
export const GROUP = (type) => ({ text: 'text', url: 'text', number: 'number', money: 'number', date: 'date', datetime: 'date', select: 'select', checkbox: 'checkbox' }[type] || 'text');

export const OPS = {
  text: ['contains', 'not_contains', 'eq', 'neq', 'starts', 'ends', 'empty', 'not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty'],
  date: ['on', 'before', 'after', 'between', 'today', 'yesterday', 'tomorrow', 'this_week', 'this_month', 'last_month', 'last_7', 'next_7', 'past', 'future', 'empty', 'not_empty'],
  select: ['in', 'not_in', 'empty', 'not_empty'],
  checkbox: ['is_true', 'is_false'],
};
export const OP_LABEL = {
  contains: 'contiene', not_contains: 'no contiene', eq: 'es igual a', neq: 'es distinto de', starts: 'empieza con', ends: 'termina con', empty: 'está vacío', not_empty: 'no está vacío',
  gt: 'mayor que', gte: 'mayor o igual que', lt: 'menor que', lte: 'menor o igual que', between: 'entre',
  on: 'es el', before: 'antes del', after: 'después del', today: 'es hoy', yesterday: 'fue ayer', tomorrow: 'es mañana', this_week: 'esta semana', this_month: 'este mes', last_month: 'el mes pasado', last_7: 'últimos 7 días', next_7: 'próximos 7 días', past: 'ya pasó', future: 'es futuro',
  in: 'es uno de', not_in: 'no es ninguno de', is_true: 'está marcado (sí)', is_false: 'no está marcado (no)',
};
/** Cuántos valores pide cada operador (0 = ninguno, 1 = uno, 2 = dos). */
export const NEEDS = (op) => (['between'].includes(op) ? 2 : ['empty', 'not_empty', 'today', 'yesterday', 'tomorrow', 'this_week', 'this_month', 'last_month', 'last_7', 'next_7', 'past', 'future', 'is_true', 'is_false'].includes(op) ? 0 : 1);

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
export function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').trim().replace(/[^\d,.\-]/g, '');
  if (!s) return null;
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lc > -1) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  else if (ld > -1 && /\.\d{3}(\.|$)/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const day = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? '')); if (m) return `${m[1]}-${m[2]}-${m[3]}`; const d = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(String(v ?? '')); return d ? `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}` : null; };
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
const dow = (s) => { const [y, m, d] = s.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; }; // lunes = 0
const monthEnd = (s) => { const [y, m] = s.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
/** Rango [desde, hasta] (inclusive, 'AAAA-MM-DD') de un operador relativo a `today`. */
export function relativeRange(op, today) {
  const t = today;
  switch (op) {
    case 'today': return [t, t];
    case 'yesterday': return [addDays(t, -1), addDays(t, -1)];
    case 'tomorrow': return [addDays(t, 1), addDays(t, 1)];
    case 'this_week': { const a = addDays(t, -dow(t)); return [a, addDays(a, 6)]; }
    case 'this_month': return [`${t.slice(0, 8)}01`, monthEnd(t)];
    case 'last_month': { const first = addDays(`${t.slice(0, 8)}01`, -1); return [`${first.slice(0, 8)}01`, first]; }
    case 'last_7': return [addDays(t, -7), t];
    case 'next_7': return [t, addDays(t, 7)];
    case 'past': return ['0000-01-01', addDays(t, -1)];
    case 'future': return [addDays(t, 1), '9999-12-31'];
    default: return null;
  }
}
const listOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;|]/)).map(norm).filter(Boolean);

/** ¿Este valor cumple la condición? `group` es el grupo del campo (text/number/date/select/checkbox). */
export function matchCond(v, c, group, today) {
  const op = c.op;
  if (op === 'empty') return group === 'checkbox' ? !v : isEmpty(v);
  if (op === 'not_empty') return group === 'checkbox' ? !!v : !isEmpty(v);
  if (group === 'checkbox') return op === 'is_true' ? !!v : op === 'is_false' ? !v : true;
  if (group === 'select') { const l = listOf(c.value), x = norm(v); if (!l.length) return true; return op === 'in' ? l.includes(x) : op === 'not_in' ? !l.includes(x) : true; }
  if (group === 'number') {
    const n = parseNum(v), a = parseNum(c.value), b = parseNum(c.value2);
    if (n === null) return op === 'neq'; // sin valor: solo cumple "distinto de"
    if (a === null && op !== 'between') return true;
    return op === 'eq' ? n === a : op === 'neq' ? n !== a : op === 'gt' ? n > a : op === 'gte' ? n >= a : op === 'lt' ? n < a : op === 'lte' ? n <= a : op === 'between' ? n >= Math.min(a ?? n, b ?? n) && n <= Math.max(a ?? n, b ?? n) : true;
  }
  if (group === 'date') {
    const d = day(v); if (!d) return false;
    const rel = relativeRange(op, today || new Date().toISOString().slice(0, 10));
    if (rel) return d >= rel[0] && d <= rel[1];
    const a = day(c.value), b = day(c.value2);
    if (!a && op !== 'between') return true;
    return op === 'on' ? d === a : op === 'before' ? d < a : op === 'after' ? d > a : op === 'between' ? d >= (a && b ? (a < b ? a : b) : a || d) && d <= (a && b ? (a < b ? b : a) : b || d) : true;
  }
  // texto
  const x = norm(v), y = norm(c.value);
  if (!y && !['neq', 'not_contains'].includes(op)) return true; // condición sin valor todavía: no filtra
  return op === 'contains' ? x.includes(y) : op === 'not_contains' ? !x.includes(y) : op === 'eq' ? x === y : op === 'neq' ? x !== y : op === 'starts' ? x.startsWith(y) : op === 'ends' ? x.endsWith(y) : true;
}

const slug = (t) => norm(t).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
export const findField = (fields, ref) => fields.find((f) => f.key === ref) || fields.find((f) => slug(f.label) === slug(ref)) || null;

/** Valida y normaliza una especificación contra los campos. Lanza un Error con un mensaje claro (lo ve el agente). */
export function cleanSpec(spec, fields) {
  if (spec === undefined || spec === null || spec === '') return null;
  let s = spec; if (typeof s === 'string') { try { s = JSON.parse(s); } catch { throw Object.assign(new Error('El filtro no es un JSON válido.'), { status: 400 }); } }
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const conds = (Array.isArray(s.conds) ? s.conds : Array.isArray(s.conditions) ? s.conditions : []).slice(0, 20).map((c) => {
    const f = findField(fields, c.field); if (!f) throw bad(`El filtro usa un campo que no existe: «${c.field}». Campos: ${fields.map((x) => x.key).join(', ')}.`);
    const g = GROUP(f.type), op = c.op; if (!OPS[g].includes(op)) throw bad(`Operador «${op}» no válido para «${f.label}» (${f.type}). Usá: ${OPS[g].join(', ')}.`);
    const n = NEEDS(op), out = { field: f.key, op };
    if (n >= 1) out.value = g === 'select' ? (Array.isArray(c.value) ? c.value.map(String) : String(c.value ?? '').split(/[,;|]/).map((x) => x.trim()).filter(Boolean)) : c.value ?? '';
    if (n === 2) out.value2 = c.value2 ?? '';
    return out;
  });
  let sort = null;
  if (s.sort && (s.sort.field || typeof s.sort === 'string')) { const f = findField(fields, s.sort.field || s.sort); if (!f) throw bad(`No se puede ordenar por «${s.sort.field || s.sort}»: ese campo no existe.`); sort = { field: f.key, dir: s.sort.dir === 'desc' ? 'desc' : 'asc' }; }
  if (!conds.length && !sort) return null;
  return { match: s.match === 'any' ? 'any' : 'all', conds, sort };
}

export const hasSpec = (s) => !!s && ((s.conds?.length || 0) > 0 || !!s.sort);
/** ¿La condición ya filtra algo? (una condición recién agregada, sin valor, todavía no). */
export const condActive = (c) => NEEDS(c.op) === 0 || !(c.value === undefined || c.value === '' || (Array.isArray(c.value) && !c.value.length));
/** Cuántos filtros están realmente aplicados (condiciones con valor + el orden). */
export const activeCount = (s) => (s?.conds || []).filter(condActive).length + (s?.sort ? 1 : 0);

/** Aplica el filtro y el orden. `rows` son objetos {clave: valor}. */
export function applySpec(rows, fields, spec, today) {
  if (!hasSpec(spec)) return rows;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const conds = (spec.conds || []).map((c) => ({ c, g: GROUP(byKey.get(c.field)?.type), ok: byKey.has(c.field) })).filter((x) => x.ok);
  let out = conds.length ? rows.filter((r) => (spec.match === 'any' ? conds.some(({ c, g }) => matchCond(r[c.field], c, g, today)) : conds.every(({ c, g }) => matchCond(r[c.field], c, g, today)))) : rows;
  const sf = spec.sort && byKey.get(spec.sort.field);
  if (sf) {
    const g = GROUP(sf.type), dir = spec.sort.dir === 'desc' ? -1 : 1;
    const key = (r) => { const v = r[sf.key]; return isEmpty(v) ? null : g === 'number' ? parseNum(v) : g === 'checkbox' ? (v ? 1 : 0) : g === 'date' ? String(v) : norm(v); };
    out = out.map((r, i) => [r, i, key(r)]).sort((a, b) => (a[2] === null) - (b[2] === null) || (a[2] === null ? 0 : (a[2] < b[2] ? -dir : a[2] > b[2] ? dir : 0)) || a[1] - b[1]).map((x) => x[0]);
  }
  return out;
}

/** Texto corto de una condición ("Precio ≥ 1000") para mostrarla como etiqueta. */
export function describeCond(c, field) {
  const v = (x) => (Array.isArray(x) ? x.join(', ') : x);
  const n = NEEDS(c.op);
  return `${field?.label || c.field} ${OP_LABEL[c.op] || c.op}${n >= 1 ? ` ${v(c.value) === '' ? '…' : v(c.value)}` : ''}${n === 2 ? ` y ${v(c.value2) === '' ? '…' : v(c.value2)}` : ''}`;
}

/** Infiere el tipo de cada columna de una hoja (para filtrar CSV/Excel y listas): number | date | text. */
export function inferFields(head, rows) {
  return head.map((h, i) => {
    const vals = rows.map((r) => r[i]).filter((v) => !isEmpty(v));
    const sample = vals.slice(0, 200);
    const nums = sample.filter((v) => parseNum(v) !== null && /^[\s\d.,\-+%$₲US]*$/.test(String(v))).length;
    const dates = sample.filter((v) => day(v) && /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}/.test(String(v))).length;
    const distinct = new Set(sample.map((v) => String(v))).size;
    const type = sample.length && dates / sample.length > 0.8 ? 'date' : sample.length && nums / sample.length > 0.8 ? 'number' : sample.length >= 8 && distinct <= 12 && distinct / sample.length < 0.5 ? 'select' : 'text';
    return { key: `c${i}`, label: String(h || `Columna ${i + 1}`), type, ...(type === 'select' ? { options: [...new Set(sample.map((v) => String(v)))].sort() } : {}) };
  });
}

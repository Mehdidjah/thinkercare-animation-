type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): value is RecordValue[] =>
  Array.isArray(value) && value.length <= 5000 && value.every(record);
const numeric = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
function invalid(): never {
  throw new Error('La réponse reçue est incomplète. Actualisez pour réessayer.');
}
function figures(value: unknown, keys: string[]) {
  if (!record(value) || !keys.every(key => numeric(value[key]))) invalid();
}
function rows(value: unknown, keys: string[]) {
  if (!list(value) || !value.every(row => keys.every(key => numeric(row[key])))) invalid();
}
export function checkedResult(query: string, value: unknown): unknown {
  const action = new URLSearchParams(query).get('action');
  if (!action) return value;
  if (!record(value)) invalid();
  if (action === 'performance') {
    figures(value.totals, ['tickets', 'revenue', 'bonus', 'units']);
    rows(value.people, ['tickets', 'revenue', 'bonus']);
    rows(value.stores, ['tickets', 'revenue', 'bonus']);
    rows(value.days, ['tickets', 'revenue', 'bonus']);
    rows(value.products, ['tickets', 'revenue', 'units']);
    rows(value.brands, ['tickets', 'revenue', 'units']);
    if (typeof value.truncated !== 'boolean') invalid();
  } else if (action === 'bonuses') {
    figures(value.today, ['tickets', 'bonus', 'revenue']);
    figures(value.month, ['tickets', 'bonus', 'revenue']);
    rows(value.months, ['tickets', 'bonus', 'revenue']);
    rows(value.days, ['tickets', 'bonus', 'revenue']);
  } else if (action === 'field-notes') {
    if (!list(value.notes) || !value.notes.every(row =>
      typeof row.id === 'string' && typeof row.description === 'string'
      && typeof row.store_name === 'string' && typeof row.author_name === 'string'
      && typeof row.competitor === 'string')) invalid();
  } else if (action === 'field-note') {
    if (!record(value.note) || !list(value.photos)) invalid();
  } else if (action === 'service-list') {
    if (!list(value.cases) || !value.cases.every(row =>
      typeof row.id === 'string' && typeof row.kind === 'string'
      && typeof row.store_name === 'string' && typeof row.author_name === 'string')) invalid();
  } else if (action === 'service-detail') {
    if (!record(value.case) || !list(value.events)) invalid();
  }
  return value;
}
export function photoPath(id: unknown): string {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) invalid();
  return '/api/field-photos?' + new URLSearchParams({id}).toString();
}

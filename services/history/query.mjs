const ALLOWED_PARAMETERS = new Set(['from', 'to', 'stationId', 'limit', 'cursor']);
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/i;
const MAX_LIMIT = 5000;
const MAX_CURSOR = 9223372036854775807n;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_query' });
}

function queryDate(value, name) {
  const parts = value && RFC3339.exec(value);
  if (!parts) throw invalid(`${name} must be an RFC 3339 timestamp with a timezone.`);
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, , , rawOffsetHour, rawOffsetMinute] = parts;
  const year = Number(rawYear), month = Number(rawMonth), day = Number(rawDay);
  const hour = Number(rawHour), minute = Number(rawMinute), second = Number(rawSecond);
  const offsetHour = Number(rawOffsetHour || 0), offsetMinute = Number(rawOffsetMinute || 0);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw invalid(`${name} is not a valid timestamp.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw invalid(`${name} is not a valid timestamp.`);
  return parsed;
}

export function parseAvailabilityHistoryQuery(searchParams) {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(key)) throw invalid(`Unsupported query parameter: ${key}.`);
    if (searchParams.getAll(key).length !== 1) throw invalid(`Query parameter ${key} must be provided once.`);
  }

  const from = queryDate(searchParams.get('from'), 'from');
  const to = queryDate(searchParams.get('to'), 'to');
  if (from >= to) throw invalid('from must be earlier than to.');

  const stationId = searchParams.get('stationId');
  if (stationId != null && (!stationId.trim() || stationId.length > 100 || /[\u0000-\u001f]/.test(stationId))) {
    throw invalid('stationId must be a non-empty ID of at most 100 characters.');
  }

  const rawLimit = searchParams.get('limit') ?? '1000';
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_LIMIT) {
    throw invalid(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }

  const cursor = searchParams.get('cursor');
  if (cursor != null) {
    if (!/^[1-9]\d{0,18}$/.test(cursor) || BigInt(cursor) > MAX_CURSOR) {
      throw invalid('cursor must be a positive snapshot ID.');
    }
  }

  return { from, to, stationId, limit: Number(rawLimit), cursor };
}

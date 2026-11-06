export function madridParts(now = Date.now()) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
}

export function parseMinutes(text, now = Date.now()) {
  const normalized = text.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  if (/^(proximo|proxim|en parada|llegando)$/.test(normalized)) return { seconds: 60, programmed: false };
  const minutes = /^(\d+(?:[.,]\d+)?)\s*(?:min(?:utos?|uts?)?\.?)?$/.exec(normalized);
  if (minutes) return { seconds: Number(minutes[1].replace(',', '.')) * 60, programmed: false };
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(normalized);
  if (!time || +time[1] > 23 || +time[2] > 59 || +(time[3] || 0) > 59) return null;
  const parts = madridParts(now);
  const current = +parts.hour * 3600 + +parts.minute * 60 + +parts.second;
  const target = +time[1] * 3600 + +time[2] * 60 + +(time[3] || 0);
  return { seconds: (target - current + 86400) % 86400, programmed: true };
}

export function parseArrivals(xml, now = Date.now(), Parser = globalThis.DOMParser) {
  const doc = new Parser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror') || !doc.querySelector('estimacion')) throw new Error('EMT returned an invalid response.');
  const buses = [...doc.querySelectorAll('solo_parada bus')];
  const nodes = buses.length ? buses : [...doc.querySelectorAll('bus')];
  const errors = [...doc.querySelectorAll('error')].map(n => n.textContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const arrivals = nodes.flatMap(bus => {
    const text = tag => bus.querySelector(tag)?.textContent.trim() || '';
    const line = text('linea'), raw = text('minutos');
    const parsed = parseMinutes(raw, now);
    if (!line || !parsed) return [];
    return [{ line, destination: text('destino'), raw, ...parsed, observedAt: now, arrivalAt: now + parsed.seconds * 1000 }];
  });
  if (!arrivals.length && errors.length) throw new Error(errors[0]);
  return arrivals.sort((a, b) => a.arrivalAt - b.arrivalAt);
}

let nextId = 0;
// SAE has no vehicle IDs. Reconcile arrivals one-to-one by line, destination and time.
export function reconcileArrivals(previous, incoming) {
  const available = new Set(previous.filter(p => !p.programmed));
  return incoming.map(arrival => {
    if (arrival.vehicleId) return { ...arrival, id: `vehicle-${arrival.line}-${arrival.vehicleId}` };
    let match = null, difference = 150001;
    if (!arrival.programmed) for (const old of available) {
      const delta = Math.abs(old.arrivalAt - arrival.arrivalAt);
      if (old.line === arrival.line && old.destination === arrival.destination && delta < difference) { match = old; difference = delta; }
    }
    if (match) available.delete(match);
    return { ...arrival, id: match?.id || `estimate-${++nextId}` };
  });
}

export function adjustedArrivalAt(arrival, approach, now = Date.now(), speedKmh = 12) {
  const distance = approach?.vehicleDistance;
  if (!arrival.position || !Number.isFinite(distance) || speedKmh <= 0) return arrival.arrivalAt;
  const measuredAt = arrival.position.timestamp ?? arrival.position.receivedAt ?? arrival.observedAt;
  if (!Number.isFinite(measuredAt) || now - measuredAt > 90000 || now - arrival.observedAt > 90000) return arrival.arrivalAt;
  const locationArrivalAt = measuredAt + distance / (speedKmh / 3.6) * 1000;
  return arrival.arrivalAt == null ? locationArrivalAt : Math.min(arrival.arrivalAt, locationArrivalAt);
}

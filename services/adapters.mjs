const point = coords => ({ type: 'Point', coordinates: coords });

export function stationEntity(operator, item) {
  return {
    operator, id: String(item.id), name: String(item.name || item.id),
    location: point(item.coords), lineIds: item.lines ?? null,
    capacity: item.capacity ?? null, availableBikes: item.availableBikes ?? null,
    availableDocks: item.availableDocks ?? null, status: item.status ?? null,
    lastUpdated: item.lastUpdated ? new Date(item.lastUpdated).toISOString() : null,
  };
}

export function lineEntity(operator, item) {
  return { operator, id: String(item.id), name: item.name || String(item.id), color: item.color || null };
}

export function positionEntity(position) {
  if (!position) return null;
  if (position.location) return position;
  return {
    location: point(position.coords), kind: position.kind,
    measuredAt: Number.isFinite(position.timestamp) ? new Date(position.timestamp).toISOString() : null,
    receivedAt: Number.isFinite(position.receivedAt) ? new Date(position.receivedAt).toISOString() : null,
  };
}

export function arrivalEntity(operator, arrival) {
  return {
    operator, lineId: String(arrival.line), destination: arrival.destination || null,
    raw: arrival.raw || null, arrivalAt: Number.isFinite(arrival.arrivalAt) ? new Date(arrival.arrivalAt).toISOString() : null,
    observedAt: Number.isFinite(arrival.observedAt) ? new Date(arrival.observedAt).toISOString() : null,
    kind: arrival.programmed ? 'scheduled' : 'realtime', vehicleId: arrival.vehicleId == null ? null : String(arrival.vehicleId),
    position: positionEntity(arrival.position), occupancy: arrival.occupancy == null ? null : String(arrival.occupancy),
    platform: arrival.platform || null,
  };
}

export function vehicleEntity(operator, arrival) {
  return {
    operator, lineId: String(arrival.line), vehicleId: arrival.vehicleId == null ? null : String(arrival.vehicleId),
    destination: arrival.destination || null, position: positionEntity(arrival.position),
  };
}

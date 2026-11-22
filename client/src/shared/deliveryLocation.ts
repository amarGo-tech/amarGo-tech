export type DeliveryLocation = { latitude: number; longitude: number; accuracy?: number };

export function watchAccurateLocation({
  geolocation,
  onPosition,
  onComplete,
  onError,
  durationMs = 20_000,
  now = Date.now,
}: {
  geolocation: Pick<Geolocation, "watchPosition" | "clearWatch">;
  onPosition: (position: DeliveryLocation) => void;
  onComplete: (position: DeliveryLocation) => void;
  onError: (error: { code: number; message: string }) => void;
  durationMs?: number;
  now?: () => number;
}) {
  let best: DeliveryLocation | undefined;
  let closed = false;
  let watchId: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = now();
  function stop() {
    closed = true;
    if (watchId !== undefined) geolocation.clearWatch(watchId);
    if (timer !== undefined) clearTimeout(timer);
  }
  function finish() {
    if (closed) return;
    stop();
    if (best) onComplete(best);
    else onError({ code: 3, message: "Шинэ GPS хэмжилт авч чадсангүй." });
  }
  timer = setTimeout(finish, durationMs);
  try {
    watchId = geolocation.watchPosition((position) => {
      if (closed) return;
      const point = {
        latitude: position.coords.latitude, longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      if (!validCoordinates(point) || !Number.isFinite(point.accuracy) || point.accuracy <= 0
        || !Number.isFinite(position.timestamp) || position.timestamp < startedAt - 5000
        || position.timestamp > now() + 5000) return;
      if (!best || point.accuracy < Number(best.accuracy)) {
        best = point;
        onPosition(point);
      }
      if (point.accuracy <= 30) finish();
    }, (error) => {
      if (closed) return;
      if (error.code === 1) { stop(); onError(error); }
      // A timeout or temporary unavailable fix can be followed by a better fix.
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: durationMs });
    if (closed && watchId !== undefined) geolocation.clearWatch(watchId);
  } catch {
    stop();
    onError({ code: 2, message: "Байршил авах боломжгүй байна." });
  }
  return stop;
}

export function validCoordinates(location: DeliveryLocation) {
  return Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90
    && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180;
}

export function preciseLocation(location: DeliveryLocation) {
  return validCoordinates(location) && Number.isFinite(location.accuracy)
    && Number(location.accuracy) > 0 && Number(location.accuracy) <= 100;
}

export type AddressPlace = {
  place_id?: number;
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  address?: Record<string, string | undefined>;
};

export function addressSuggestion(place: AddressPlace, location: DeliveryLocation) {
  const point = { latitude: Number(place.lat), longitude: Number(place.lon) };
  if (!validCoordinates(point)) return null;
  const radians = Math.PI / 180;
  const deltaLat = (point.latitude - location.latitude) * radians;
  const deltaLng = (point.longitude - location.longitude) * radians;
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(location.latitude * radians)
    * Math.cos(point.latitude * radians) * Math.sin(deltaLng / 2) ** 2;
  const meters = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  if (meters > 150) return null;
  const address = place.address ?? {};
  const label = [
    [address.road ?? address.pedestrian ?? address.footway, address.house_number].filter(Boolean).join(" "),
    address.neighbourhood ?? address.suburb ?? address.city_district ?? address.district,
    address.city ?? address.town ?? address.state,
  ].filter(Boolean).join(", ");
  if (!label) return null;
  return { id: String(place.place_id ?? "gps"), label, detail: label };
}

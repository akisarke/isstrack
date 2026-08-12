const DEG = Math.PI / 180;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

export function formatDegrees(value) {
  if (value == null || !Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  const dir = value >= 0 ? 'N' : 'S';
  return `${deg}°${min.toFixed(2)}' ${dir}`;
}

export function formatKm(value) {
  if (value == null || !Number.isFinite(value)) return '--';
  return `${Number(value).toFixed(1)} km`;
}

export function formatUTC(date) {
  if (!date) return '--';
  return date.toISOString().slice(11, 19) + 'Z';
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m} min ${s} sec`;
}

export function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const lat1Rad = lat1 * DEG;
  const lat2Rad = lat2 * DEG;
  const lonDiff = (lon2 - lon1) * DEG;
  const y = Math.sin(lonDiff) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(lonDiff);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function destinationPoint(lat1, lon1, bearingDeg, distanceKm) {
  const R = 6371;
  const d = distanceKm / R;
  const brng = bearingDeg * DEG;
  const phi1 = lat1 * DEG;
  const lam1 = lon1 * DEG;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(d) +
      Math.cos(phi1) * Math.sin(d) * Math.cos(brng)
  );
  const lam2 =
    lam1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(phi1),
      Math.cos(d) - Math.sin(phi1) * Math.sin(phi2)
    );
  return [phi2 / DEG, (((lam2 / DEG + 540) % 360) - 180)];
}

export function interpolateGreatCircle(lat1, lon1, lat2, lon2, f) {
  const phi1 = lat1 * DEG;
  const lam1 = lon1 * DEG;
  const phi2 = lat2 * DEG;
  const lam2 = lon2 * DEG;
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((phi2 - phi1) / 2) ** 2 +
          Math.cos(phi1) * Math.cos(phi2) * Math.sin((lam2 - lam1) / 2) ** 2
      )
    );
  if (d < 1e-9) return [lat2, lon2];
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x =
    A * Math.cos(phi1) * Math.cos(lam1) +
    B * Math.cos(phi2) * Math.cos(lam2);
  const y =
    A * Math.cos(phi1) * Math.sin(lam1) +
    B * Math.cos(phi2) * Math.sin(lam2);
  const z = A * Math.sin(phi1) + B * Math.sin(phi2);
  return [Math.atan2(z, Math.hypot(x, y)) / DEG, Math.atan2(y, x) / DEG];
}

export function getLocationLabel(location) {
  if (!location) return 'Locating...';
  return `${location.lat.toFixed(3)}°, ${location.lon.toFixed(3)}°`;
}

export function animateValue(element) {
  if (!element) return;
  element.classList.remove('loading');
  void element.offsetWidth;
  element.classList.add('loading');
}

export function createMarkerIcon(angle) {
  return L.divIcon({
    className: 'iss-marker',
    html: `
      <div class="iss-icon-wrap">
        <div class="iss-glow"></div>
        <svg class="iss-svg" viewBox="0 0 64 64" style="transform: rotate(${angle}deg);" xmlns="http://www.w3.org/2000/svg">
          <g>
            <!-- main integrated truss -->
            <rect x="3" y="30.5" width="58" height="3" rx="1" fill="#aab4c4"/>

            <!-- left solar arrays -->
            <g fill="#2a6cd8" stroke="#8fb8ff" stroke-width="0.5">
              <rect x="5" y="19" width="15" height="9.5" rx="0.5"/>
              <rect x="5" y="35.5" width="15" height="9.5" rx="0.5"/>
            </g>
            <g stroke="#bfe0ff" stroke-width="0.5">
              <line x1="8.75" y1="19" x2="8.75" y2="28.5"/>
              <line x1="12.5" y1="19" x2="12.5" y2="28.5"/>
              <line x1="16.25" y1="19" x2="16.25" y2="28.5"/>
              <line x1="8.75" y1="35.5" x2="8.75" y2="45"/>
              <line x1="12.5" y1="35.5" x2="12.5" y2="45"/>
              <line x1="16.25" y1="35.5" x2="16.25" y2="45"/>
            </g>

            <!-- right solar arrays -->
            <g fill="#2a6cd8" stroke="#8fb8ff" stroke-width="0.5">
              <rect x="44" y="19" width="15" height="9.5" rx="0.5"/>
              <rect x="44" y="35.5" width="15" height="9.5" rx="0.5"/>
            </g>
            <g stroke="#bfe0ff" stroke-width="0.5">
              <line x1="47.75" y1="19" x2="47.75" y2="28.5"/>
              <line x1="51.5" y1="19" x2="51.5" y2="28.5"/>
              <line x1="55.25" y1="19" x2="55.25" y2="28.5"/>
              <line x1="47.75" y1="35.5" x2="47.75" y2="45"/>
              <line x1="51.5" y1="35.5" x2="51.5" y2="45"/>
              <line x1="55.25" y1="35.5" x2="55.25" y2="45"/>
            </g>

            <!-- radiator panels -->
            <g fill="#e7edf5" stroke="#9fb0c8" stroke-width="0.5">
              <rect x="24" y="8" width="16" height="6" rx="0.8"/>
              <rect x="24" y="50" width="16" height="6" rx="0.8"/>
            </g>

            <!-- pressurized module stack -->
            <g fill="#d8e0ea" stroke="#8ea0b8" stroke-width="0.6">
              <rect x="27" y="15" width="10" height="9" rx="2"/>
              <rect x="27" y="24.5" width="10" height="15" rx="2.2"/>
              <rect x="27" y="40" width="10" height="9" rx="2"/>
            </g>

            <!-- position marker -->
            <circle cx="32" cy="32" r="3.4" fill="var(--accent)" stroke="#fff" stroke-width="1"/>
          </g>
        </svg>
      </div>
    `,
    iconSize: [46, 46],
    iconAnchor: [23, 23]
  });
}

export function getSubsolarPoint(date) {
  const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
  const days = (date.getTime() - J2000) / 86400000;
  const meanLon = (280.46 + 0.9856474 * days) % 360;
  const meanAnom = ((357.528 + 0.9856003 * days) % 360) * DEG;
  const eclLon =
    (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) * DEG;
  const obliquity = 23.439 * DEG;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclLon)) / DEG;
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const subsolarLon = ((-15 * (utcHours - 12) + 180) % 360 + 360) % 360 - 180;
  return { lat: declination, lon: subsolarLon };
}

export function latLonToLocalVector(lat, lon, radius = 1) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return {
    x: -radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.sin(theta)
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function getHemisphere(lat) {
  if (lat > 0) return 'Northern';
  if (lat < 0) return 'Southern';
  return 'Equatorial';
}

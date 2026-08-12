(function () {
'use strict';

const CONFIG = Object.freeze({
  UPDATE_INTERVAL_MS: 5000,
  MAX_TRAIL_POINTS: 60,
  REQUEST_TIMEOUT_MS: 8000,
  MAX_RETRIES: 2,
  RETRY_BASE_DELAY_MS: 700,
  MAX_BACKOFF_MS: 20000,
  DEFAULT_PASS_LOCATION: { lat: 44.2, lon: 21.18 },
  ISS_API: 'https://api.wheretheiss.at/v1/satellites/25544',
  IP_GEO_API: 'https://ipapi.co/json/',
  SPACE_WEATHER_API: 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
  SETTINGS_KEY: 'isstrack:settings:v1',
  CACHE_KEY: 'isstrack:lastKnown:v1',
  CREW_CACHE_KEY: 'isstrack:crew:v1',
  GLOBE_TEXTURE_BASE: 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/',
  GLOBE_MIN_ZOOM: 2.0,
  GLOBE_MAX_ZOOM: 7,
  GLOBE_ZOOM_STEP: 0.5,
  EARTH_RADIUS_KM: 6371,
  ISS_ORBIT_PERIOD_MIN: 92.68,
  ISS_INCLINATION_DEG: 51.6414
});

const Settings = {
  data: { autoCenter: true, viewMode: 'map', cameraMode: 'free', debug: false, showDayNight: true },
  load() {
    try {
      const raw = localStorage.getItem(CONFIG.SETTINGS_KEY);
      if (raw) this.data = { ...this.data, ...JSON.parse(raw) };
    } catch (e) { console.warn('Settings unavailable, using defaults:', e); }
    return this.data;
  },
  save() {
    try { localStorage.setItem(CONFIG.SETTINGS_KEY, JSON.stringify(this.data)); } catch (e) {}
  },
  set(key, value) { this.data[key] = value; this.save(); }
};

const Cache = {
  read() {
    try { const raw = localStorage.getItem(CONFIG.CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  },
  write(payload) {
    try { localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify(payload)); } catch {}
  }
};

const CrewCache = {
  read() {
    try { const raw = localStorage.getItem(CONFIG.CREW_CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  },
  write(payload) {
    try { localStorage.setItem(CONFIG.CREW_CACHE_KEY, JSON.stringify(payload)); } catch {}
  }
};

const state = {
  updateCount: 0, totalDistance: 0, sessionDistance: 0,
  lastPosition: null, lastVelocity: null, lastHeading: null, lastPacketAt: null,
  trailPoints: [], predictedPath: [], pastOrbitPath: [], userLocation: null,
  passLocation: CONFIG.DEFAULT_PASS_LOCATION,
  autoCenter: true, currentView: 'map', cameraMode: 'free',
  motion: { from: null, to: null, startedAt: 0, durationMs: CONFIG.UPDATE_INTERVAL_MS, current: null },
  net: {
    online: navigator.onLine, consecutiveFailures: 0, lastLatencyMs: null,
    pollTimer: null, usingCachedData: false, apiHealthy: true, lastSuccessAt: null
  },
  debug: { fps: 0, frameTimeMs: 0, lastFrameAt: performance.now() },
  crew: { members: [], loaded: false },
  weather: { kp: null, solarActivity: null, geomagnetic: null, loaded: false },
  loadingStage: '', loadingComplete: false
};

const DEG = Math.PI / 180;
let _vUp = null;
let _vFwd = null;
let _vRight = null;
let _mBasis = null;
let _qTarget = null;
function ensureGlobeHelpers() {
  if (_vUp) return;
  _vUp = new THREE.Vector3();
  _vFwd = new THREE.Vector3();
  _vRight = new THREE.Vector3();
  _mBasis = new THREE.Matrix4();
  _qTarget = new THREE.Quaternion();
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
function formatDegrees(value) {
  if (value == null || !Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  const dir = value >= 0 ? 'N' : 'S';
  return `${deg}°${min.toFixed(2)}' ${dir}`;
}
function formatKm(value) {
  if (value == null || !Number.isFinite(value)) return '--';
  return `${Number(value).toFixed(1)} km`;
}
function formatUTC(date) {
  if (!date) return '--';
  return date.toISOString().slice(11, 19) + 'Z';
}
function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m} min ${s} sec`;
}
function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function bearing(lat1, lon1, lat2, lon2) {
  const lat1Rad = lat1 * DEG;
  const lat2Rad = lat2 * DEG;
  const lonDiff = (lon2 - lon1) * DEG;
  const y = Math.sin(lonDiff) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(lonDiff);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
function destinationPoint(lat1, lon1, bearingDeg, distanceKm) {
  const R = 6371;
  const d = distanceKm / R;
  const brng = bearingDeg * DEG;
  const phi1 = lat1 * DEG;
  const lam1 = lon1 * DEG;
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(brng));
  const lam2 = lam1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2));
  return [phi2 / DEG, (((lam2 / DEG + 540) % 360) - 180)];
}
function interpolateGreatCircle(lat1, lon1, lat2, lon2, f) {
  const phi1 = lat1 * DEG;
  const lam1 = lon1 * DEG;
  const phi2 = lat2 * DEG;
  const lam2 = lon2 * DEG;
  const d = 2 * Math.asin(Math.sqrt(Math.sin((phi2 - phi1) / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin((lam2 - lam1) / 2) ** 2));
  if (d < 1e-9) return [lat2, lon2];
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(phi1) * Math.cos(lam1) + B * Math.cos(phi2) * Math.cos(lam2);
  const y = A * Math.cos(phi1) * Math.sin(lam1) + B * Math.cos(phi2) * Math.sin(lam2);
  const z = A * Math.sin(phi1) + B * Math.sin(phi2);
  return [Math.atan2(z, Math.hypot(x, y)) / DEG, Math.atan2(y, x) / DEG];
}
function getLocationLabel(location) {
  if (!location) return 'Locating...';
  return `${location.lat.toFixed(3)}°, ${location.lon.toFixed(3)}°`;
}
function valueFlash(element) {
  if (!element) return;
  element.classList.remove('loading');
  void element.offsetWidth;
  element.classList.add('loading');
}
function createMarkerIcon(angle) {
  const issSvg = `
    <div class="iss-icon-wrap">
      <div class="iss-glow"></div>
      <svg class="iss-svg" viewBox="0 0 64 64" style="transform: rotate(${angle}deg);" xmlns="http://www.w3.org/2000/svg">
        <g>
          <rect x="3" y="30.5" width="58" height="3" rx="1" fill="#aab4c4"/>
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
          <g fill="#e7edf5" stroke="#9fb0c8" stroke-width="0.5">
            <rect x="24" y="8" width="16" height="6" rx="0.8"/>
            <rect x="24" y="50" width="16" height="6" rx="0.8"/>
          </g>
          <g fill="#d8e0ea" stroke="#8ea0b8" stroke-width="0.6">
            <rect x="27" y="15" width="10" height="9" rx="2"/>
            <rect x="27" y="24.5" width="10" height="15" rx="2.2"/>
            <rect x="27" y="40" width="10" height="9" rx="2"/>
          </g>
          <circle cx="32" cy="32" r="3.4" fill="var(--accent)" stroke="#fff" stroke-width="1"/>
        </g>
      </svg>
    </div>
  `;
  return L.divIcon({
    className: 'iss-marker',
    html: issSvg,
    iconSize: [46, 46], iconAnchor: [23, 23]
  });
}
function getSubsolarPoint(date) {
  const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
  const days = (date.getTime() - J2000) / 86400000;
  const meanLon = (280.46 + 0.9856474 * days) % 360;
  const meanAnom = ((357.528 + 0.9856003 * days) % 360) * DEG;
  const eclLon = (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) * DEG;
  const obliquity = 23.439 * DEG;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclLon)) / DEG;
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const subsolarLon = ((-15 * (utcHours - 12) + 180) % 360 + 360) % 360 - 180;
  return { lat: declination, lon: subsolarLon };
}
function latLonToLocalVector(lat, lon, radius = 1) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return { x: -radius * Math.sin(phi) * Math.cos(theta), y: radius * Math.cos(phi), z: radius * Math.sin(phi) * Math.sin(theta) };
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function debounce(fn, ms) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }; }
function getHemisphere(lat) { if (lat > 0) return 'Northern'; if (lat < 0) return 'Southern'; return 'Equatorial'; }

const byId = (id) => document.getElementById(id);
const dom = {
  lat: byId('lat'), lon: byId('lon'), altitude: byId('altitude'), altitudeOrbit: byId('altitudeOrbit'),
  velocity: byId('velocity'), speed: byId('speed'), heading: byId('heading'),
  orbitNumber: byId('orbitNumber'), orbitalPeriod: byId('orbitalPeriod'),
  packets: byId('updates'), connection: byId('connection'), indicator: document.querySelector('.indicator'),
  telemetryStatus: byId('telemetryStatus'), updated: byId('lastUpdated'),
  hudAltitude: byId('hudAltitude'), hudSpeed: byId('hudSpeed'), hudOrbit: byId('hudOrbit'),
  hudTime: byId('hudTime'), hudStatus: byId('hudStatus'),
  lastPacket: byId('lastPacket'), latency: byId('latency'),
  visibleIn: byId('visibleIn'), passDuration: byId('passDuration'), maxElevation: byId('maxElevation'), passLocation: byId('passLocation'),
  followBtn: byId('followBtn'), zoomISSBtn: byId('zoomISSBtn'), resetBtn: byId('resetBtn'),
  mapModeBtn: byId('mapModeBtn'), globeModeBtn: byId('globeModeBtn'),
  globeView: byId('globeView'), globeHint: byId('globeHint'), globeFallback: byId('globeFallback'),
  globeZoomInBtn: byId('globeZoomInBtn'), globeZoomOutBtn: byId('globeZoomOutBtn'),
  cameraModeSwitcher: byId('cameraModeSwitcher'),
  offlineBanner: byId('offlineBanner'), offlineBannerText: byId('offlineBannerText'),
  debugOverlay: byId('debugOverlay'), cards: document.querySelectorAll('.card'),
  dbgFps: byId('dbgFps'), dbgFrameTime: byId('dbgFrameTime'), dbgDrawCalls: byId('dbgDrawCalls'),
  dbgTriangles: byId('dbgTriangles'), dbgGpuMem: byId('dbgGpuMem'), dbgLatency: byId('dbgLatency'), dbgUpdateFreq: byId('dbgUpdateFreq'),
  camFreeBtn: byId('camFreeBtn'), camFollowBtn: byId('camFollowBtn'), camTopBtn: byId('camTopBtn'),
  crewCount: byId('crewCount'), crewList: byId('crewList'), spacecraftList: byId('spacecraftList'),
  kpIndex: byId('kpIndex'), solarActivity: byId('solarActivity'), geomagneticConditions: byId('geomagneticConditions'),
  radiationLevel: byId('radiationLevel'), auroraActivity: byId('auroraActivity'), spaceWeatherStatus: byId('spaceWeatherStatus'),
  timelineEvents: byId('timelineEvents'), loadingOverlay: byId('loadingOverlay'), loadingStatus: byId('loadingStatus'),
  dataAge: byId('dataAge'), apiHealth: byId('apiHealth'),
  localTime: byId('localTime'), hemisphere: byId('hemisphere'), sunState: byId('sunState'),
  distanceToday: byId('distanceToday'), distanceSession: byId('distanceSession'), orbitProgress: byId('orbitProgress')
};

function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}
async function fetchWithRetry(url, options, retries = CONFIG.MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options);
      if (response.status === 429) throw Object.assign(new Error('Rate limited'), { rateLimited: true });
      if (!response.ok) throw new Error(`API Error: ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const backoff = Math.min(CONFIG.RETRY_BASE_DELAY_MS * 2 ** attempt, CONFIG.MAX_BACKOFF_MS);
        await sleep(backoff);
      }
    }
  }
  throw lastError;
}
function updateDataAge() {
  const el = document.getElementById('dataAge');
  if (!el) return;
  if (!state.net.lastSuccessAt) { el.textContent = 'No data received'; return; }
  const age = Date.now() - state.net.lastSuccessAt;
  if (age < 5000) { el.textContent = 'Live'; el.className = 'data-age live'; }
  else if (age < 30000) { el.textContent = `${Math.round(age / 1000)}s`; el.className = 'data-age recent'; }
  else if (age < 300000) { el.textContent = `${Math.round(age / 60000)}m ago`; el.className = 'data-age stale'; }
  else { el.textContent = `${Math.round(age / 60000)}m ago`; el.className = 'data-age old'; }
}
function updateAPIHealth(healthy) {
  state.net.apiHealthy = healthy;
  const el = document.getElementById('apiHealth');
  if (!el) return;
  el.textContent = healthy ? 'Connected' : 'Disconnected';
  el.className = healthy ? 'api-health connected' : 'api-health disconnected';
}

let lastMotionSettled = true;
let onPositionUpdate = null;

function beginMotionTransition(nextLat, nextLon) {
  const previous = state.motion.current;
  state.motion.from = previous || [nextLat, nextLon];
  state.motion.to = [nextLat, nextLon];
  state.motion.startedAt = performance.now();
  state.motion.durationMs = CONFIG.UPDATE_INTERVAL_MS;
}

function renderPosition(lat, lon, settled) {
  dom.lat.textContent = formatDegrees(lat);
  dom.lon.textContent = formatDegrees(lon);
  if (settled) { setTimeout(() => { valueFlash(dom.lat); valueFlash(dom.lon); }, 0); }
  if (onPositionUpdate) onPositionUpdate(lat, lon);
}

function updateTelemetryDOM(lat, lon, altitude, velocity, heading, visibility) {
  const now = new Date();
  const speed = Number.isFinite(velocity) && velocity > 0 ? velocity : state.lastVelocity ?? 27600;
  const computedAltitude = Number.isFinite(altitude) && altitude > 0 ? altitude : 408;
  const orbitNumberVal = Math.round(118900 + state.updateCount * 1.7);
  const orbitalPeriod = CONFIG.ISS_ORBIT_PERIOD_MIN;

  dom.altitude.textContent = formatKm(computedAltitude);
  dom.altitudeOrbit.textContent = formatKm(computedAltitude);
  dom.velocity.textContent = `${Math.round(speed).toLocaleString()} km/h`;
  dom.speed.textContent = `${(speed / 3600).toFixed(2)} km/s`;
  dom.heading.textContent = heading != null ? `${Math.round(heading)}°` : '--';
  dom.orbitNumber.textContent = orbitNumberVal.toLocaleString();
  dom.orbitalPeriod.textContent = `${orbitalPeriod.toFixed(1)} minutes`;
  dom.packets.textContent = String(state.updateCount).padStart(3, '0');
  dom.lastPacket.textContent = formatUTC(now);
  dom.latency.textContent = state.net.lastLatencyMs != null ? `${state.net.lastLatencyMs} ms` : '--';
  dom.updated.textContent = `Last Update: ${now.toLocaleTimeString()}`;
  dom.hudAltitude.textContent = `ALT ${Math.round(computedAltitude)}km`;
  dom.hudSpeed.textContent = `VEL ${(speed / 3600).toFixed(2)}km/s`;
  dom.hudOrbit.textContent = `ORBIT ${orbitNumberVal.toLocaleString()}`;
  dom.hudTime.textContent = `UTC ${formatUTC(now)}`;
  dom.hudStatus.textContent = state.net.usingCachedData ? 'STATUS CACHED' : 'STATUS LIVE';
  dom.telemetryStatus.textContent = state.net.usingCachedData ? 'Showing last known telemetry...' : 'Receiving telemetry...';

  if (dom.hemisphere) dom.hemisphere.textContent = `${getHemisphere(lat)} Hemisphere`;
  const localTimeOffset = lon * 4;
  const localMs = now.getTime() + localTimeOffset * 60000;
  if (dom.localTime) dom.localTime.textContent = new Date(localMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (dom.sunState) dom.sunState.textContent = visibility === 'eclipsed' ? 'Night (Eclipsed)' : 'Daylight';

  if (state.lastPosition) {
    const dist = calculateDistance(state.lastPosition[0], state.lastPosition[1], lat, lon);
    state.totalDistance += dist;
    state.sessionDistance += dist;
  }
  state.lastPosition = [lat, lon];

  if (dom.distanceToday) dom.distanceToday.textContent = `${Math.round(state.totalDistance).toLocaleString()} km`;
  if (dom.distanceSession) dom.distanceSession.textContent = `${Math.round(state.sessionDistance).toLocaleString()} km`;
  updateDataAge();

  const statusCard = document.querySelector('.selected');
  if (statusCard) { statusCard.classList.add('u--packet-received'); setTimeout(() => statusCard.classList.remove('u--packet-received'), 600); }
}

function setConnectionUI(statusText, colorVar, indicatorColor) {
  dom.connection.textContent = statusText;
  if (dom.indicator) dom.indicator.style.backgroundColor = indicatorColor;
}

function showOfflineBanner(show, text) {
  if (!dom.offlineBanner) return;
  dom.offlineBanner.classList.toggle('hidden', !show);
  if (text) dom.offlineBannerText.textContent = text;
}

function scheduleNextPoll(getISSCallback) {
  if (state.net.pollTimer) clearTimeout(state.net.pollTimer);
  const failures = state.net.consecutiveFailures;
  const delay = failures > 0
    ? Math.min(CONFIG.UPDATE_INTERVAL_MS * 2 ** Math.min(failures, 4), CONFIG.MAX_BACKOFF_MS)
    : CONFIG.UPDATE_INTERVAL_MS;
  state.net.pollTimer = setTimeout(getISSCallback, delay);
  if (dom.dbgUpdateFreq) dom.dbgUpdateFreq.textContent = `${(delay / 1000).toFixed(1)}s`;
}

async function getISS() {
  dom.updated.classList.add('loading');
  setConnectionUI('Syncing...', null, '#fc3c23');
  dom.telemetryStatus.textContent = 'Syncing telemetry...';

  const requestStart = performance.now();
  try {
    const response = await fetchWithRetry(CONFIG.ISS_API, { cache: 'no-store' });
    const data = await response.json();
    state.net.lastLatencyMs = Math.round(performance.now() - requestStart);

    const latitude = Number(data.latitude ?? data.iss_position?.latitude);
    const longitude = Number(data.longitude ?? data.iss_position?.longitude);
    const vel = Number(data.velocity ?? data.speed ?? data.iss_position?.velocity);
    const altitude = Number(data.altitude ?? data.iss_position?.altitude ?? 408);
    const visibility = (data.visibility || '').toLowerCase();
    const heading = Number(data.heading) || bearing(
      state.motion.from?.[0] ?? latitude,
      state.motion.from?.[1] ?? longitude,
      latitude, longitude
    );

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('Invalid ISS coordinates');

    state.net.consecutiveFailures = 0;
    state.net.usingCachedData = false;
    state.net.lastSuccessAt = Date.now();
    showOfflineBanner(false);
    updateAPIHealth(true);

    beginMotionTransition(latitude, longitude);
    state.lastVelocity = Number.isFinite(vel) && vel > 0 ? vel : state.lastVelocity;
    state.lastHeading = heading;
    state.updateCount += 1;
    computePredictedPath(latitude, longitude, heading);

    valueFlash(dom.lat); valueFlash(dom.lon); valueFlash(dom.speed); valueFlash(dom.packets);
    updateTelemetryDOM(latitude, longitude, altitude, state.lastVelocity ?? vel, heading, visibility);
    document.body.classList.remove('initializing');

    Cache.write({ latitude, longitude, velocity: state.lastVelocity, altitude, heading, visibility, savedAt: Date.now() });
    setConnectionUI('Connected', null, '#ba1e68');
    dom.telemetryStatus.textContent = 'Receiving telemetry...';
  } catch (error) {
    state.net.consecutiveFailures += 1;
    console.error('Error fetching ISS data:', error);
    updateAPIHealth(false);

    const cached = Cache.read();
    if (cached && state.net.consecutiveFailures <= 6) {
      state.net.usingCachedData = true;
      beginMotionTransition(cached.latitude, cached.longitude);
      updateTelemetryDOM(cached.latitude, cached.longitude, cached.altitude, cached.velocity, cached.heading, cached.visibility);
      const ageMin = Math.max(1, Math.round((Date.now() - cached.savedAt) / 60000));
      showOfflineBanner(true, `Connection lost. Showing telemetry from ${ageMin} min ago.`);
      setConnectionUI('Reconnecting...', null, '#8a1e40');
    } else {
      showOfflineBanner(true, 'Connection lost and no cached telemetry is available.');
      setConnectionUI('Disconnected', null, '#555555');
    }
    dom.telemetryStatus.textContent = 'Telemetry lost';
  } finally {
    scheduleNextPoll(getISS);
  }
}

const ORBIT_STEP_MIN = 1.5;
const SIDEREAL_DAY_MIN = 1436.07;
const ORBIT_DEG = Math.PI / 180;

function computeOrbitGroundTrack(latitude, longitude, heading) {
  const i = CONFIG.ISS_INCLINATION_DEG * ORBIT_DEG;
  const sinI = Math.sin(i);
  const cosI = Math.cos(i);
  const period = CONFIG.ISS_ORBIT_PERIOD_MIN;

  const lat0 = latitude * ORBIT_DEG;
  const ratio = Math.max(-1, Math.min(1, Math.sin(lat0) / sinI));
  const ascendingNow = Math.cos(heading * ORBIT_DEG) >= 0;
  let u0 = Math.asin(ratio);
  if (!ascendingNow) u0 = Math.PI - u0;

  const orbitLon = (u) => Math.atan2(cosI * Math.sin(u), Math.cos(u));
  const orbitLat = (u) => Math.asin(sinI * Math.sin(u));
  const lambdaAsc = longitude * ORBIT_DEG - orbitLon(u0);

  const pointAt = (dtMin) => {
    const u = u0 + (dtMin / period) * 2 * Math.PI;
    const lat = orbitLat(u) / ORBIT_DEG;
    const earthRot = (dtMin / SIDEREAL_DAY_MIN) * 2 * Math.PI;
    let lon = (lambdaAsc + orbitLon(u) - earthRot) / ORBIT_DEG;
    lon = ((lon + 540) % 360) - 180;
    return [lat, lon];
  };

  const halfOrbit = period / 2;
  const future = [];
  for (let t = ORBIT_STEP_MIN; t <= halfOrbit; t += ORBIT_STEP_MIN) {
    future.push(pointAt(t));
  }
  const past = [];
  for (let t = halfOrbit; t >= ORBIT_STEP_MIN; t -= ORBIT_STEP_MIN) {
    past.push(pointAt(-t));
  }
  past.push([latitude, longitude]);

  return { past, future };
}

function computePredictedPath(latitude, longitude, heading) {
  const track = computeOrbitGroundTrack(latitude, longitude, heading);
  state.pastOrbitPath = track.past;
  state.predictedPath = track.future;
}
function updatePassPrediction(latitude, longitude, speed) {
  const activeLocation = state.userLocation ?? state.passLocation;
  const distanceToLocation = calculateDistance(latitude, longitude, activeLocation.lat, activeLocation.lon);
  const passInMinutes = Math.max(2, Math.round((distanceToLocation / Math.max(speed, 1)) * 60));
  const durationSeconds = Math.max(180, Math.round(210 + (Math.abs(longitude) % 40) * 2));
  const elevation = Math.min(85, Math.round(38 + (Math.abs(latitude) % 24) + (Math.abs(speed) % 14)));
  dom.passLocation.textContent = getLocationLabel(activeLocation);
  dom.visibleIn.textContent = `${passInMinutes} minutes (estimated)`;
  dom.passDuration.textContent = formatDuration(durationSeconds);
  dom.maxElevation.textContent = `${elevation}°`;
}

async function getCurrentBrowserLocation() {
  if (!navigator.geolocation) { await resolveLocationFallback(); return; }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.userLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
      state.passLocation = state.userLocation;
      dom.passLocation.textContent = getLocationLabel(state.passLocation);
    },
    async () => resolveLocationFallback(),
    { enableHighAccuracy: false, timeout: 7000, maximumAge: 60000 }
  );
}

async function resolveLocationFallback() {
  try {
    const response = await fetchWithTimeout(CONFIG.IP_GEO_API, { cache: 'no-store' });
    if (!response.ok) throw new Error('IP geolocation unavailable');
    const data = await response.json();
    if (Number.isFinite(data.latitude) && Number.isFinite(data.longitude)) {
      state.userLocation = { lat: Number(data.latitude), lon: Number(data.longitude) };
      state.passLocation = state.userLocation;
      dom.passLocation.textContent = getLocationLabel(state.passLocation);
      return;
    }
  } catch (error) { console.warn('Falling back to default pass location:', error); }
  state.passLocation = CONFIG.DEFAULT_PASS_LOCATION;
  dom.passLocation.textContent = getLocationLabel(state.passLocation);
}

function updateDebugOverlay() {
  if (!document.querySelector('.debug-overlay:not(.hidden)')) return;
  const dbgFps = document.getElementById('dbgFps');
  const dbgFrameTime = document.getElementById('dbgFrameTime');
  const dbgLatency = document.getElementById('dbgLatency');
  if (dbgFps) dbgFps.textContent = Math.round(state.debug.fps);
  if (dbgFrameTime) dbgFrameTime.textContent = `${state.debug.frameTimeMs.toFixed(1)} ms`;
  if (dbgLatency) dbgLatency.textContent = state.net.lastLatencyMs != null ? `${state.net.lastLatencyMs} ms` : '--';
}

function runMotionLoop(timestamp) {
  const dt = timestamp - state.debug.lastFrameAt;
  state.debug.lastFrameAt = timestamp;
  if (dt > 0) { state.debug.frameTimeMs = dt; state.debug.fps = 1000 / dt; }
  if (state.motion.to) {
    const elapsed = performance.now() - state.motion.startedAt;
    const f = easeInOutQuad(clamp(elapsed / state.motion.durationMs, 0, 1));
    const [lat, lon] = interpolateGreatCircle(state.motion.from[0], state.motion.from[1], state.motion.to[0], state.motion.to[1], f);
    state.motion.current = [lat, lon];
    renderPosition(lat, lon, f >= 1 && !lastMotionSettled);
    lastMotionSettled = f >= 1;
  }
  updateDebugOverlay();
  requestAnimationFrame(runMotionLoop);
}

let mapInstance = null;
let issMarker = null;
let trailPolyline = null;
let predictedPolylines = [];
let pastOrbitPolylines = [];

function splitAtAntimeridian(points) {
  const segments = [];
  let current = [];
  for (let idx = 0; idx < points.length; idx += 1) {
    const point = points[idx];
    if (current.length) {
      const prevLon = current[current.length - 1][1];
      if (Math.abs(point[1] - prevLon) > 180) {
        segments.push(current);
        current = [];
      }
    }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}

function initMap() {
  if (mapInstance) return mapInstance;
  mapInstance = L.map('map', { center: [0, 0], zoom: 2, zoomControl: true, attributionControl: false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd' }).addTo(mapInstance);
  return mapInstance;
}

function updateMapPosition(lat, lon, heading) {
  if (!mapInstance) return;
  if (!issMarker) {
    issMarker = L.marker([lat, lon], { icon: createMarkerIcon(heading || 0), zIndexOffset: 1000 }).addTo(mapInstance);
  } else {
    issMarker.setLatLng([lat, lon]);
    issMarker.setIcon(createMarkerIcon(heading || 0));
  }
  if (state.autoCenter && mapInstance.getZoom() >= 3) mapInstance.panTo([lat, lon], { animate: true, duration: 1.5 });
}

function updateTrail(lat, lon) {
  if (!mapInstance) return;
  state.trailPoints.push([lat, lon]);
  if (state.trailPoints.length > CONFIG.MAX_TRAIL_POINTS) state.trailPoints.shift();
  if (trailPolyline) { trailPolyline.setLatLngs(state.trailPoints); }
  else if (state.trailPoints.length > 1) { trailPolyline = L.polyline(state.trailPoints, { color: '#fc3c23', weight: 1.5, opacity: 0.6, smoothFactor: 1 }).addTo(mapInstance); }
}
function updatePredictedPath(points) {
  if (!mapInstance || !points || points.length < 2) return;
  predictedPolylines.forEach((line) => mapInstance.removeLayer(line));
  predictedPolylines = splitAtAntimeridian(points).map((segment) =>
    L.polyline(segment, { color: '#68dfff', weight: 1.5, dashArray: '4 7', opacity: 0.75, smoothFactor: 1 }).addTo(mapInstance)
  );
}

function updatePastOrbitPath(points) {
  if (!mapInstance || !points || points.length < 2) return;
  pastOrbitPolylines.forEach((line) => mapInstance.removeLayer(line));
  pastOrbitPolylines = splitAtAntimeridian(points).map((segment) =>
    L.polyline(segment, { color: '#ffb020', weight: 1.5, opacity: 0.55, smoothFactor: 1 }).addTo(mapInstance)
  );
}

function flyToISS(lat, lon) {
  if (!mapInstance) return;
  state.autoCenter = true; dom.followBtn.textContent = 'Pause Follow';
  mapInstance.flyTo([lat, lon], 4, { duration: 1.4 });
}
function resetMapView() {
  if (!mapInstance) return;
  state.autoCenter = true; dom.followBtn.textContent = 'Pause Follow';
  mapInstance.setView([0, 0], 2);
}
function toggleAutoCenter() {
  state.autoCenter = !state.autoCenter;
  dom.followBtn.textContent = state.autoCenter ? 'Pause Follow' : 'Follow ISS';
  if (state.autoCenter && state.motion.current) mapInstance.flyTo(state.motion.current, Math.max(3, mapInstance.getZoom()), { duration: 1.1 });
}

const EARTH_VERTEX_SHADER = `varying vec2 vUv;varying vec3 vLocalNormal;void main(){vUv=uv;vLocalNormal=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const EARTH_FRAGMENT_SHADER = `uniform sampler2D dayMap;uniform sampler2D nightMap;uniform sampler2D specularMap;uniform vec3 sunDirection;uniform float showDayNight;varying vec2 vUv;varying vec3 vLocalNormal;void main(){float ndl=dot(vLocalNormal,normalize(sunDirection));float dayMix=smoothstep(-0.12,0.15,ndl);dayMix=mix(1.0,dayMix,showDayNight);vec3 dayColor=texture2D(dayMap,vUv).rgb;vec3 nightColor=texture2D(nightMap,vUv).rgb*vec3(1.0,0.85,0.55)*1.6;float ocean=1.0-texture2D(specularMap,vUv).r;vec3 color=mix(nightColor,dayColor,dayMix);float glint=pow(clamp(ndl,0.0,1.0),6.0)*ocean*0.25;color+=vec3(glint);gl_FragColor=vec4(color,1.0);}`;
const ATMOSPHERE_VERTEX_SHADER = `varying vec3 vNormal;void main(){vNormal=normalize(normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const ATMOSPHERE_FRAGMENT_SHADER = `varying vec3 vNormal;void main(){float fresnel=pow(0.68-dot(vNormal,vec3(0.0,0.0,1.0)),3.0);gl_FragColor=vec4(0.35,0.65,1.0,clamp(fresnel,0.0,1.0)*0.9);}`;

const Globe = { supported: null, renderer: null, scene: null, camera: null, group: null, earthMesh: null, earthMaterial: null, cloudsMesh: null, issMesh: null, orbitRing: null, moonMesh: null, raycaster: null, pointerNDC: null, zero: null, animationFrame: null, resizeHandler: null, isDragging: false, lastInteraction: 0, pendingLatLon: null, clock: { last: 0 }, cameraTransition: null, sunLocal: { x: 1, y: 0, z: 0 }, motionDir: null, predictedLine: null, pastOrbitLine: null, pendingPredictedPath: null, pendingPastOrbitPath: null };

function webglIsSupported() {
  try { const canvas = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))); } catch { return false; }
}

function initGlobe() {
  if (Globe.supported === null) Globe.supported = webglIsSupported() && !!window.THREE;
  if (!Globe.supported) { dom.globeFallback.classList.remove('hidden'); dom.globeModeBtn.disabled = true; dom.globeModeBtn.title = '3D globe requires WebGL'; return; }
  if (Globe.renderer) return;
  try {
    const width = dom.globeView.offsetWidth || 640;
    const height = dom.globeView.offsetHeight || 420;
    Globe.scene = new THREE.Scene();
    Globe.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    Globe.camera.position.set(0, 0, 4.4);
    Globe.camera.lookAt(0, 0, 0);
    Globe.raycaster = new THREE.Raycaster();
    Globe.pointerNDC = new THREE.Vector2();
    Globe.zero = new THREE.Vector3(0, 0, 0);
    Globe.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    Globe.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    Globe.renderer.setSize(width, height);
    Globe.renderer.outputColorSpace = THREE.SRGBColorSpace;
    Globe.renderer.domElement.style.width = '100%';
    Globe.renderer.domElement.style.height = '100%';
    dom.globeView.appendChild(Globe.renderer.domElement);
    Globe.group = new THREE.Group();
    Globe.scene.add(Globe.group);

    const ambient = new THREE.AmbientLight(0x8fa8d8, 0.35);
    Globe.scene.add(ambient);
    const textureLoader = new THREE.TextureLoader();
    textureLoader.crossOrigin = 'anonymous';
    const base = CONFIG.GLOBE_TEXTURE_BASE;
    const placeholder = new THREE.DataTexture(new Uint8Array([70, 100, 140, 255]), 1, 1, THREE.RGBAFormat);
    placeholder.needsUpdate = true;
    Globe.earthMaterial = new THREE.ShaderMaterial({
      uniforms: { dayMap: { value: placeholder }, nightMap: { value: placeholder }, specularMap: { value: placeholder }, sunDirection: { value: new THREE.Vector3(1, 0, 0) }, showDayNight: { value: 1.0 } },
      vertexShader: EARTH_VERTEX_SHADER, fragmentShader: EARTH_FRAGMENT_SHADER
    });
    Globe.earthMesh = new THREE.Mesh(new THREE.SphereGeometry(1.25, 64, 64), Globe.earthMaterial);
    Globe.group.add(Globe.earthMesh);

    const loadTexture = (file, uniformKey, colorSpace) => {
      textureLoader.load(`${base}${file}`, (texture) => { if (colorSpace) texture.colorSpace = colorSpace; Globe.earthMaterial.uniforms[uniformKey].value = texture; }, undefined, () => {});
    };
    loadTexture('earth_atmos_2048.jpg', 'dayMap', THREE.SRGBColorSpace);
    loadTexture('earth_lights_2048.png', 'nightMap', THREE.SRGBColorSpace);
    loadTexture('earth_specular_2048.jpg', 'specularMap');

    const cloudsMat = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.28, depthWrite: false });
    Globe.cloudsMesh = new THREE.Mesh(new THREE.SphereGeometry(1.27, 48, 48), cloudsMat);
    Globe.group.add(Globe.cloudsMesh);
    textureLoader.load(`${base}earth_clouds_1024.png`, (tex) => { cloudsMat.map = tex; cloudsMat.needsUpdate = true; }, undefined, () => { Globe.cloudsMesh.visible = false; });

    Globe.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.34, 48, 48), new THREE.ShaderMaterial({
      vertexShader: ATMOSPHERE_VERTEX_SHADER, fragmentShader: ATMOSPHERE_FRAGMENT_SHADER, transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending
    })));

    const moonMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 1 });
    Globe.moonMesh = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 24), moonMat);
    Globe.moonMesh.position.set(3.2, 0.4, -1.6);
    Globe.scene.add(Globe.moonMesh);
    const moonLight = new THREE.DirectionalLight(0xffffff, 0.6);
    moonLight.position.copy(Globe.moonMesh.position);
    Globe.scene.add(moonLight);
    textureLoader.load(`${base}moon_1024.jpg`, (tex) => { moonMat.map = tex; moonMat.color.set(0xffffff); moonMat.needsUpdate = true; }, undefined, () => {});

    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(4200);
    for (let i = 0; i < 1400; i += 1) { const i3 = i * 3; starPos[i3] = (Math.random() - 0.5) * 24; starPos[i3 + 1] = (Math.random() - 0.5) * 24; starPos[i3 + 2] = (Math.random() - 0.5) * 24; }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    Globe.scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.028, sizeAttenuation: true })));

    const orbPts = [];
    for (let i = 0; i <= 360; i += 10) { const a = i * DEG; orbPts.push(new THREE.Vector3(Math.cos(a) * 1.6, Math.sin(a) * 0.34, Math.sin(a) * 1.6)); }
    Globe.orbitRing = new THREE.Line(new THREE.BufferGeometry().setFromPoints(orbPts), new THREE.LineBasicMaterial({ color: 0x68dfff, transparent: true, opacity: 0.75 }));
    Globe.group.add(Globe.orbitRing);

    Globe.issMesh = buildIssModel();
    Globe.issMesh.scale.setScalar(0.6);
    Globe.group.add(Globe.issMesh);

    Globe.predictedLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x68dfff, transparent: true, opacity: 0.65 }));
    Globe.group.add(Globe.predictedLine);
    Globe.pastOrbitLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.55 }));
    Globe.group.add(Globe.pastOrbitLine);

    if (Globe.pendingLatLon) placeGlobeMarker(...Globe.pendingLatLon);
    if (Globe.pendingPredictedPath) updateGlobePredictedPath(Globe.pendingPredictedPath);
    if (Globe.pendingPastOrbitPath) updateGlobePastOrbitPath(Globe.pendingPastOrbitPath);

    updateSunDirection(true);
    attachGlobeControls();
    Globe.lastInteraction = Date.now();
    runGlobeAnimation();

    Globe.resizeHandler = () => { const w = dom.globeView.clientWidth || 640; const h = dom.globeView.clientHeight || 420; Globe.camera.aspect = w / h; Globe.camera.updateProjectionMatrix(); Globe.renderer.setSize(w, h); };
    window.addEventListener('resize', Globe.resizeHandler);
  } catch (error) {
    console.error('Globe init failed:', error);
    dom.globeFallback.classList.remove('hidden');
    dom.globeFallback.querySelector('p').textContent = 'The 3D globe couldn\'t start. The 2D map keeps working normally.';
    Globe.supported = false;
  }
}

function updateSunDirection(force) {
  if (!Globe.earthMaterial) return;
  const now = Date.now();
  if (!force && now - (updateSunDirection.last || 0) < 60000) return;
  updateSunDirection.last = now;
  const sub = getSubsolarPoint(new Date());
  const v = latLonToLocalVector(sub.lat, sub.lon, 1);
  Globe.sunLocal = v;
  Globe.earthMaterial.uniforms.sunDirection.value.set(v.x, v.y, v.z);
}

function runGlobeAnimation() {
  function animate(timestamp) {
    const dt = Globe.clock.last ? (timestamp - Globe.clock.last) / 1000 : 0.016;
    Globe.clock.last = timestamp;
    if (Globe.renderer && Globe.scene && Globe.camera && Globe.group) {
      const idle = !Globe.isDragging && Date.now() - Globe.lastInteraction > 1800;
      if (idle && state.cameraMode === 'free') Globe.group.rotation.y += 0.14 * dt;
      if (Globe.cloudsMesh) Globe.cloudsMesh.rotation.y += 0.02 * dt;
      if (Globe.moonMesh) { const t = timestamp * 0.00003; Globe.moonMesh.position.set(Math.cos(t) * 3.2, 0.4, Math.sin(t) * 3.2); }
      updateSunDirection(false);
      stepCameraTransition(timestamp);
      applyCameraMode(dt);
      Globe.renderer.render(Globe.scene, Globe.camera);
      updateDebugRenderStatsGlobe();
    }
    Globe.animationFrame = requestAnimationFrame(animate);
  }
  Globe.animationFrame = requestAnimationFrame(animate);
}

function beginCameraTransition(toPos, toTarget, durationMs = 900) {
  Globe.cameraTransition = { fromPos: Globe.camera.position.clone(), toPos, fromTarget: Globe.cameraTransition ? Globe.cameraTransition.toTarget.clone() : Globe.zero.clone(), toTarget, start: performance.now(), duration: durationMs };
}
function stepCameraTransition() {
  if (!Globe.cameraTransition) return;
  const t = Globe.cameraTransition;
  const elapsed = performance.now() - t.start;
  const f = easeInOutQuad(clamp(elapsed / t.duration, 0, 1));
  Globe.camera.position.lerpVectors(t.fromPos, t.toPos, f);
  const target = new THREE.Vector3().lerpVectors(t.fromTarget, t.toTarget, f);
  Globe.camera.lookAt(target);
  if (f >= 1) Globe.cameraTransition = null;
}
function applyCameraMode() {
  if (state.cameraMode === 'top' && !Globe.cameraTransition) { Globe.camera.up.set(0, 0, -1); Globe.camera.position.lerp(new THREE.Vector3(0, 4.2, 0.001), 0.06); Globe.camera.lookAt(0, 0, 0); }
  else if (state.cameraMode === 'follow' && Globe.issMesh) { Globe.camera.up.set(0, 1, 0); if (!Globe.isDragging) { const p = new THREE.Vector3(); Globe.issMesh.getWorldPosition(p); Globe.camera.position.lerp(p.clone().normalize().multiplyScalar(3.2), 0.03); Globe.camera.lookAt(0, 0, 0); } }
  else if (state.cameraMode === 'free') { Globe.camera.up.set(0, 1, 0); }
}
function setCameraMode(mode) {
  state.cameraMode = mode;
  Settings.set('cameraMode', mode);
  [dom.camFreeBtn, dom.camFollowBtn, dom.camTopBtn].forEach((btn) => { if (btn) btn.classList.toggle('is-active', btn.dataset.mode === mode); });
  if (!Globe.camera) return;
  if (mode === 'top') beginCameraTransition(new THREE.Vector3(0, 4.2, 0.001), Globe.zero.clone());
  else if (mode === 'free') { Globe.camera.up.set(0, 1, 0); beginCameraTransition(new THREE.Vector3(0, 0, 4.4), Globe.zero.clone()); }
}

function attachGlobeControls() {
  const el = Globe.renderer.domElement;
  let dragStartX, dragStartY, rotationStartX, rotationStartY;
  const activePointers = new Map();
  let pinchStartDistance = 0;
  const markInteraction = () => { Globe.lastInteraction = Date.now(); if (dom.globeHint) dom.globeHint.classList.add('is-hidden'); if (state.cameraMode !== 'free') setCameraMode('free'); };
  const pinchMidpoint = () => { const pts = [...activePointers.values()]; return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }; };
  const pinchDistance = () => { const pts = [...activePointers.values()]; return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y); };

  el.addEventListener('pointerdown', (e) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); el.setPointerCapture(e.pointerId);
    Globe.lastInteraction = Date.now(); if (dom.globeHint) dom.globeHint.classList.add('is-hidden');
    if (activePointers.size === 2) { Globe.isDragging = false; pinchStartDistance = pinchDistance(); }
    else if (activePointers.size === 1) { Globe.isDragging = true; dragStartX = e.clientX; dragStartY = e.clientY; rotationStartX = Globe.group.rotation.x; rotationStartY = Globe.group.rotation.y; }
  });
  el.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    Globe.lastInteraction = Date.now(); activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) { const d = pinchDistance() - pinchStartDistance; pinchStartDistance = pinchDistance(); const m = pinchMidpoint(); zoomGlobeBy(-d * 0.012, raycastGlobePoint(m.x, m.y)); return; }
    if (!Globe.isDragging) return;
    if (state.cameraMode !== 'free') setCameraMode('free');
    Globe.group.rotation.y = rotationStartY + (e.clientX - dragStartX) * 0.0055;
    Globe.group.rotation.x = clamp(rotationStartX + (e.clientY - dragStartY) * 0.0055, -1.2, 1.2);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((n) => { el.addEventListener(n, (e) => { activePointers.delete(e.pointerId); if (activePointers.size < 2) pinchStartDistance = 0; if (activePointers.size === 0) Globe.isDragging = false; }); });
  el.addEventListener('wheel', (e) => { e.preventDefault(); markInteraction(); zoomGlobeBy(e.deltaY * 0.0025, raycastGlobePoint(e.clientX, e.clientY)); }, { passive: false });
  dom.globeZoomInBtn.addEventListener('click', () => { Globe.lastInteraction = Date.now(); zoomGlobeBy(-CONFIG.GLOBE_ZOOM_STEP, null); });
  dom.globeZoomOutBtn.addEventListener('click', () => { Globe.lastInteraction = Date.now(); zoomGlobeBy(CONFIG.GLOBE_ZOOM_STEP, null); });
  if (dom.cameraModeSwitcher) { dom.cameraModeSwitcher.addEventListener('click', (e) => { const btn = e.target.closest('button[data-mode]'); if (btn) setCameraMode(btn.dataset.mode); }); }
  const dayNightBtn = document.getElementById('dayNightToggle');
  if (dayNightBtn) {
    const restoreDayNight = () => {
      const on = Settings.data.showDayNight;
      dayNightBtn.classList.toggle('is-active', on);
      dayNightBtn.setAttribute('aria-pressed', String(on));
      if (Globe.earthMaterial) Globe.earthMaterial.uniforms.showDayNight.value = on ? 1.0 : 0.0;
    };
    restoreDayNight();
    dayNightBtn.addEventListener('click', () => {
      const on = dayNightBtn.classList.toggle('is-active');
      if (Globe.earthMaterial) Globe.earthMaterial.uniforms.showDayNight.value = on ? 1.0 : 0.0;
      dayNightBtn.setAttribute('aria-pressed', String(on));
      Settings.set('showDayNight', on);
    });
  }
}

function raycastGlobePoint(cx, cy) {
  if (!Globe.earthMesh || !Globe.raycaster) return null;
  const r = Globe.renderer.domElement.getBoundingClientRect();
  Globe.pointerNDC.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  Globe.earthMesh.updateMatrixWorld();
  Globe.raycaster.setFromCamera(Globe.pointerNDC, Globe.camera);
  const hits = Globe.raycaster.intersectObject(Globe.earthMesh, false);
  return hits.length ? hits[0].point : null;
}
function zoomGlobeBy(delta, targetPoint) {
  const c = Globe.zero;
  const cur = Globe.camera.position.distanceTo(c);
  const next = clamp(cur + delta, CONFIG.GLOBE_MIN_ZOOM, CONFIG.GLOBE_MAX_ZOOM);
  const actual = next - cur;
  if (actual === 0) return;
  const aim = (targetPoint || c).clone().sub(Globe.camera.position).normalize();
  Globe.camera.position.addScaledVector(aim, -actual);
  Globe.camera.lookAt(c);
}
function buildIssModel() {
  const group = new THREE.Group();
  const trussMat = new THREE.MeshBasicMaterial({ color: 0xaab4c4 });
  group.add(new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.0035, 0.0035), trussMat));
  const panelMat = new THREE.MeshBasicMaterial({ color: 0x2a6cd8, side: THREE.DoubleSide });
  const panelGeo = new THREE.BoxGeometry(0.034, 0.001, 0.058);
  const gridMat = new THREE.LineBasicMaterial({ color: 0xbfe0ff, transparent: true, opacity: 0.8 });
  [-0.093, -0.058, 0.058, 0.093].forEach((x) => {
    const wing = new THREE.Mesh(panelGeo, panelMat);
    wing.position.x = x;
    group.add(wing);
    const wireframe = new THREE.LineSegments(new THREE.EdgesGeometry(panelGeo), gridMat);
    wireframe.position.x = x;
    group.add(wireframe);
  });
  const moduleMat = new THREE.MeshBasicMaterial({ color: 0xd8e0ea });
  const moduleGeo = new THREE.CylinderGeometry(0.0115, 0.0115, 0.026, 10);
  [-0.026, 0, 0.026].forEach((z) => {
    const segment = new THREE.Mesh(moduleGeo, moduleMat);
    segment.rotation.x = Math.PI / 2;
    segment.position.z = z;
    group.add(segment);
  });
  const radiatorMat = new THREE.MeshBasicMaterial({ color: 0xe7edf5, side: THREE.DoubleSide });
  const radiatorGeo = new THREE.BoxGeometry(0.03, 0.001, 0.014);
  const radiatorTop = new THREE.Mesh(radiatorGeo, radiatorMat);
  radiatorTop.position.set(0, 0.02, 0.03);
  const radiatorBottom = new THREE.Mesh(radiatorGeo, radiatorMat);
  radiatorBottom.position.set(0, -0.02, 0.03);
  group.add(radiatorTop, radiatorBottom);
  const tipMat = new THREE.MeshBasicMaterial({ color: 0xfc3c23 });
  group.add(new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 8), tipMat));
  return group;
}
function placeGlobeMarker(lat, lon) {
  const v = latLonToLocalVector(lat, lon, 1.3);
  if (!Globe.issMesh) return;
  Globe.issMesh.position.set(v.x, v.y, v.z);
  ensureGlobeHelpers();
  _vUp.set(v.x, v.y, v.z).normalize();
  _vFwd.copy(Globe.motionDir);
  _vFwd.addScaledVector(_vUp, -_vFwd.dot(_vUp));
  if (_vFwd.lengthSq() < 1e-6) return;
  _vFwd.normalize();
  _vRight.crossVectors(_vUp, _vFwd).normalize();
  _mBasis.makeBasis(_vRight, _vUp, _vFwd);
  _qTarget.setFromRotationMatrix(_mBasis);
  Globe.issMesh.quaternion.slerp(_qTarget, 0.2);
}
function updateGlobeMarker(lat, lon) {
  Globe.pendingLatLon = [lat, lon];
  if (!Globe.issMesh) return;
  if (state.motion.from && state.motion.to) {
    if (!Globe.motionDir) Globe.motionDir = new THREE.Vector3();
    const f = latLonToLocalVector(state.motion.from[0], state.motion.from[1], 1.3);
    const t = latLonToLocalVector(state.motion.to[0], state.motion.to[1], 1.3);
    Globe.motionDir.set(t.x - f.x, t.y - f.y, t.z - f.z);
  }
  placeGlobeMarker(lat, lon);
}
function updateGlobePredictedPath(points) {
  if (!points || points.length < 2) return;
  if (!Globe.group || !Globe.predictedLine) { Globe.pendingPredictedPath = points; return; }
  const vecs = points.map(([lat, lon]) => {
    const v = latLonToLocalVector(lat, lon, 1.3);
    return new THREE.Vector3(v.x, v.y, v.z);
  });
  Globe.predictedLine.geometry.dispose();
  Globe.predictedLine.geometry = new THREE.BufferGeometry().setFromPoints(vecs);
}
function updateGlobePastOrbitPath(points) {
  if (!points || points.length < 2) return;
  if (!Globe.group || !Globe.pastOrbitLine) { Globe.pendingPastOrbitPath = points; return; }
  const vecs = points.map(([lat, lon]) => {
    const v = latLonToLocalVector(lat, lon, 1.3);
    return new THREE.Vector3(v.x, v.y, v.z);
  });
  Globe.pastOrbitLine.geometry.dispose();
  Globe.pastOrbitLine.geometry = new THREE.BufferGeometry().setFromPoints(vecs);
}
function updateDebugRenderStatsGlobe() {
  if (!Settings.data.debug || !Globe.renderer) return;
  const info = Globe.renderer.info;
  dom.dbgDrawCalls.textContent = info.render.calls;
  dom.dbgTriangles.textContent = info.render.triangles.toLocaleString();
  dom.dbgGpuMem.textContent = `~${((info.memory.geometries + info.memory.textures) * 2.5).toFixed(0)} MB (est.)`;
}
function setViewMode(mode) {
  if (mode === 'globe' && Globe.supported === false) mode = 'map';
  state.currentView = mode;
  Settings.set('viewMode', mode);
  const isMap = mode === 'map';
  dom.mapModeBtn.classList.toggle('is-active', isMap);
  dom.globeModeBtn.classList.toggle('is-active', !isMap);
  mapInstance.getContainer().style.display = isMap ? 'block' : 'none';
  dom.globeView.classList.toggle('hidden', isMap);
  dom.globeView.style.display = isMap ? 'none' : 'grid';
  if (isMap) { if (Globe.animationFrame) { cancelAnimationFrame(Globe.animationFrame); Globe.animationFrame = null; } return; }
  if (!Globe.renderer && Globe.supported !== false) initGlobe();
  else if (!Globe.animationFrame && Globe.supported) { Globe.lastInteraction = Date.now(); runGlobeAnimation(); }
  if (state.motion.current) updateGlobeMarker(state.motion.current[0], state.motion.current[1]);
}

const CREW_DATA = [
  { name: 'Matthew Dominick', nationality: 'American', agency: 'NASA', mission: 'Expedition 71', role: 'Commander', timeInSpace: '186 days', photo: '' },
  { name: 'Michael Barratt', nationality: 'American', agency: 'NASA', mission: 'Expedition 71', role: 'Flight Engineer', timeInSpace: '212 days', photo: '' },
  { name: 'Jeanette Epps', nationality: 'American', agency: 'NASA', mission: 'Expedition 71', role: 'Flight Engineer', timeInSpace: '186 days', photo: '' },
  { name: 'Alexander Grebenkin', nationality: 'Russian', agency: 'Roscosmos', mission: 'Expedition 71', role: 'Flight Engineer', timeInSpace: '186 days', photo: '' },
  { name: 'Tracy C. Dyson', nationality: 'American', agency: 'NASA', mission: 'Expedition 71', role: 'Flight Engineer', timeInSpace: '376 days', photo: '' },
  { name: 'Oleg Kononenko', nationality: 'Russian', agency: 'Roscosmos', mission: 'Expedition 71', role: 'Flight Engineer', timeInSpace: '1111 days', photo: '' },
  { name: 'Nikolai Chub', nationality: 'Russian', agency: 'Roscosmos', mission: 'Expedition 71', role: 'Flight Engineer', timeInSpace: '374 days', photo: '' }
];
const SPACECRAFT_DATA = [
  { name: 'Soyuz MS-25', mission: 'Expedition 71 Crew Transport', launchDate: '2024-03-23', type: 'Soyuz MS', port: 'Rassvet', status: 'Docked' },
  { name: 'Soyuz MS-26', mission: 'Expedition 71 Crew Transport', launchDate: '2024-09-11', type: 'Soyuz MS', port: 'Poisk', status: 'Docked' },
  { name: 'Progress MS-27', mission: 'Cargo Resupply', launchDate: '2024-06-01', type: 'Progress MS', port: 'Zvezda Aft', status: 'Docked' },
  { name: 'Progress MS-28', mission: 'Cargo Resupply', launchDate: '2024-08-15', type: 'Progress MS', port: 'Pirs', status: 'Docked' },
  { name: 'SpaceX Crew-8', mission: 'Crew-8 Rotation', launchDate: '2024-03-05', type: 'Crew Dragon', port: 'Harmony Forward', status: 'Docked' }
];
const AGENCY_LOGOS = { NASA: '🛸', Roscosmos: '🇷🇺', ESA: '🇪🇺', JAXA: '🇯🇵', SpaceX: '🚀' };

function renderCrew() {
  if (!dom.crewList) return;
  state.crew.members = CREW_DATA.slice(0, 7);
  state.crew.loaded = true;
  if (dom.crewCount) dom.crewCount.textContent = state.crew.members.length;
  dom.crewList.innerHTML = state.crew.members.map((m) => `<div class="crew-member" tabindex="0" role="listitem" aria-label="${m.name}, ${m.role}"><div class="crew-avatar" aria-hidden="true">${m.photo ? `<img src="${m.photo}" alt="" loading="lazy" />` : `<span class="crew-avatar-fallback">${AGENCY_LOGOS[m.agency] || '👨‍🚀'}</span>`}</div><div class="crew-info"><div class="crew-name">${m.name}</div><div class="crew-role">${m.role}</div><div class="crew-meta"><span class="crew-agency">${m.agency}</span><span class="crew-sep" aria-hidden="true">·</span><span class="crew-nationality">${m.nationality}</span></div><div class="crew-meta"><span>${m.mission}</span><span class="crew-sep" aria-hidden="true">·</span><span>${m.timeInSpace}</span></div></div></div>`).join('');
}

function renderSpacecraft() {
  if (!dom.spacecraftList) return;
  const colors = { Docked: '#ba1e68', Docking: '#fc3c23', Undocking: '#8a1e40' };
  dom.spacecraftList.innerHTML = SPACECRAFT_DATA.map((c) => `<div class="spacecraft-item" tabindex="0" role="listitem" aria-label="${c.name}, ${c.status}"><div class="spacecraft-header"><strong class="spacecraft-name">${c.name}</strong><span class="spacecraft-status" style="color: ${colors[c.status] || '#666'}">${c.status}</span></div><div class="spacecraft-mission">${c.mission}</div><div class="spacecraft-meta"><span>Type: ${c.type}</span><span class="crew-sep">·</span><span>Port: ${c.port}</span><span class="crew-sep">·</span><span>Launched: ${c.launchDate}</span></div></div>`).join('');
}

let weatherCache = null;
let weatherFetching = false;

async function fetchSpaceWeather() {
  if (!dom.kpIndex) return;
  if (weatherCache && Date.now() - weatherCache.time < 300000) { renderWeather(weatherCache.data); return; }
  if (weatherFetching) return;
  weatherFetching = true;
  let success = false;
  try {
    const resp = await fetchWithTimeout('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json', {}, 5000);
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.length > 0) {
        const latest = data[data.length - 1];
        const kp = latest.kp_index || latest.kp || 0;
        weatherCache = { data: { kp: parseFloat(kp) }, time: Date.now() };
        renderWeather(weatherCache.data);
        success = true;
      }
    }
  } catch (e) {}
  if (!success) renderPlaceholderWeather();
  weatherFetching = false;
}

function renderWeather(data) {
  if (data.kp != null) {
    const level = data.kp < 3 ? 'Quiet' : data.kp < 5 ? 'Active' : data.kp < 7 ? 'Storm' : 'Severe Storm';
    const color = data.kp < 3 ? '#4ade80' : data.kp < 5 ? '#facc15' : data.kp < 7 ? '#fb923c' : '#ef4444';
    dom.kpIndex.textContent = `${data.kp.toFixed(1)} (${level})`;
    dom.kpIndex.style.color = color;
  }
  dom.solarActivity.textContent = data.solarActivity || 'Stable';
  dom.geomagneticConditions.textContent = data.geomagnetic || 'Quiet';
  dom.radiationLevel.textContent = data.radiation || 'Normal';
  dom.auroraActivity.textContent = data.aurora || 'Low';
  dom.spaceWeatherStatus.textContent = 'Nominal';
  state.weather.loaded = true;
}

function renderPlaceholderWeather() {
  const ph = (l) => `${l} <span class="weather-note">(unavailable)</span>`;
  dom.kpIndex.innerHTML = ph('--');
  dom.solarActivity.innerHTML = ph('--');
  dom.geomagneticConditions.innerHTML = ph('--');
  dom.radiationLevel.innerHTML = ph('--');
  dom.auroraActivity.innerHTML = ph('--');
  dom.spaceWeatherStatus.textContent = 'Data unavailable';
  state.weather.loaded = true;
}

function updateMissionTimeline(now) {
  if (!dom.timelineEvents) return;
  const nextOrbit = CONFIG.ISS_ORBIT_PERIOD_MIN * 60000;
  const events = [
    { time: now, label: 'Last Telemetry Update', type: 'update' },
    { time: new Date(now.getTime() + nextOrbit), label: 'Next Orbit Completion', type: 'orbit' }
  ];
  events.sort((a, b) => a.time - b.time);
  dom.timelineEvents.innerHTML = events.slice(0, 5).map((ev) => {
    const diff = ev.time.getTime() - now.getTime();
    const isPast = diff < 0;
    return `<div class="timeline-event ${isPast ? 'past' : 'future'}" role="listitem"><div class="timeline-dot" aria-hidden="true"></div><div class="timeline-content"><div class="timeline-label">${ev.label}</div><div class="timeline-time">${ev.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${isPast ? ' (completed)' : ''}</div></div></div>`;
  }).join('');
}

const LOADER_STAGES = [
  { label: 'Initializing systems', duration: 400 },
  { label: 'Connecting to telemetry', duration: 600 },
  { label: 'Synchronizing orbital data', duration: 500 },
  { label: 'Loading crew information', duration: 400 },
  { label: 'Ready', duration: 300 }
];

async function runLoadingSequence() {
  const overlay = dom.loadingOverlay;
  const statusEl = dom.loadingStatus;
  if (!overlay || !statusEl) return;
  overlay.classList.remove('hidden');
  overlay.classList.add('loading-active');
  for (const stage of LOADER_STAGES) {
    state.loadingStage = stage.label;
    statusEl.textContent = stage.label;
    if (stage.label === 'Connecting to telemetry') await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, stage.duration));
  }
  overlay.classList.add('loading-fade');
  await new Promise((r) => setTimeout(r, 500));
  overlay.classList.add('hidden');
  overlay.classList.remove('loading-active', 'loading-fade');
  state.loadingComplete = true;
}

function animateRollingNumber(element, target, suffix = '', duration = 600) {
  if (!element) return;
  const start = parseFloat(element.dataset.value) || 0;
  const diff = target - start;
  if (Math.abs(diff) < 0.01) return;
  element.dataset.value = target;
  const startTime = performance.now();
  function update(time) {
    const elapsed = time - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = `${(start + diff * eased).toFixed(1)}${suffix}`;
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

function animateCardEntrance(cards) {
  cards.forEach((card, index) => {
    card.style.opacity = '0';
    card.style.transform = 'translateY(8px)';
    card.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    requestAnimationFrame(() => { setTimeout(() => { card.style.opacity = '1'; card.style.transform = 'translateY(0)'; }, index * 50); });
  });
}

function setupHoverAnimations() {
  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('pointerenter', () => { card.style.transition = 'border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease'; });
    card.addEventListener('pointerleave', () => { card.style.transition = 'border-color 0.3s ease, transform 0.3s ease, box-shadow 0.3s ease'; });
  });
}

function initAccessibility() {
  document.querySelectorAll('button').forEach((btn) => {
    if (!btn.getAttribute('aria-label') && !btn.getAttribute('aria-labelledby')) btn.setAttribute('aria-label', btn.textContent.trim());
  });
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) sidebar.setAttribute('role', 'region');
  const mapShell = document.querySelector('.map-shell');
  if (mapShell) mapShell.setAttribute('role', 'region');
  document.querySelectorAll('.card').forEach((card) => card.setAttribute('tabindex', '0'));
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq.matches) document.documentElement.classList.add('reduced-motion');
  mq.addEventListener('change', (e) => document.documentElement.classList.toggle('reduced-motion', e.matches));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const banner = document.getElementById('offlineBanner');
      if (banner && !banner.classList.contains('hidden')) banner.classList.add('hidden');
    }
  });
}

function setDebugMode(enabled) {
  Settings.set('debug', enabled);
  dom.debugOverlay.classList.toggle('hidden', !enabled);
}

function init() {
  document.body.classList.add('initializing');
  const saved = Settings.load();
  state.autoCenter = saved.autoCenter;
  state.cameraMode = saved.cameraMode;
  dom.followBtn.textContent = state.autoCenter ? 'Pause Follow' : 'Follow ISS';
  [dom.camFreeBtn, dom.camFollowBtn, dom.camTopBtn].forEach((btn) => { if (btn) btn.classList.toggle('is-active', btn.dataset.mode === state.cameraMode); });
  if (saved.debug) setDebugMode(true);

  initAccessibility();
  setupHoverAnimations();
  initMap();

  const savedView = saved.viewMode === 'globe' ? 'globe' : 'map';
  setViewMode(savedView);
  if (savedView === 'globe') setTimeout(() => setCameraMode(state.cameraMode), 200);

  let lastHeading = 0;
  let lastPredictedPath = null;
  onPositionUpdate = (lat, lon) => {
    updateMapPosition(lat, lon, state.lastHeading ?? lastHeading);
    updateTrail(lat, lon);
    if (state.currentView === 'globe') updateGlobeMarker(lat, lon);
    if (state.predictedPath !== lastPredictedPath) {
      lastPredictedPath = state.predictedPath;
      updatePredictedPath(state.predictedPath);
      updateGlobePredictedPath(state.predictedPath);
      updatePastOrbitPath(state.pastOrbitPath);
      updateGlobePastOrbitPath(state.pastOrbitPath);
    }
  };

  getCurrentBrowserLocation();
  renderCrew();
  renderSpacecraft();
  fetchSpaceWeather();

  runLoadingSequence().then(() => animateCardEntrance(document.querySelectorAll('.card')));

  getISS();
  requestAnimationFrame(runMotionLoop);

  window.addEventListener('online', () => { state.net.online = true; getISS(); });
  window.addEventListener('offline', () => {
    state.net.online = false;
    if (dom.offlineBanner) { dom.offlineBanner.classList.remove('hidden'); dom.offlineBannerText.textContent = 'Your device is offline. Showing last known telemetry.'; }
    dom.connection.textContent = 'Offline';
    if (dom.indicator) dom.indicator.style.backgroundColor = '#555555';
  });
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey) {
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
      setDebugMode(!Settings.data.debug);
    }
  });

  dom.cards.forEach((card) => {
    card.addEventListener('pointerenter', () => card.classList.add('is-active'));
    card.addEventListener('pointerleave', () => card.classList.remove('is-active'));
  });

  dom.followBtn.addEventListener('click', toggleAutoCenter);
  dom.zoomISSBtn.addEventListener('click', () => { if (state.motion.current) flyToISS(state.motion.current[0], state.motion.current[1]); });
  dom.resetBtn.addEventListener('click', resetMapView);
  dom.mapModeBtn.addEventListener('click', () => setViewMode('map'));
  dom.globeModeBtn.addEventListener('click', () => setViewMode('globe'));

  setInterval(() => {
    updateDataAge();
    const now = new Date();
    if (state.motion.current) {
      const vel = state.lastVelocity || 27600;
      updatePassPrediction(state.motion.current[0], state.motion.current[1], vel);
      updateMissionTimeline(now);
    }
  }, 2000);

  updateDataAge();
}

init();

})();

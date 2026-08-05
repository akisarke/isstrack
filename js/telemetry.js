import { CONFIG } from './config.js';
import { state, Cache } from './state.js';
import { dom } from './dom.js';
import {
  clamp, easeInOutQuad, formatDegrees, formatKm, formatUTC,
  calculateDistance, bearing, destinationPoint, interpolateGreatCircle, getLocationLabel,
  animateValue, getHemisphere, getSubsolarPoint, formatDuration
} from './utils.js';
import { fetchWithRetry, fetchWithTimeout, updateDataAge, updateAPIHealth } from './api.js';

let lastMotionSettled = true;
let _onPositionUpdate = null;

export function onPositionUpdate(callback) {
  _onPositionUpdate = callback;
}

function beginMotionTransition(nextLat, nextLon) {
  const previous = state.motion.current;
  state.motion.from = previous || [nextLat, nextLon];
  state.motion.to = [nextLat, nextLon];
  state.motion.startedAt = performance.now();
  state.motion.durationMs = CONFIG.UPDATE_INTERVAL_MS;
}

export function runMotionLoop(timestamp) {
  const dt = timestamp - state.debug.lastFrameAt;
  state.debug.lastFrameAt = timestamp;
  if (dt > 0) {
    state.debug.frameTimeMs = dt;
    state.debug.fps = 1000 / dt;
  }

  if (state.motion.to) {
    const elapsed = performance.now() - state.motion.startedAt;
    const f = easeInOutQuad(clamp(elapsed / state.motion.durationMs, 0, 1));
    const [lat, lon] = interpolateGreatCircle(
      state.motion.from[0],
      state.motion.from[1],
      state.motion.to[0],
      state.motion.to[1],
      f
    );
    state.motion.current = [lat, lon];
    renderPosition(lat, lon, f >= 1 && !lastMotionSettled);
    lastMotionSettled = f >= 1;
  }

  updateDebugOverlay();
  requestAnimationFrame(runMotionLoop);
}

function renderPosition(lat, lon, settled) {
  dom.lat.textContent = formatDegrees(lat);
  dom.lon.textContent = formatDegrees(lon);

  if (settled) {
    setTimeout(() => {
      animateValue(dom.lat);
      animateValue(dom.lon);
    }, 0);
  }

  if (_onPositionUpdate) {
    _onPositionUpdate(lat, lon);
  }
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
  dom.telemetryStatus.textContent = state.net.usingCachedData
    ? 'Showing last known telemetry...'
    : 'Receiving telemetry...';

  const hemisphere = getHemisphere(lat);
  const sector = Math.abs(lon) < 180 ? (lon >= 0 ? 'East' : 'West') : '';
  if (dom.hemisphere) dom.hemisphere.textContent = `${hemisphere} Hemisphere`;

  const localTimeOffset = lon * 4;
  const localMs = now.getTime() + localTimeOffset * 60000;
  const localDate = new Date(localMs);
  if (dom.localTime) dom.localTime.textContent = localDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (dom.sunState) dom.sunState.textContent = visibility === 'eclipsed' ? 'Night (Eclipsed)' : 'Daylight';

  if (state.lastPosition) {
    const dist = calculateDistance(state.lastPosition[0], state.lastPosition[1], lat, lon);
    state.totalDistance += dist;
    state.sessionDistance += dist;
  }
  state.lastPosition = [lat, lon];

  if (dom.distanceToday) dom.distanceToday.textContent = `${Math.round(state.totalDistance).toLocaleString()} km`;
  if (dom.distanceSession) dom.distanceSession.textContent = `${Math.round(state.sessionDistance).toLocaleString()} km`;

  if (dom.orbitProgress) {
    const progress = state.motion.from && state.motion.to
      ? 0
      : 0;
    dom.orbitProgress.textContent = `${Math.round(progress)}%`;
  }

  updateDataAge();

  const statusCard = document.querySelector('.selected');
  if (statusCard) {
    statusCard.classList.add('u--packet-received');
    setTimeout(() => statusCard.classList.remove('u--packet-received'), 600);
  }
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

export async function getISS() {
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
      latitude,
      longitude
    );

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('Invalid ISS coordinates returned by API');
    }

    state.net.consecutiveFailures = 0;
    state.net.usingCachedData = false;
    state.net.lastSuccessAt = Date.now();
    showOfflineBanner(false);
    updateAPIHealth(true);

    beginMotionTransition(latitude, longitude);
    state.lastVelocity = Number.isFinite(vel) && vel > 0 ? vel : state.lastVelocity;
    state.lastHeading = heading;
    state.updateCount += 1;

    computePredictedPath(latitude, longitude, heading, state.lastVelocity ?? vel);

    animateValue(dom.lat);
    animateValue(dom.lon);
    animateValue(dom.speed);
    animateValue(dom.packets);

    updateTelemetryDOM(latitude, longitude, altitude, state.lastVelocity ?? vel, heading, visibility);

    document.body.classList.remove('initializing');

    Cache.write({
      latitude,
      longitude,
      velocity: state.lastVelocity,
      altitude,
      heading,
      visibility,
      savedAt: Date.now()
    });

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

const PREDICTED_HORIZON_MIN = 20;
const PREDICTED_STEP_MIN = 4;

function computePredictedPath(latitude, longitude, heading, speedKmh) {
  const points = [];
  const speedKmS = Math.max(Number(speedKmh) || 27600, 1) / 3600;
  for (let t = PREDICTED_STEP_MIN; t <= PREDICTED_HORIZON_MIN; t += PREDICTED_STEP_MIN) {
    points.push(destinationPoint(latitude, longitude, heading, speedKmS * t * 60));
  }
  state.predictedPath = points;
}

export function updatePassPrediction(latitude, longitude, speed) {
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

export async function getCurrentBrowserLocation() {
  if (!navigator.geolocation) {
    await resolveLocationFallback();
    return;
  }
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
  } catch (error) {
    console.warn('Falling back to default pass location:', error);
  }
  state.passLocation = CONFIG.DEFAULT_PASS_LOCATION;
  dom.passLocation.textContent = getLocationLabel(state.passLocation);
}

export function updateDebugOverlay() {
  if (!document.querySelector('.debug-overlay:not(.hidden)')) return;
  const dbgFps = document.getElementById('dbgFps');
  const dbgFrameTime = document.getElementById('dbgFrameTime');
  const dbgLatency = document.getElementById('dbgLatency');
  if (dbgFps) dbgFps.textContent = Math.round(state.debug.fps);
  if (dbgFrameTime) dbgFrameTime.textContent = `${state.debug.frameTimeMs.toFixed(1)} ms`;
  if (dbgLatency) dbgLatency.textContent = state.net.lastLatencyMs != null ? `${state.net.lastLatencyMs} ms` : '--';
}

import { Settings, state } from './state.js';
import { dom } from './dom.js';
import { getISS, runMotionLoop, getCurrentBrowserLocation, updatePassPrediction, onPositionUpdate } from './telemetry.js';
import { initMap, updateMapPosition, updateTrail, updatePredictedPath, updatePastOrbitPath, flyToISS, resetView, toggleAutoCenter, getMap } from './map.js';
import { initGlobe, setCameraMode, updateGlobeMarker, updateGlobePredictedPath, updateGlobePastOrbitPath, setViewMode } from './globe.js';
import { renderCrew, renderSpacecraft, fetchSpaceWeather, updateMissionTimeline } from './features.js';
import { runLoadingSequence } from './loader.js';
import { animateCardEntrance, setupHoverAnimations } from './animations.js';
import { initAccessibility } from './accessibility.js';
import { updateDataAge } from './api.js';

function setDebugMode(enabled) {
  Settings.set('debug', enabled);
  dom.debugOverlay.classList.toggle('hidden', !enabled);
}

export function init() {
  document.body.classList.add('initializing');

  const saved = Settings.load();
  state.autoCenter = saved.autoCenter;
  state.cameraMode = saved.cameraMode;
  dom.followBtn.textContent = state.autoCenter ? 'Pause Follow' : 'Follow ISS';

  [dom.camFreeBtn, dom.camFollowBtn, dom.camTopBtn].forEach((btn) => {
    if (btn) btn.classList.toggle('is-active', btn.dataset.mode === state.cameraMode);
  });
  if (saved.debug) setDebugMode(true);

  initAccessibility();
  setupHoverAnimations();

  const mapInstance = initMap();
  const savedView = saved.viewMode === 'globe' ? 'globe' : 'map';
  setViewMode(savedView, mapInstance);
  if (savedView === 'globe') {
    setTimeout(() => setCameraMode(state.cameraMode), 200);
  }

  let lastHeading = 0;
  let lastPredictedPath = null;

  onPositionUpdate((lat, lon) => {
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
  });

  getCurrentBrowserLocation();
  renderCrew();
  renderSpacecraft();
  fetchSpaceWeather();

  runLoadingSequence().then(() => {
    animateCardEntrance(document.querySelectorAll('.card'));
  });

  getISS();
  requestAnimationFrame(runMotionLoop);

  window.addEventListener('online', () => {
    state.net.online = true;
    getISS();
  });
  window.addEventListener('offline', () => {
    state.net.online = false;
    const banner = dom.offlineBanner;
    if (banner) {
      banner.classList.remove('hidden');
      dom.offlineBannerText.textContent = 'Your device is offline. Showing last known telemetry.';
    }
    dom.connection.textContent = 'Offline';
    if (dom.indicator) dom.indicator.style.backgroundColor = '#555555';
  });

  window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'd' && !event.metaKey && !event.ctrlKey) {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      setDebugMode(!Settings.data.debug);
    }
  });

  dom.cards.forEach((card) => {
    card.addEventListener('pointerenter', () => card.classList.add('is-active'));
    card.addEventListener('pointerleave', () => card.classList.remove('is-active'));
  });

  dom.followBtn.addEventListener('click', toggleAutoCenter);

  dom.zoomISSBtn.addEventListener('click', () => {
    if (state.motion.current) flyToISS(state.motion.current[0], state.motion.current[1]);
  });

  dom.resetBtn.addEventListener('click', resetView);

  dom.mapModeBtn.addEventListener('click', () => setViewMode('map', mapInstance));
  dom.globeModeBtn.addEventListener('click', () => setViewMode('globe', mapInstance));

  let telemetryInterval = setInterval(() => {
    updateDataAge();
    const now = new Date();
    if (state.motion.current) {
      const vel = state.lastVelocity || 27600;
      updatePassPrediction(state.motion.current[0], state.motion.current[1], vel);
      updateMissionTimeline(now, null);
    }
  }, 2000);

  updateDataAge();

  return {
    cleanup: () => {
      clearInterval(telemetryInterval);
    }
  };
}

init();

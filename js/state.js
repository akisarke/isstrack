import { CONFIG } from './config.js';

export const Settings = {
  data: { autoCenter: true, viewMode: 'map', cameraMode: 'free', debug: false },

  load() {
    try {
      const raw = localStorage.getItem(CONFIG.SETTINGS_KEY);
      if (raw) this.data = { ...this.data, ...JSON.parse(raw) };
    } catch (e) {
      console.warn('Settings unavailable, using defaults:', e);
    }
    return this.data;
  },

  save() {
    try {
      localStorage.setItem(CONFIG.SETTINGS_KEY, JSON.stringify(this.data));
    } catch (e) {}
  },

  set(key, value) {
    this.data[key] = value;
    this.save();
  }
};

export const Cache = {
  read() {
    try {
      const raw = localStorage.getItem(CONFIG.CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  write(payload) {
    try {
      localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify(payload));
    } catch {}
  }
};

export const CrewCache = {
  read() {
    try {
      const raw = localStorage.getItem(CONFIG.CREW_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  write(payload) {
    try {
      localStorage.setItem(CONFIG.CREW_CACHE_KEY, JSON.stringify(payload));
    } catch {}
  }
};

export const state = {
  updateCount: 0,
  totalDistance: 0,
  sessionDistance: 0,
  lastPosition: null,
  lastVelocity: null,
  lastPacketAt: null,
  trailPoints: [],
  userLocation: null,
  passLocation: CONFIG.DEFAULT_PASS_LOCATION,
  autoCenter: true,
  currentView: 'map',
  cameraMode: 'free',

  motion: {
    from: null,
    to: null,
    startedAt: 0,
    durationMs: CONFIG.UPDATE_INTERVAL_MS,
    current: null
  },

  net: {
    online: navigator.onLine,
    consecutiveFailures: 0,
    lastLatencyMs: null,
    pollTimer: null,
    usingCachedData: false,
    apiHealthy: true,
    lastSuccessAt: null
  },

  debug: {
    fps: 0,
    frameTimeMs: 0,
    lastFrameAt: performance.now()
  },

  crew: {
    members: [],
    loaded: false
  },

  weather: {
    kp: null,
    solarActivity: null,
    geomagnetic: null,
    loaded: false
  },

  loadingStage: '',
  loadingComplete: false
};

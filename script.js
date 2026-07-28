"use strict";

const CONFIG = Object.freeze({
  UPDATE_INTERVAL_MS: 5000,
  MAX_TRAIL_POINTS: 40,
  REQUEST_TIMEOUT_MS: 8000,
  MAX_RETRIES: 2,
  RETRY_BASE_DELAY_MS: 700,
  MAX_BACKOFF_MS: 20000,
  DEFAULT_PASS_LOCATION: { lat: 44.62, lon: 21.18 },
  ISS_API: "https://api.wheretheiss.at/v1/satellites/25544",
  IP_GEO_API: "https://ipapi.co/json/",
  SETTINGS_KEY: "isstrack:settings:v1",
  CACHE_KEY: "isstrack:lastKnown:v1",
  GLOBE_TEXTURE_BASE:
    "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/",
  GLOBE_MIN_ZOOM: 2.0,
  GLOBE_MAX_ZOOM: 7,
  GLOBE_ZOOM_STEP: 0.5,
});

const Settings = {
  data: { autoCenter: true, viewMode: "map", cameraMode: "free", debug: false },

  load() {
    try {
      const raw = localStorage.getItem(CONFIG.SETTINGS_KEY);
      if (raw) {
        this.data = { ...this.data, ...JSON.parse(raw) };
      }
    } catch (error) {
      console.warn("Settings unavailable, using defaults:", error);
    }
    return this.data;
  },

  save() {
    try {
      localStorage.setItem(CONFIG.SETTINGS_KEY, JSON.stringify(this.data));
    } catch (error) {}
  },

  set(key, value) {
    this.data[key] = value;
    this.save();
  },
};

const Cache = {
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
  },
};

const state = {
  updateCount: 0,
  totalDistance: 0,
  lastVelocity: null,
  lastPacketAt: null,
  trailPoints: [],
  userLocation: null,
  passLocation: CONFIG.DEFAULT_PASS_LOCATION,
  autoCenter: true,
  currentView: "map",
  cameraMode: "free",

  motion: {
    from: null, 
    to: null, 
    startedAt: 0,
    durationMs: CONFIG.UPDATE_INTERVAL_MS,
    current: null, 
  },

  net: {
    online: navigator.onLine,
    consecutiveFailures: 0,
    lastLatencyMs: null,
    pollTimer: null,
    usingCachedData: false,
  },

  debug: {
    fps: 0,
    frameTimeMs: 0,
    lastFrameAt: performance.now(),
  },
};

const dom = {
  lat: document.getElementById("lat"),
  lon: document.getElementById("lon"),
  altitude: document.getElementById("altitude"),
  altitudeOrbit: document.getElementById("altitudeOrbit"),
  velocity: document.getElementById("velocity"),
  speed: document.getElementById("speed"),
  heading: document.getElementById("heading"),
  orbitNumber: document.getElementById("orbitNumber"),
  orbitalPeriod: document.getElementById("orbitalPeriod"),
  packets: document.getElementById("updates"),
  connection: document.getElementById("connection"),
  indicator: document.querySelector(".indicator"),
  telemetryStatus: document.getElementById("telemetryStatus"),
  updated: document.getElementById("lastUpdated"),
  hudAltitude: document.getElementById("hudAltitude"),
  hudSpeed: document.getElementById("hudSpeed"),
  hudOrbit: document.getElementById("hudOrbit"),
  hudTime: document.getElementById("hudTime"),
  hudStatus: document.getElementById("hudStatus"),
  lastPacket: document.getElementById("lastPacket"),
  latency: document.getElementById("latency"),
  visibleIn: document.getElementById("visibleIn"),
  passDuration: document.getElementById("passDuration"),
  maxElevation: document.getElementById("maxElevation"),
  passLocation: document.getElementById("passLocation"),
  followBtn: document.getElementById("followBtn"),
  zoomISSBtn: document.getElementById("zoomISSBtn"),
  resetBtn: document.getElementById("resetBtn"),
  mapModeBtn: document.getElementById("mapModeBtn"),
  globeModeBtn: document.getElementById("globeModeBtn"),
  globeView: document.getElementById("globeView"),
  globeHint: document.getElementById("globeHint"),
  globeFallback: document.getElementById("globeFallback"),
  globeZoomInBtn: document.getElementById("globeZoomInBtn"),
  globeZoomOutBtn: document.getElementById("globeZoomOutBtn"),
  cameraModeSwitcher: document.getElementById("cameraModeSwitcher"),
  offlineBanner: document.getElementById("offlineBanner"),
  offlineBannerText: document.getElementById("offlineBannerText"),
  debugOverlay: document.getElementById("debugOverlay"),
  cards: document.querySelectorAll(".card"),
  dbgFps: document.getElementById("dbgFps"),
  dbgFrameTime: document.getElementById("dbgFrameTime"),
  dbgDrawCalls: document.getElementById("dbgDrawCalls"),
  dbgTriangles: document.getElementById("dbgTriangles"),
  dbgGpuMem: document.getElementById("dbgGpuMem"),
  dbgLatency: document.getElementById("dbgLatency"),
  dbgUpdateFreq: document.getElementById("dbgUpdateFreq"),
};

const DEG = Math.PI / 180;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateHeading(lat1, lon1, lat2, lon2) {
  const lat1Rad = lat1 * DEG;
  const lat2Rad = lat2 * DEG;
  const lonDiff = (lon2 - lon1) * DEG;
  const y = Math.sin(lonDiff) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(lonDiff);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function interpolateGreatCircle(lat1, lon1, lat2, lon2, f) {
  const phi1 = lat1 * DEG;
  const lam1 = lon1 * DEG;
  const phi2 = lat2 * DEG;
  const lam2 = lon2 * DEG;

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((phi2 - phi1) / 2) ** 2 +
          Math.cos(phi1) * Math.cos(phi2) * Math.sin((lam2 - lam1) / 2) ** 2,
      ),
    );

  if (d < 1e-9) {
    return [lat2, lon2];
  }

  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x =
    A * Math.cos(phi1) * Math.cos(lam1) + B * Math.cos(phi2) * Math.cos(lam2);
  const y =
    A * Math.cos(phi1) * Math.sin(lam1) + B * Math.cos(phi2) * Math.sin(lam2);
  const z = A * Math.sin(phi1) + B * Math.sin(phi2);

  const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG;
  const lon = Math.atan2(y, x) / DEG;
  return [lat, lon];
}

function formatDegrees(value) {
  return `${value.toFixed(4)}°`;
}

function formatKm(value) {
  return `${Math.round(value).toLocaleString()} km`;
}

function formatUTC(date) {
  return date.toISOString().slice(11, 19) + " UTC";
}

function getLocationLabel(location) {
  if (!location) return "Locating...";
  return `${location.lat.toFixed(3)}°, ${location.lon.toFixed(3)}°`;
}

function animateValue(element) {
  if (!element) return;
  element.classList.remove("loading");
  void element.offsetWidth;
  element.classList.add("loading");
}

function createMarkerIcon(angle) {
  return L.divIcon({
    className: "iss-marker",
    html: `
      <div class="satellite-arrow" style="transform: translateY(-12px) rotate(${angle}deg);"></div>
      <div class="satellite-core"></div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}



function getSubsolarPoint(date) {
  const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
  const days = (date.getTime() - J2000) / 86400000;
  const meanLon = (280.46 + 0.9856474 * days) % 360;
  const meanAnom = ((357.528 + 0.9856003 * days) % 360) * DEG;
  const eclLon =
    (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) *
    DEG;
  const obliquity = 23.439 * DEG;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclLon)) / DEG;
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const subsolarLon = ((-15 * (utcHours - 12) + 180) % 360 + 360) % 360 - 180;
  return { lat: declination, lon: subsolarLon };
}

function latLonToLocalVector(lat, lon, radius = 1) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return {
    x: -radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.sin(theta),
  };
}

const map = L.map("map", {
  zoomControl: true,
  worldCopyJump: true,
  attributionControl: true,
}).setView([0, 0], 2);

L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  subdomains: "abcd",
  maxZoom: 19,
}).addTo(map);

const issMarker = L.marker([0, 0], {
  icon: createMarkerIcon(0),
  keyboard: false,
  opacity: 1,
  zIndexOffset: 700,
}).addTo(map);

const issPulse = L.circle([0, 0], {
  radius: 1500000,
  color: "rgba(252, 60, 35, 0.35)",
  weight: 1,
  opacity: 0.5,
  fillColor: "rgba(252, 60, 35, 0.05)",
  fillOpacity: 1,
}).addTo(map);

const orbitRing = L.circle([0, 0], {
  radius: 19000000,
  color: "rgba(255, 255, 255, 0.08)",
  weight: 1,
  opacity: 0.3,
  fill: false,
  dashArray: "4 8",
}).addTo(map);

issMarker.bindPopup("Loading ISS telemetry...");

let lastRenderedHeading = 0;

function updateTrail(points) {
  updateTrail.layers = updateTrail.layers || [];
  updateTrail.layers.forEach((layer) => layer.remove());
  updateTrail.layers = [];

  if (points.length < 2) return;

  const segmentCount = Math.max(1, Math.min(6, points.length - 1));
  const step = Math.max(1, Math.floor(points.length / segmentCount));
  for (let i = 0; i < points.length - 1; i += step) {
    const start = points[i];
    const end = points[Math.min(i + 1, points.length - 1)];
    const opacity = Math.max(0.12, 0.8 - (i / points.length) * 0.65);
    updateTrail.layers.push(
      L.polyline([start, end], {
        color: "rgba(252, 60, 35, 0.35)",
        weight: 1.5,
        opacity,
        smoothFactor: 0.8,
        dashArray: "3 5",
      }).addTo(map),
    );
  }
}

function renderPosition(lat, lon, isNewFix) {
  const heading = calculateHeading(
    state.motion.from ? state.motion.from[0] : lat,
    state.motion.from ? state.motion.from[1] : lon,
    lat,
    lon,
  );
  if (Number.isFinite(heading) && !Number.isNaN(heading)) {
    lastRenderedHeading = heading;
  }

  const position = [lat, lon];
  issMarker.setLatLng(position);
  issPulse.setLatLng(position);
  orbitRing.setLatLng(position);

  if (isNewFix) {
    issMarker.setIcon(createMarkerIcon(lastRenderedHeading));
    issMarker.setPopupContent(
      `<b>ISS</b><br>${lat.toFixed(2)}° / ${lon.toFixed(2)}°<br>${new Date().toUTCString()}`,
    );

    state.trailPoints.push(position);
    if (state.trailPoints.length > CONFIG.MAX_TRAIL_POINTS) {
      state.trailPoints.shift();
    }
    updateTrail(state.trailPoints);

    if (state.autoCenter) {
      map.flyTo(position, Math.max(3, map.getZoom()), { duration: 1.1 });
    }
  }

  updateGlobeMarker(lat, lon);
  updateLiveReadouts(lat, lon, lastRenderedHeading);
}

function updateLiveReadouts(lat, lon, heading) {
  dom.lat.textContent = formatDegrees(lat);
  dom.lon.textContent = formatDegrees(lon);
  dom.heading.textContent = `${Math.round(heading)}°`;
}

const Globe = {
  supported: null,
  renderer: null,
  scene: null,
  camera: null,
  group: null,
  earthMesh: null,
  earthMaterial: null,
  cloudsMesh: null,
  issMesh: null,
  orbitRing: null,
  moonMesh: null,
  raycaster: null,
  pointerNDC: null,
  zero: null,
  animationFrame: null,
  resizeHandler: null,
  isDragging: false,
  lastInteraction: 0,
  pendingLatLon: null,
  clock: { last: 0 },
  cameraTransition: null, 
  sunLocal: { x: 1, y: 0, z: 0 },
};

function webglIsSupported() {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch {
    return false;
  }
}

const EARTH_VERTEX_SHADER = `
  varying vec2 vUv;
  varying vec3 vLocalNormal;
  void main() {
    vUv = uv;
    vLocalNormal = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EARTH_FRAGMENT_SHADER = `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D specularMap;
  uniform vec3 sunDirection;
  varying vec2 vUv;
  varying vec3 vLocalNormal;

  void main() {
    float ndl = dot(vLocalNormal, normalize(sunDirection));
    float dayMix = smoothstep(-0.12, 0.15, ndl);

    vec3 dayColor = texture2D(dayMap, vUv).rgb;
    vec3 nightColor = texture2D(nightMap, vUv).rgb * vec3(1.0, 0.85, 0.55) * 1.6;
    float ocean = 1.0 - texture2D(specularMap, vUv).r;

    vec3 color = mix(nightColor, dayColor, dayMix);

    float glint = pow(clamp(ndl, 0.0, 1.0), 6.0) * ocean * 0.25;
    color += vec3(glint);

    gl_FragColor = vec4(color, 1.0);
  }
`;

const ATMOSPHERE_VERTEX_SHADER = `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ATMOSPHERE_FRAGMENT_SHADER = `
  varying vec3 vNormal;
  void main() {
    float fresnel = pow(0.68 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
    gl_FragColor = vec4(0.35, 0.65, 1.0, clamp(fresnel, 0.0, 1.0) * 0.9);
  }
`;

function initGlobe() {
  if (Globe.supported === null) {
    Globe.supported = webglIsSupported() && !!window.THREE;
  }
  if (!Globe.supported) {
    dom.globeFallback.classList.remove("hidden");
    dom.globeModeBtn.disabled = true;
    dom.globeModeBtn.title = "3D globe requires WebGL";
    return;
  }
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
    Globe.renderer.domElement.style.width = "100%";
    Globe.renderer.domElement.style.height = "100%";
    dom.globeView.appendChild(Globe.renderer.domElement);

    Globe.group = new THREE.Group();
    Globe.scene.add(Globe.group);

    const ambient = new THREE.AmbientLight(0x8fa8d8, 0.35);
    Globe.scene.add(ambient);

    const textureLoader = new THREE.TextureLoader();
    textureLoader.crossOrigin = "anonymous";
    const base = CONFIG.GLOBE_TEXTURE_BASE;

    const placeholder = new THREE.DataTexture(
      new Uint8Array([70, 100, 140, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    placeholder.needsUpdate = true;

    Globe.earthMaterial = new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: placeholder },
        nightMap: { value: placeholder },
        specularMap: { value: placeholder },
        sunDirection: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: EARTH_VERTEX_SHADER,
      fragmentShader: EARTH_FRAGMENT_SHADER,
    });

    const earthGeometry = new THREE.SphereGeometry(1.25, 64, 64);
    Globe.earthMesh = new THREE.Mesh(earthGeometry, Globe.earthMaterial);
    Globe.group.add(Globe.earthMesh);

    const loadTexture = (file, uniformKey, colorSpace) => {
      textureLoader.load(
        `${base}${file}`,
        (texture) => {
          if (colorSpace) texture.colorSpace = colorSpace;
          Globe.earthMaterial.uniforms[uniformKey].value = texture;
        },
        undefined,
        () => {},
      );
    };
    loadTexture("earth_atmos_2048.jpg", "dayMap", THREE.SRGBColorSpace);
    loadTexture("earth_lights_2048.png", "nightMap", THREE.SRGBColorSpace);
    loadTexture("earth_specular_2048.jpg", "specularMap");

    const cloudsMaterial = new THREE.MeshLambertMaterial({
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    Globe.cloudsMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.27, 48, 48),
      cloudsMaterial,
    );
    Globe.group.add(Globe.cloudsMesh);
    textureLoader.load(
      `${base}earth_clouds_1024.png`,
      (texture) => {
        cloudsMaterial.map = texture;
        cloudsMaterial.needsUpdate = true;
      },
      undefined,
      () => {
        Globe.cloudsMesh.visible = false;
      },
    );

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.34, 48, 48),
      new THREE.ShaderMaterial({
        vertexShader: ATMOSPHERE_VERTEX_SHADER,
        fragmentShader: ATMOSPHERE_FRAGMENT_SHADER,
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    Globe.scene.add(atmosphere);

    const moonMaterial = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 1 });
    Globe.moonMesh = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 24), moonMaterial);
    Globe.moonMesh.position.set(3.2, 0.4, -1.6);
    Globe.scene.add(Globe.moonMesh);
    const moonLight = new THREE.DirectionalLight(0xffffff, 0.6);
    moonLight.position.copy(Globe.moonMesh.position);
    Globe.scene.add(moonLight);
    textureLoader.load(
      `${base}moon_1024.jpg`,
      (texture) => {
        moonMaterial.map = texture;
        moonMaterial.color.set(0xffffff);
        moonMaterial.needsUpdate = true;
      },
      undefined,
      () => {},
    );

    const starGeometry = new THREE.BufferGeometry();
    const starCount = 1400;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i += 1) {
      const i3 = i * 3;
      starPositions[i3] = (Math.random() - 0.5) * 24;
      starPositions[i3 + 1] = (Math.random() - 0.5) * 24;
      starPositions[i3 + 2] = (Math.random() - 0.5) * 24;
    }
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starField = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.028, sizeAttenuation: true }),
    );
    Globe.scene.add(starField);

    const orbitalPoints = [];
    for (let i = 0; i <= 360; i += 10) {
      const angle = i * DEG;
      orbitalPoints.push(
        new THREE.Vector3(Math.cos(angle) * 1.6, Math.sin(angle) * 0.34, Math.sin(angle) * 1.6),
      );
    }
    Globe.orbitRing = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(orbitalPoints),
      new THREE.LineBasicMaterial({ color: 0x68dfff, transparent: true, opacity: 0.75 }),
    );
    Globe.group.add(Globe.orbitRing);

    Globe.issMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 18, 18),
      new THREE.MeshBasicMaterial({ color: 0x7cf1ff }),
    );
    Globe.group.add(Globe.issMesh);

    if (Globe.pendingLatLon) {
      placeGlobeMarker(...Globe.pendingLatLon);
    }

    updateSunDirection(true);
    attachGlobeControls();

    Globe.lastInteraction = Date.now();
    runGlobeAnimation();

    Globe.resizeHandler = () => {
      const nextWidth = dom.globeView.clientWidth || 640;
      const nextHeight = dom.globeView.clientHeight || 420;
      Globe.camera.aspect = nextWidth / nextHeight;
      Globe.camera.updateProjectionMatrix();
      Globe.renderer.setSize(nextWidth, nextHeight);
    };
    window.addEventListener("resize", Globe.resizeHandler);
  } catch (error) {
    console.error("Globe initialization failed:", error);
    dom.globeFallback.classList.remove("hidden");
    dom.globeFallback.querySelector("p").textContent =
      "The 3D globe couldn't start. The 2D map keeps working normally.";
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
  const animate = (timestamp) => {
    const dt = Globe.clock.last ? (timestamp - Globe.clock.last) / 1000 : 0.016;
    Globe.clock.last = timestamp;

    if (Globe.renderer && Globe.scene && Globe.camera && Globe.group) {
      const idle = !Globe.isDragging && Date.now() - Globe.lastInteraction > 1800;
      if (idle && state.cameraMode === "free") {
        Globe.group.rotation.y += 0.14 * dt;
      }
      if (Globe.cloudsMesh) {
        Globe.cloudsMesh.rotation.y += 0.02 * dt;
      }
      if (Globe.moonMesh) {
        const t = timestamp * 0.00003;
        Globe.moonMesh.position.set(Math.cos(t) * 3.2, 0.4, Math.sin(t) * 3.2);
      }

      updateSunDirection(false);
      stepCameraTransition(timestamp);
      applyCameraMode(dt);

      Globe.renderer.render(Globe.scene, Globe.camera);
      updateDebugRenderStats();
    }
    Globe.animationFrame = requestAnimationFrame(animate);
  };
  Globe.animationFrame = requestAnimationFrame(animate);
}

function beginCameraTransition(toPos, toTarget, durationMs = 900) {
  Globe.cameraTransition = {
    fromPos: Globe.camera.position.clone(),
    toPos,
    fromTarget: Globe.cameraTransition ? Globe.cameraTransition.toTarget.clone() : Globe.zero.clone(),
    toTarget,
    start: performance.now(),
    duration: durationMs,
  };
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
  if (state.cameraMode === "top" && !Globe.cameraTransition) {
    Globe.camera.up.set(0, 0, -1);
    Globe.camera.position.lerp(new THREE.Vector3(0, 4.2, 0.001), 0.06);
    Globe.camera.lookAt(0, 0, 0);
  } else if (state.cameraMode === "follow" && Globe.issMesh) {
    Globe.camera.up.set(0, 1, 0);
    if (!Globe.isDragging) {
      const issWorld = new THREE.Vector3();
      Globe.issMesh.getWorldPosition(issWorld);
      const desired = issWorld.clone().normalize().multiplyScalar(3.2);
      Globe.camera.position.lerp(desired, 0.03);
      Globe.camera.lookAt(0, 0, 0);
    }
  } else if (state.cameraMode === "free") {
    Globe.camera.up.set(0, 1, 0);
  }
}

function setCameraMode(mode) {
  state.cameraMode = mode;
  Settings.set("cameraMode", mode);
  [dom.camFreeBtn, dom.camFollowBtn, dom.camTopBtn].forEach((btn) => {
    if (btn) btn.classList.toggle("is-active", btn.dataset.mode === mode);
  });
  if (!Globe.camera) return;
  if (mode === "top") {
    beginCameraTransition(new THREE.Vector3(0, 4.2, 0.001), Globe.zero.clone());
  } else if (mode === "free") {
    Globe.camera.up.set(0, 1, 0);
    beginCameraTransition(new THREE.Vector3(0, 0, 4.4), Globe.zero.clone());
  }
}

function raycastGlobePoint(clientX, clientY) {
  if (!Globe.earthMesh || !Globe.raycaster) return null;
  const rect = Globe.renderer.domElement.getBoundingClientRect();
  Globe.pointerNDC.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  Globe.earthMesh.updateMatrixWorld();
  Globe.raycaster.setFromCamera(Globe.pointerNDC, Globe.camera);
  const hits = Globe.raycaster.intersectObject(Globe.earthMesh, false);
  return hits.length ? hits[0].point : null;
}

function zoomGlobeBy(deltaDistance, targetPoint) {
  const center = Globe.zero;
  const currentDistance = Globe.camera.position.distanceTo(center);
  const nextDistance = clamp(
    currentDistance + deltaDistance,
    CONFIG.GLOBE_MIN_ZOOM,
    CONFIG.GLOBE_MAX_ZOOM,
  );
  const actualDelta = nextDistance - currentDistance;
  if (actualDelta === 0) return;

  const aimPoint = targetPoint || center;
  const towardAim = aimPoint.clone().sub(Globe.camera.position).normalize();
  Globe.camera.position.addScaledVector(towardAim, -actualDelta);
  Globe.camera.lookAt(center);
}

function attachGlobeControls() {
  const el = Globe.renderer.domElement;
  let dragStartX = 0;
  let dragStartY = 0;
  let rotationStartX = 0;
  let rotationStartY = 0;
  const activePointers = new Map();
  let pinchStartDistance = 0;

  const markInteraction = () => {
    Globe.lastInteraction = Date.now();
    if (dom.globeHint) dom.globeHint.classList.add("is-hidden");
    if (state.cameraMode !== "free") setCameraMode("free");
  };

  const pinchMidpoint = () => {
    const points = [...activePointers.values()];
    return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  };
  const pinchDistance = () => {
    const points = [...activePointers.values()];
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  };

  el.addEventListener("pointerdown", (event) => {
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    el.setPointerCapture(event.pointerId);
    Globe.lastInteraction = Date.now();
    if (dom.globeHint) dom.globeHint.classList.add("is-hidden");

    if (activePointers.size === 2) {
      Globe.isDragging = false;
      pinchStartDistance = pinchDistance();
    } else if (activePointers.size === 1) {
      Globe.isDragging = true;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      rotationStartX = Globe.group.rotation.x;
      rotationStartY = Globe.group.rotation.y;
    }
  });

  el.addEventListener("pointermove", (event) => {
    if (!activePointers.has(event.pointerId)) return;
    Globe.lastInteraction = Date.now();
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointers.size === 2) {
      const distance = pinchDistance();
      const delta = distance - pinchStartDistance;
      pinchStartDistance = distance;
      const midpoint = pinchMidpoint();
      zoomGlobeBy(-delta * 0.012, raycastGlobePoint(midpoint.x, midpoint.y));
      return;
    }

    if (!Globe.isDragging) return;
    if (state.cameraMode !== "free") setCameraMode("free");
    const deltaX = event.clientX - dragStartX;
    const deltaY = event.clientY - dragStartY;
    Globe.group.rotation.y = rotationStartY + deltaX * 0.0055;
    Globe.group.rotation.x = clamp(rotationStartX + deltaY * 0.0055, -1.2, 1.2);
  });

  ["pointerup", "pointercancel", "pointerleave"].forEach((eventName) => {
    el.addEventListener(eventName, (event) => {
      activePointers.delete(event.pointerId);
      if (activePointers.size < 2) pinchStartDistance = 0;
      if (activePointers.size === 0) Globe.isDragging = false;
    });
  });

  el.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      markInteraction();
      zoomGlobeBy(event.deltaY * 0.0025, raycastGlobePoint(event.clientX, event.clientY));
    },
    { passive: false },
  );

  dom.globeZoomInBtn.addEventListener("click", () => {
    Globe.lastInteraction = Date.now();
    zoomGlobeBy(-CONFIG.GLOBE_ZOOM_STEP, null);
  });
  dom.globeZoomOutBtn.addEventListener("click", () => {
    Globe.lastInteraction = Date.now();
    zoomGlobeBy(CONFIG.GLOBE_ZOOM_STEP, null);
  });

  if (dom.cameraModeSwitcher) {
    dom.cameraModeSwitcher.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-mode]");
      if (btn) setCameraMode(btn.dataset.mode);
    });
  }
}

function placeGlobeMarker(lat, lon) {
  const v = latLonToLocalVector(lat, lon, 1.3);
  if (Globe.issMesh) Globe.issMesh.position.set(v.x, v.y, v.z);
}

function updateGlobeMarker(lat, lon) {
  Globe.pendingLatLon = [lat, lon];
  if (!Globe.issMesh) return;
  placeGlobeMarker(lat, lon);
}

function updateDebugRenderStats() {
  if (!Settings.data.debug || !Globe.renderer) return;
  const info = Globe.renderer.info;
  dom.dbgDrawCalls.textContent = info.render.calls;
  dom.dbgTriangles.textContent = info.render.triangles.toLocaleString();
  const memMB = (info.memory.geometries + info.memory.textures) * 2.5;
  dom.dbgGpuMem.textContent = `~${memMB.toFixed(0)} MB (est.)`;
}

function setViewMode(mode) {
  if (mode === "globe" && Globe.supported === false) mode = "map";
  state.currentView = mode;
  Settings.set("viewMode", mode);
  const isMap = mode === "map";
  dom.mapModeBtn.classList.toggle("is-active", isMap);
  dom.globeModeBtn.classList.toggle("is-active", !isMap);
  map.getContainer().style.display = isMap ? "block" : "none";
  dom.globeView.classList.toggle("hidden", isMap);
  dom.globeView.style.display = isMap ? "none" : "grid";

  if (isMap) {
    if (Globe.animationFrame) {
      cancelAnimationFrame(Globe.animationFrame);
      Globe.animationFrame = null;
    }
    return;
  }

  if (!Globe.renderer && Globe.supported !== false) {
    initGlobe();
  } else if (!Globe.animationFrame && Globe.supported) {
    Globe.lastInteraction = Date.now();
    runGlobeAnimation();
  }

  if (state.motion.current) {
    updateGlobeMarker(state.motion.current[0], state.motion.current[1]);
  }
}

function beginMotionTransition(nextLat, nextLon) {
  const previous = state.motion.current;
  state.motion.from = previous || [nextLat, nextLon];
  state.motion.to = [nextLat, nextLon];
  state.motion.startedAt = performance.now();
  state.motion.durationMs = CONFIG.UPDATE_INTERVAL_MS;
}

function runMotionLoop(timestamp) {
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
      f,
    );
    state.motion.current = [lat, lon];
    renderPosition(lat, lon, f >= 1 && !runMotionLoop.settled);
    runMotionLoop.settled = f >= 1;
  }

  updateDebugOverlay();
  requestAnimationFrame(runMotionLoop);
}

function updatePassPrediction(latitude, longitude, velocity) {
  const activeLocation = state.userLocation ?? state.passLocation;
  const distanceToLocation = calculateDistance(
    latitude,
    longitude,
    activeLocation.lat,
    activeLocation.lon,
  );
  const passInMinutes = Math.max(2, Math.round((distanceToLocation / Math.max(velocity, 1)) * 60));
  const durationSeconds = Math.max(180, Math.round(210 + (Math.abs(longitude) % 40) * 2));
  const elevation = Math.min(85, Math.round(38 + (Math.abs(latitude) % 24) + (Math.abs(velocity) % 14)));

  dom.passLocation.textContent = getLocationLabel(activeLocation);
  dom.visibleIn.textContent = `${passInMinutes} minutes (estimated)`;
  dom.passDuration.textContent = `${Math.floor(durationSeconds / 60)} min ${durationSeconds % 60} sec`;
  dom.maxElevation.textContent = `${elevation}°`;
}

function updateTelemetry(lat, lon, altitude, velocity) {
  const now = new Date();
  const speed = Number.isFinite(velocity) && velocity > 0 ? velocity : state.lastVelocity ?? 27600;
  const computedAltitude = Number.isFinite(altitude) && altitude > 0 ? altitude : 408;
  const orbitNumber = Math.round(118900 + state.updateCount * 1.7);
  const orbitalPeriod = 92.7;

  dom.altitude.textContent = formatKm(computedAltitude);
  dom.altitudeOrbit.textContent = formatKm(computedAltitude);
  dom.velocity.textContent = `${Math.round(speed).toLocaleString()} km/h`;
  dom.speed.textContent = `${(speed / 3600).toFixed(2)} km/s`;
  dom.orbitNumber.textContent = orbitNumber.toLocaleString();
  dom.orbitalPeriod.textContent = `${orbitalPeriod.toFixed(1)} minutes`;
  dom.packets.textContent = String(state.updateCount).padStart(3, "0");
  dom.lastPacket.textContent = formatUTC(now);
  dom.latency.textContent = state.net.lastLatencyMs != null ? `${state.net.lastLatencyMs} ms` : "--";

  dom.updated.textContent = `Last Update: ${now.toLocaleTimeString()}`;
  dom.hudAltitude.textContent = `ALT ${Math.round(computedAltitude)}km`;
  dom.hudSpeed.textContent = `VEL ${(speed / 3600).toFixed(2)}km/s`;
  dom.hudOrbit.textContent = `ORBIT ${orbitNumber.toLocaleString()}`;
  dom.hudTime.textContent = `UTC ${now.toISOString().slice(11, 19)}`;
  dom.hudStatus.textContent = state.net.usingCachedData ? "STATUS CACHED" : "STATUS LIVE";
  dom.telemetryStatus.textContent = state.net.usingCachedData
    ? "Showing last known telemetry..."
    : "Receiving telemetry...";

  updatePassPrediction(lat, lon, speed);
}

async function getCurrentBrowserLocation() {
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
    { enableHighAccuracy: false, timeout: 7000, maximumAge: 60000 },
  );
}

async function resolveLocationFallback() {
  try {
    const response = await fetch(CONFIG.IP_GEO_API, { cache: "no-store" });
    if (!response.ok) throw new Error("IP geolocation unavailable");
    const data = await response.json();
    if (Number.isFinite(data.latitude) && Number.isFinite(data.longitude)) {
      state.userLocation = { lat: Number(data.latitude), lon: Number(data.longitude) };
      state.passLocation = state.userLocation;
      dom.passLocation.textContent = getLocationLabel(state.passLocation);
      return;
    }
  } catch (error) {
    console.warn("Falling back to default pass location:", error);
  }
  state.passLocation = CONFIG.DEFAULT_PASS_LOCATION;
  dom.passLocation.textContent = getLocationLabel(state.passLocation);
}

function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = CONFIG.MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options);
      if (response.status === 429) {
        throw Object.assign(new Error("Rate limited"), { rateLimited: true });
      }
      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }
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

function setConnectionUI(statusText, colorVar, indicatorColor) {
  dom.connection.textContent = statusText;
  if (dom.indicator) dom.indicator.style.backgroundColor = indicatorColor;
}

function showOfflineBanner(show, text) {
  if (!dom.offlineBanner) return;
  dom.offlineBanner.classList.toggle("hidden", !show);
  if (text) dom.offlineBannerText.textContent = text;
}

async function getISS() {
  dom.updated.classList.add("loading");
  setConnectionUI("Syncing...", null, "#fc3c23");
  dom.telemetryStatus.textContent = "Syncing telemetry...";

  const requestStart = performance.now();
  try {
    const response = await fetchWithRetry(CONFIG.ISS_API, { cache: "no-store" });
    const data = await response.json();
    state.net.lastLatencyMs = Math.round(performance.now() - requestStart);

    const latitude = Number(data.latitude ?? data.iss_position?.latitude);
    const longitude = Number(data.longitude ?? data.iss_position?.longitude);
    const velocity = Number(data.velocity ?? data.speed ?? data.iss_position?.velocity);
    const altitude = Number(data.altitude ?? data.iss_position?.altitude ?? 408);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("Invalid ISS coordinates returned by API");
    }

    state.net.consecutiveFailures = 0;
    state.net.usingCachedData = false;
    showOfflineBanner(false);

    beginMotionTransition(latitude, longitude);
    state.lastVelocity = Number.isFinite(velocity) && velocity > 0 ? velocity : state.lastVelocity;
    state.updateCount += 1;

    animateValue(dom.lat);
    animateValue(dom.lon);
    animateValue(dom.speed);
    animateValue(dom.packets);
    updateTelemetry(latitude, longitude, altitude, state.lastVelocity ?? velocity);

    document.body.classList.remove("initializing");

    Cache.write({
      latitude,
      longitude,
      velocity: state.lastVelocity,
      altitude,
      savedAt: Date.now(),
    });

    setConnectionUI("Connected", null, "#ba1e68");
    dom.telemetryStatus.textContent = "Receiving telemetry...";

    const statusCard = document.querySelector(".selected");
    if (statusCard) {
      statusCard.classList.add("u--packet-received");
      setTimeout(() => statusCard.classList.remove("u--packet-received"), 600);
    }
  } catch (error) {
    state.net.consecutiveFailures += 1;
    console.error("Error fetching ISS data:", error);

    const cached = Cache.read();
    if (cached && state.net.consecutiveFailures <= 6) {
      state.net.usingCachedData = true;
      beginMotionTransition(cached.latitude, cached.longitude);
      updateTelemetry(cached.latitude, cached.longitude, cached.altitude, cached.velocity);
      const ageMin = Math.max(1, Math.round((Date.now() - cached.savedAt) / 60000));
      showOfflineBanner(true, `Connection lost. Showing telemetry from ${ageMin} min ago.`);
      setConnectionUI("Reconnecting...", null, "#8a1e40");
    } else {
      showOfflineBanner(true, "Connection lost and no cached telemetry is available.");
      setConnectionUI("Disconnected", null, "#555555");
    }
    dom.telemetryStatus.textContent = "Telemetry lost";
  } finally {
    scheduleNextPoll();
  }
}

function scheduleNextPoll() {
  if (state.net.pollTimer) clearTimeout(state.net.pollTimer);
  const failures = state.net.consecutiveFailures;
  const delay = failures > 0
    ? Math.min(CONFIG.UPDATE_INTERVAL_MS * 2 ** Math.min(failures, 4), CONFIG.MAX_BACKOFF_MS)
    : CONFIG.UPDATE_INTERVAL_MS;
  state.net.pollTimer = setTimeout(getISS, delay);
  if (dom.dbgUpdateFreq) dom.dbgUpdateFreq.textContent = `${(delay / 1000).toFixed(1)}s`;
}

window.addEventListener("online", () => {
  state.net.online = true;
  getISS();
});
window.addEventListener("offline", () => {
  state.net.online = false;
  showOfflineBanner(true, "Your device is offline. Showing last known telemetry.");
  setConnectionUI("Offline", null, "#555555");
});

function updateDebugOverlay() {
  if (!Settings.data.debug) return;
  dom.dbgFps.textContent = Math.round(state.debug.fps);
  dom.dbgFrameTime.textContent = `${state.debug.frameTimeMs.toFixed(1)} ms`;
  dom.dbgLatency.textContent = state.net.lastLatencyMs != null ? `${state.net.lastLatencyMs} ms` : "--";
}

function setDebugMode(enabled) {
  Settings.set("debug", enabled);
  dom.debugOverlay.classList.toggle("hidden", !enabled);
}

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "d" && !event.metaKey && !event.ctrlKey) {
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
    setDebugMode(!Settings.data.debug);
  }
});

dom.cards.forEach((card) => {
  card.addEventListener("pointerenter", () => card.classList.add("is-active"));
  card.addEventListener("pointerleave", () => card.classList.remove("is-active"));
});

dom.followBtn.addEventListener("click", () => {
  state.autoCenter = !state.autoCenter;
  Settings.set("autoCenter", state.autoCenter);
  dom.followBtn.textContent = state.autoCenter ? "Pause Follow" : "Follow ISS";
  if (state.autoCenter && state.motion.current) {
    map.flyTo(state.motion.current, Math.max(3, map.getZoom()), { duration: 1.1 });
  }
});

dom.zoomISSBtn.addEventListener("click", () => {
  state.autoCenter = true;
  Settings.set("autoCenter", true);
  dom.followBtn.textContent = "Pause Follow";
  if (state.motion.current) {
    map.flyTo(state.motion.current, 4, { duration: 1.4 });
  }
});

dom.resetBtn.addEventListener("click", () => {
  state.autoCenter = true;
  Settings.set("autoCenter", true);
  dom.followBtn.textContent = "Pause Follow";
  map.setView([0, 0], 2);
});

dom.mapModeBtn.addEventListener("click", () => setViewMode("map"));
dom.globeModeBtn.addEventListener("click", () => setViewMode("globe"));

function init() {
  document.body.classList.add("initializing");
  const saved = Settings.load();
  state.autoCenter = saved.autoCenter;
  state.cameraMode = saved.cameraMode;
  dom.followBtn.textContent = state.autoCenter ? "Pause Follow" : "Follow ISS";
  [dom.camFreeBtn, dom.camFollowBtn, dom.camTopBtn].forEach((btn) => {
    if (btn) btn.classList.toggle("is-active", btn.dataset.mode === state.cameraMode);
  });
  if (saved.debug) setDebugMode(true);

  getCurrentBrowserLocation();
  setViewMode(saved.viewMode === "globe" ? "globe" : "map");
  getISS();
  requestAnimationFrame(runMotionLoop);
}

dom.camFreeBtn = document.getElementById("camFreeBtn");
dom.camFollowBtn = document.getElementById("camFollowBtn");
dom.camTopBtn = document.getElementById("camTopBtn");

init();
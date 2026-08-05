import { CONFIG } from './config.js';
import { state, Settings } from './state.js';
import { dom } from './dom.js';
import { clamp, easeInOutQuad, getSubsolarPoint, latLonToLocalVector } from './utils.js';

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
  motionDir: null,
  predictedLine: null
};

function webglIsSupported() {
  try {
    const canvas = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
  } catch {
    return false;
  }
}

export function initGlobe() {
  if (Globe.supported === null) Globe.supported = webglIsSupported() && !!window.THREE;
  if (!Globe.supported) {
    dom.globeFallback.classList.remove('hidden');
    dom.globeModeBtn.disabled = true;
    dom.globeModeBtn.title = '3D globe requires WebGL';
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
      uniforms: {
        dayMap: { value: placeholder },
        nightMap: { value: placeholder },
        specularMap: { value: placeholder },
        sunDirection: { value: new THREE.Vector3(1, 0, 0) }
      },
      vertexShader: EARTH_VERTEX_SHADER,
      fragmentShader: EARTH_FRAGMENT_SHADER
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
        () => {}
      );
    };
    loadTexture('earth_atmos_2048.jpg', 'dayMap', THREE.SRGBColorSpace);
    loadTexture('earth_lights_2048.png', 'nightMap', THREE.SRGBColorSpace);
    loadTexture('earth_specular_2048.jpg', 'specularMap');

    const cloudsMaterial = new THREE.MeshLambertMaterial({
      transparent: true,
      opacity: 0.28,
      depthWrite: false
    });
    Globe.cloudsMesh = new THREE.Mesh(new THREE.SphereGeometry(1.27, 48, 48), cloudsMaterial);
    Globe.group.add(Globe.cloudsMesh);
    textureLoader.load(
      `${base}earth_clouds_1024.png`,
      (texture) => {
        cloudsMaterial.map = texture;
        cloudsMaterial.needsUpdate = true;
      },
      undefined,
      () => { Globe.cloudsMesh.visible = false; }
    );

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.34, 48, 48),
      new THREE.ShaderMaterial({
        vertexShader: ATMOSPHERE_VERTEX_SHADER,
        fragmentShader: ATMOSPHERE_FRAGMENT_SHADER,
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending
      })
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
      () => {}
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
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starField = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.028, sizeAttenuation: true })
    );
    Globe.scene.add(starField);

    const orbitalPoints = [];
    for (let i = 0; i <= 360; i += 10) {
      const angle = i * DEG;
      orbitalPoints.push(new THREE.Vector3(Math.cos(angle) * 1.6, Math.sin(angle) * 0.34, Math.sin(angle) * 1.6));
    }
    Globe.orbitRing = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(orbitalPoints),
      new THREE.LineBasicMaterial({ color: 0x68dfff, transparent: true, opacity: 0.75 })
    );
    Globe.group.add(Globe.orbitRing);

    Globe.issMesh = buildIssModel();
    Globe.issMesh.scale.setScalar(0.6);
    Globe.group.add(Globe.issMesh);

    if (Globe.pendingLatLon) placeGlobeMarker(...Globe.pendingLatLon);

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
    window.addEventListener('resize', Globe.resizeHandler);
  } catch (error) {
    console.error('Globe initialization failed:', error);
    dom.globeFallback.classList.remove('hidden');
    dom.globeFallback.querySelector('p').textContent = 'The 3D globe couldn\'t start. The 2D map keeps working normally.';
    Globe.supported = false;
  }

  return Globe;
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
      if (idle && state.cameraMode === 'free') Globe.group.rotation.y += 0.14 * dt;
      if (Globe.cloudsMesh) Globe.cloudsMesh.rotation.y += 0.02 * dt;
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
    duration: durationMs
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
  if (state.cameraMode === 'top' && !Globe.cameraTransition) {
    Globe.camera.up.set(0, 0, -1);
    Globe.camera.position.lerp(new THREE.Vector3(0, 4.2, 0.001), 0.06);
    Globe.camera.lookAt(0, 0, 0);
  } else if (state.cameraMode === 'follow' && Globe.issMesh) {
    Globe.camera.up.set(0, 1, 0);
    if (!Globe.isDragging) {
      const issWorld = new THREE.Vector3();
      Globe.issMesh.getWorldPosition(issWorld);
      const desired = issWorld.clone().normalize().multiplyScalar(3.2);
      Globe.camera.position.lerp(desired, 0.03);
      Globe.camera.lookAt(0, 0, 0);
    }
  } else if (state.cameraMode === 'free') {
    Globe.camera.up.set(0, 1, 0);
  }
}

export function setCameraMode(mode) {
  state.cameraMode = mode;
  Settings.set('cameraMode', mode);
  [dom.camFreeBtn, dom.camFollowBtn, dom.camTopBtn].forEach((btn) => {
    if (btn) btn.classList.toggle('is-active', btn.dataset.mode === mode);
  });
  if (!Globe.camera) return;
  if (mode === 'top') {
    beginCameraTransition(new THREE.Vector3(0, 4.2, 0.001), Globe.zero.clone());
  } else if (mode === 'free') {
    Globe.camera.up.set(0, 1, 0);
    beginCameraTransition(new THREE.Vector3(0, 0, 4.4), Globe.zero.clone());
  }
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
    if (dom.globeHint) dom.globeHint.classList.add('is-hidden');
    if (state.cameraMode !== 'free') setCameraMode('free');
  };

  const pinchMidpoint = () => {
    const points = [...activePointers.values()];
    return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  };
  const pinchDistance = () => {
    const points = [...activePointers.values()];
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  };

  el.addEventListener('pointerdown', (event) => {
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    el.setPointerCapture(event.pointerId);
    Globe.lastInteraction = Date.now();
    if (dom.globeHint) dom.globeHint.classList.add('is-hidden');
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

  el.addEventListener('pointermove', (event) => {
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
    if (state.cameraMode !== 'free') setCameraMode('free');
    const deltaX = event.clientX - dragStartX;
    const deltaY = event.clientY - dragStartY;
    Globe.group.rotation.y = rotationStartY + deltaX * 0.0055;
    Globe.group.rotation.x = clamp(rotationStartX + deltaY * 0.0055, -1.2, 1.2);
  });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
    el.addEventListener(eventName, (event) => {
      activePointers.delete(event.pointerId);
      if (activePointers.size < 2) pinchStartDistance = 0;
      if (activePointers.size === 0) Globe.isDragging = false;
    });
  });

  el.addEventListener('wheel', (event) => {
    event.preventDefault();
    markInteraction();
    zoomGlobeBy(event.deltaY * 0.0025, raycastGlobePoint(event.clientX, event.clientY));
  }, { passive: false });

  dom.globeZoomInBtn.addEventListener('click', () => {
    Globe.lastInteraction = Date.now();
    zoomGlobeBy(-CONFIG.GLOBE_ZOOM_STEP, null);
  });
  dom.globeZoomOutBtn.addEventListener('click', () => {
    Globe.lastInteraction = Date.now();
    zoomGlobeBy(CONFIG.GLOBE_ZOOM_STEP, null);
  });

  if (dom.cameraModeSwitcher) {
    dom.cameraModeSwitcher.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-mode]');
      if (btn) setCameraMode(btn.dataset.mode);
    });
  }
}

function raycastGlobePoint(clientX, clientY) {
  if (!Globe.earthMesh || !Globe.raycaster) return null;
  const rect = Globe.renderer.domElement.getBoundingClientRect();
  Globe.pointerNDC.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  Globe.earthMesh.updateMatrixWorld();
  Globe.raycaster.setFromCamera(Globe.pointerNDC, Globe.camera);
  const hits = Globe.raycaster.intersectObject(Globe.earthMesh, false);
  return hits.length ? hits[0].point : null;
}

function zoomGlobeBy(deltaDistance, targetPoint) {
  const center = Globe.zero;
  const currentDistance = Globe.camera.position.distanceTo(center);
  const nextDistance = clamp(currentDistance + deltaDistance, CONFIG.GLOBE_MIN_ZOOM, CONFIG.GLOBE_MAX_ZOOM);
  const actualDelta = nextDistance - currentDistance;
  if (actualDelta === 0) return;
  const aimPoint = targetPoint || center;
  const towardAim = aimPoint.clone().sub(Globe.camera.position).normalize();
  Globe.camera.position.addScaledVector(towardAim, -actualDelta);
  Globe.camera.lookAt(center);
}

function buildIssModel() {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshBasicMaterial({ color: 0xd8e0ea });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.03, 0.075), bodyMat);
  group.add(body);

  const panelMat = new THREE.MeshBasicMaterial({ color: 0x2a6cd8, side: THREE.DoubleSide });
  const panelGeo = new THREE.BoxGeometry(0.13, 0.002, 0.055);
  const panelL = new THREE.Mesh(panelGeo, panelMat);
  panelL.position.x = -0.082;
  const panelR = new THREE.Mesh(panelGeo, panelMat);
  panelR.position.x = 0.082;
  group.add(panelL, panelR);

  const armMat = new THREE.MeshBasicMaterial({ color: 0x94a3b8 });
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.003, 0.003), armMat);
  group.add(arm);

  const tipMat = new THREE.MeshBasicMaterial({ color: 0xfc3c23 });
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), tipMat);
  tip.position.z = 0.05;
  group.add(tip);

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

export function updateGlobeMarker(lat, lon) {
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

export function updateGlobePredictedPath(points) {
  if (!points || points.length < 2) return;
  const vecs = points.map(([lat, lon]) => {
    const v = latLonToLocalVector(lat, lon, 1.3);
    return new THREE.Vector3(v.x, v.y, v.z);
  });
  if (!Globe.predictedLine) {
    Globe.predictedLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x68dfff, transparent: true, opacity: 0.65 })
    );
    Globe.group.add(Globe.predictedLine);
  }
  Globe.predictedLine.geometry.dispose();
  Globe.predictedLine.geometry = new THREE.BufferGeometry().setFromPoints(vecs);
}

function updateDebugRenderStats() {
  if (!Settings.data.debug || !Globe.renderer) return;
  const info = Globe.renderer.info;
  dom.dbgDrawCalls.textContent = info.render.calls;
  dom.dbgTriangles.textContent = info.render.triangles.toLocaleString();
  const memMB = (info.memory.geometries + info.memory.textures) * 2.5;
  dom.dbgGpuMem.textContent = `~${memMB.toFixed(0)} MB (est.)`;
}

export function setViewMode(mode, mapInstance) {
  if (mode === 'globe' && Globe.supported === false) mode = 'map';
  state.currentView = mode;
  Settings.set('viewMode', mode);
  const isMap = mode === 'map';
  dom.mapModeBtn.classList.toggle('is-active', isMap);
  dom.globeModeBtn.classList.toggle('is-active', !isMap);
  mapInstance.getContainer().style.display = isMap ? 'block' : 'none';
  dom.globeView.classList.toggle('hidden', isMap);
  dom.globeView.style.display = isMap ? 'none' : 'grid';

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

  if (state.motion.current) updateGlobeMarker(state.motion.current[0], state.motion.current[1]);
}

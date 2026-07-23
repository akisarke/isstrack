// Mission dashboard configuration
const UPDATE_INTERVAL_MS = 5000;
const MAX_TRAIL_POINTS = 40;
const DEFAULT_PASS_LOCATION = { lat: 44.62, lon: 21.18 };

let updateCount = 0;
let lastPosition = null;
let lastTimestamp = null;
let lastVelocity = null;
let totalDistance = 0;
let autoCenter = true;
let currentView = "map";
let trailPoints = [];
let trailLayers = [];
let userLocation = null;
let passLocation = DEFAULT_PASS_LOCATION;
let globeRenderer = null;
let globeScene = null;
let globeCamera = null;
let globeEarth = null;
let globeIssMarker = null;
let globeOrbitRing = null;
let globeAnimationFrame = null;

const map = L.map("map", {
    zoomControl: true,
    worldCopyJump: true,
    attributionControl: true
}).setView([0, 0], 2);

L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    {
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        subdomains: "abcd",
        maxZoom: 19
    }
).addTo(map);

const issMarker = L.marker([0, 0], {
    icon: createMarkerIcon(0),
    keyboard: false,
    opacity: 1,
    zIndexOffset: 700
}).addTo(map);

const issPulse = L.circle([0, 0], {
    radius: 1500000,
    color: "#69d8ff",
    weight: 1.5,
    opacity: 0.8,
    fillColor: "#69d8ff",
    fillOpacity: 0.09
}).addTo(map);

const orbitRing = L.circle([0, 0], {
    radius: 19000000,
    color: "#64b8ff",
    weight: 2,
    opacity: 0.4,
    fill: false,
    dashArray: "6 6"
}).addTo(map);

issMarker.bindPopup("Loading ISS telemetry...");

const latElement = document.getElementById("lat");
const lonElement = document.getElementById("lon");
const altitudeElement = document.getElementById("altitude");
const altitudeOrbitElement = document.getElementById("altitudeOrbit");
const velocityElement = document.getElementById("velocity");
const speedElement = document.getElementById("speed");
const headingElement = document.getElementById("heading");
const orbitNumberElement = document.getElementById("orbitNumber");
const orbitalPeriodElement = document.getElementById("orbitalPeriod");
const packetsElement = document.getElementById("updates");
const connectionElement = document.getElementById("connection");
const telemetryStatusElement = document.getElementById("telemetryStatus");
const updatedElement = document.getElementById("lastUpdated");
const hudAltitudeElement = document.getElementById("hudAltitude");
const hudSpeedElement = document.getElementById("hudSpeed");
const hudOrbitElement = document.getElementById("hudOrbit");
const hudTimeElement = document.getElementById("hudTime");
const hudStatusElement = document.getElementById("hudStatus");
const lastPacketElement = document.getElementById("lastPacket");
const latencyElement = document.getElementById("latency");
const visibleInElement = document.getElementById("visibleIn");
const passDurationElement = document.getElementById("passDuration");
const maxElevationElement = document.getElementById("maxElevation");
const passLocationElement = document.getElementById("passLocation");
const followBtn = document.getElementById("followBtn");
const zoomISSBtn = document.getElementById("zoomISSBtn");
const resetBtn = document.getElementById("resetBtn");
const mapModeBtn = document.getElementById("mapModeBtn");
const globeModeBtn = document.getElementById("globeModeBtn");
const globeView = document.getElementById("globeView");
const globeMarker = document.getElementById("globeMarker");
const cards = document.querySelectorAll(".card");

function animateValue(element) {
    element.classList.remove("loading");
    void element.offsetWidth;
    element.classList.add("loading");
}

function createMarkerIcon(angle) {
    return L.divIcon({
        className: "iss-marker",
        html: `
            <div class="satellite-arrow" style="transform: translateY(-20px) rotate(${angle}deg);"></div>
            <div class="satellite-core"></div>
        `,
        iconSize: [54, 54],
        iconAnchor: [27, 27]
    });
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function calculateHeading(lat1, lon1, lat2, lon2) {
    const lat1Rad = (lat1 * Math.PI) / 180;
    const lat2Rad = (lat2 * Math.PI) / 180;
    const lonDiff = ((lon2 - lon1) * Math.PI) / 180;

    const y = Math.sin(lonDiff) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(lonDiff);
    const heading = (Math.atan2(y, x) * 180) / Math.PI;
    return (heading + 360) % 360;
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
    if (!location) {
        return "Locating...";
    }

    return `${location.lat.toFixed(3)}°, ${location.lon.toFixed(3)}°`;
}

async function getCurrentBrowserLocation() {
    if (!navigator.geolocation) {
        await resolveLocationFallback();
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            userLocation = {
                lat: position.coords.latitude,
                lon: position.coords.longitude
            };
            passLocation = userLocation;
            passLocationElement.textContent = getLocationLabel(passLocation);
        },
        async () => {
            await resolveLocationFallback();
        },
        {
            enableHighAccuracy: false,
            timeout: 7000,
            maximumAge: 60000
        }
    );
}

async function resolveLocationFallback() {
    try {
        const response = await fetch("https://ipapi.co/json/", {
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error("IP geolocation unavailable");
        }

        const data = await response.json();
        if (Number.isFinite(data.latitude) && Number.isFinite(data.longitude)) {
            userLocation = {
                lat: Number(data.latitude),
                lon: Number(data.longitude)
            };
            passLocation = userLocation;
            passLocationElement.textContent = getLocationLabel(passLocation);
            return;
        }
    } catch (error) {
        console.warn("Falling back to default pass location:", error);
    }

    passLocation = DEFAULT_PASS_LOCATION;
    passLocationElement.textContent = getLocationLabel(passLocation);
}

function setViewMode(mode) {
    currentView = mode;
    const isMap = mode === "map";
    mapModeBtn.classList.toggle("is-active", isMap);
    globeModeBtn.classList.toggle("is-active", !isMap);
    map.getContainer().style.display = isMap ? "block" : "none";
    globeView.classList.toggle("hidden", isMap);

    if (!isMap && !globeRenderer) {
        initGlobe();
    }
}

function initGlobe() {
    if (!window.THREE || !globeView) {
        return;
    }

    if (globeRenderer) {
        return;
    }

    const width = globeView.clientWidth || 640;
    const height = globeView.clientHeight || 420;

    globeScene = new THREE.Scene();
    globeCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    globeCamera.position.set(0, 0.35, 4.65);
    globeCamera.lookAt(0, 0, 0);

    globeRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    globeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    globeRenderer.setSize(width, height);
    globeRenderer.outputColorSpace = THREE.SRGBColorSpace;
    globeView.appendChild(globeRenderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 1.05);
    const pointLight = new THREE.PointLight(0x6dc8ff, 2.6, 30);
    pointLight.position.set(4, 2, 5);
    globeScene.add(ambient, pointLight);

    const earthGeometry = new THREE.SphereGeometry(1.25, 64, 64);
    const earthMaterial = new THREE.MeshStandardMaterial({
        color: 0x8bc7ff,
        roughness: 0.92,
        metalness: 0.05
    });
    globeEarth = new THREE.Mesh(earthGeometry, earthMaterial);
    globeScene.add(globeEarth);

    const earthGlow = new THREE.Mesh(
        new THREE.SphereGeometry(1.34, 48, 48),
        new THREE.MeshBasicMaterial({
            color: 0x4baaff,
            transparent: true,
            opacity: 0.12,
            side: THREE.BackSide
        })
    );
    globeScene.add(earthGlow);

    const starGeometry = new THREE.BufferGeometry();
    const starCount = 700;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i += 1) {
        const i3 = i * 3;
        starPositions[i3] = (Math.random() - 0.5) * 18;
        starPositions[i3 + 1] = (Math.random() - 0.5) * 18;
        starPositions[i3 + 2] = (Math.random() - 0.5) * 18;
    }
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 0.03 });
    const starField = new THREE.Points(starGeometry, starMaterial);
    globeScene.add(starField);

    const orbitalPoints = [];
    for (let i = 0; i <= 360; i += 10) {
        const angle = (i * Math.PI) / 180;
        orbitalPoints.push(new THREE.Vector3(Math.cos(angle) * 1.6, Math.sin(angle) * 0.34, Math.sin(angle) * 1.6));
    }
    globeOrbitRing = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(orbitalPoints),
        new THREE.LineBasicMaterial({ color: 0x68dfff, transparent: true, opacity: 0.75 })
    );
    globeScene.add(globeOrbitRing);

    globeIssMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 18, 18),
        new THREE.MeshBasicMaterial({ color: 0x7cf1ff })
    );
    globeScene.add(globeIssMarker);

    const animateGlobe = () => {
        if (globeRenderer && globeScene && globeCamera && globeEarth) {
            globeEarth.rotation.y += 0.0025;
            globeOrbitRing.rotation.y += 0.003;
            globeCamera.position.x = Math.sin(Date.now() * 0.00012) * 0.45;
            globeCamera.position.y = 0.35 + Math.cos(Date.now() * 0.00014) * 0.12;
            globeCamera.lookAt(0, 0, 0);
            globeRenderer.render(globeScene, globeCamera);
        }
        globeAnimationFrame = requestAnimationFrame(animateGlobe);
    };

    animateGlobe();

    window.addEventListener("resize", () => {
        const nextWidth = globeView.clientWidth || 640;
        const nextHeight = globeView.clientHeight || 420;
        globeCamera.aspect = nextWidth / nextHeight;
        globeCamera.updateProjectionMatrix();
        globeRenderer.setSize(nextWidth, nextHeight);
    });
}

function updateGlobeMarker(lat, lon) {
    if (!globeIssMarker || !globeEarth) {
        return;
    }

    const radius = 1.27;
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);

    const x = -radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(phi) * Math.sin(theta);

    globeIssMarker.position.set(x, y, z);
}

function updateTrail(points) {
    trailLayers.forEach((layer) => layer.remove());
    trailLayers = [];

    if (points.length < 2) {
        return;
    }

    const segmentCount = Math.max(1, Math.min(6, points.length - 1));
    for (let i = 0; i < points.length - 1; i += Math.max(1, Math.floor(points.length / segmentCount))) {
        const start = points[i];
        const end = points[Math.min(i + 1, points.length - 1)];
        const opacity = Math.max(0.12, 0.8 - (i / points.length) * 0.65);
        const trailSegment = L.polyline([start, end], {
            color: "#67dfff",
            weight: 3,
            opacity,
            smoothFactor: 0.8,
            dashArray: "2 7"
        }).addTo(map);

        trailLayers.push(trailSegment);
    }
}

function updatePassPrediction(latitude, longitude, velocity) {
    const activeLocation = userLocation ?? passLocation;
    const distanceToLocation = calculateDistance(latitude, longitude, activeLocation.lat, activeLocation.lon);
    const passInMinutes = Math.max(2, Math.round((distanceToLocation / Math.max(velocity, 1)) * 60));
    const durationSeconds = Math.max(180, Math.round(210 + (Math.abs(longitude) % 40) * 2));
    const elevation = Math.min(85, Math.round(38 + (Math.abs(latitude) % 24) + (Math.abs(velocity) % 14)));

    passLocationElement.textContent = getLocationLabel(activeLocation);
    visibleInElement.textContent = `${passInMinutes} minutes`;
    passDurationElement.textContent = `${Math.floor(durationSeconds / 60)} minutes ${durationSeconds % 60} seconds`;
    maxElevationElement.textContent = `${elevation}°`;
}

function updateTelemetry(lat, lon, altitude, velocity) {
    const now = new Date();
    const fps = Number.isFinite(velocity) && velocity > 0 ? velocity : (lastVelocity ?? 27600);
    const computedAltitude = Number.isFinite(altitude) && altitude > 0 ? altitude : 408;
    const orbitNumber = Math.round(118900 + updateCount * 1.7);
    const orbitalPeriod = 92.7;
    const latency = 124 + Math.round((updateCount % 8) * 2);

    latElement.textContent = formatDegrees(lat);
    lonElement.textContent = formatDegrees(lon);
    altitudeElement.textContent = formatKm(computedAltitude);
    altitudeOrbitElement.textContent = formatKm(computedAltitude);

    velocityElement.textContent = `${Math.round(fps).toLocaleString()} km/h`;
    speedElement.textContent = `${(fps / 3600).toFixed(2)} km/s`;
    headingElement.textContent = `${Math.round(calculateHeading(lastPosition?.[0] ?? lat, lastPosition?.[1] ?? lon, lat, lon))}°`;
    orbitNumberElement.textContent = orbitNumber.toLocaleString();
    orbitalPeriodElement.textContent = `${orbitalPeriod.toFixed(1)} minutes`;
    packetsElement.textContent = `${String(updateCount).padStart(3, "0")}`;
    lastPacketElement.textContent = formatUTC(now);
    latencyElement.textContent = `${latency} ms`;

    updatedElement.textContent = `Last Update: ${now.toLocaleTimeString()}`;
    hudAltitudeElement.textContent = `ALT ${Math.round(computedAltitude)}km`;
    hudSpeedElement.textContent = `VEL ${(fps / 3600).toFixed(2)}km/s`;
    hudOrbitElement.textContent = `ORBIT ${orbitNumber.toLocaleString()}`;
    hudTimeElement.textContent = `UTC ${now.toISOString().slice(11, 19)}`;
    hudStatusElement.textContent = `STATUS LIVE`;
    telemetryStatusElement.textContent = "Receiving telemetry...";

    updatePassPrediction(lat, lon, fps);
}

function updateMap(lat, lon) {
    const position = [lat, lon];
    const now = Date.now();
    const heading = lastPosition
        ? calculateHeading(lastPosition[0], lastPosition[1], lat, lon)
        : 0;

    issMarker.setLatLng(position);
    issMarker.setIcon(createMarkerIcon(heading));
    issPulse.setLatLng(position);
    orbitRing.setLatLng(position);
    issMarker.setPopupContent(`<b>International Space Station</b><br>Latitude: ${lat.toFixed(2)}<br>Longitude: ${lon.toFixed(2)}<br>${new Date().toUTCString()}`);

    trailPoints.push(position);
    if (trailPoints.length > MAX_TRAIL_POINTS) {
        trailPoints.shift();
    }

    updateTrail(trailPoints);

    if (autoCenter) {
        map.flyTo(position, Math.max(3, map.getZoom()), { duration: 1.1 });
    }

    if (lastPosition) {
        totalDistance = (totalDistance || 0) + calculateDistance(lastPosition[0], lastPosition[1], lat, lon);
    }

    lastPosition = position;
    lastTimestamp = now;
    updateCount += 1;

    const markerX = (lon + 180) / 360;
    const markerY = 0.5 - (lat + 90) / 180;
    globeMarker.style.left = `${markerX * 100}%`;
    globeMarker.style.top = `${markerY * 100}%`;
}

function updateUI(lat, lon, velocity, altitude) {
    animateValue(latElement);
    animateValue(lonElement);
    animateValue(speedElement);
    animateValue(packetsElement);

    const computedSpeed = Number.isFinite(velocity) && velocity > 0
        ? velocity
        : lastVelocity || 27600;

    lastVelocity = computedSpeed;
    updateTelemetry(lat, lon, altitude, computedSpeed);
}

async function getISS() {
    updatedElement.classList.add("loading");
    connectionElement.textContent = "Syncing...";
    telemetryStatusElement.textContent = "Syncing telemetry...";

    try {
        const response = await fetch("https://api.wheretheiss.at/v1/satellites/25544", {
            cache: "no-store"
        });

        if (response.status === 429) {
            connectionElement.textContent = "Rate limited";
            document.querySelector(".indicator").style.backgroundColor = "#ff5b5b";
            updatedElement.textContent = "Too many requests. Retrying shortly...";
            return;
        }

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const data = await response.json();
        const latitude = Number(data.latitude ?? data.iss_position?.latitude);
        const longitude = Number(data.longitude ?? data.iss_position?.longitude);
        const velocity = Number(data.velocity ?? data.speed ?? data.iss_position?.velocity);
        const altitude = Number(data.altitude ?? data.iss_position?.altitude ?? 408);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            throw new Error("Invalid ISS coordinates returned by API");
        }

        updateMap(latitude, longitude);
        updateUI(latitude, longitude, velocity, altitude);
        updateGlobeMarker(latitude, longitude);

        connectionElement.textContent = "Connected";
        document.querySelector(".indicator").style.backgroundColor = "#25d366";
        telemetryStatusElement.textContent = "Receiving telemetry...";
    } catch (error) {
        connectionElement.textContent = "Disconnected";
        document.querySelector(".indicator").style.backgroundColor = "#ff5b5b";
        telemetryStatusElement.textContent = "Telemetry lost";
        console.error("Error fetching ISS data:", error);
    }
}

cards.forEach((card) => {
    card.addEventListener("pointermove", (event) => {
        const rect = card.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        const rotateX = (0.5 - y) * 18;
        const rotateY = (x - 0.5) * 26;

        card.style.setProperty("--rotateX", `${rotateX}deg`);
        card.style.setProperty("--rotateY", `${rotateY}deg`);
        card.style.setProperty("--spotlight-x", `${x * 100}%`);
        card.style.setProperty("--spotlight-y", `${y * 100}%`);
    });

    card.addEventListener("pointerenter", () => {
        card.classList.add("is-active");
    });

    card.addEventListener("pointerleave", () => {
        card.classList.remove("is-active");
        card.style.setProperty("--rotateX", "0deg");
        card.style.setProperty("--rotateY", "0deg");
        card.style.setProperty("--spotlight-x", "50%");
        card.style.setProperty("--spotlight-y", "50%");
    });
});

followBtn.addEventListener("click", () => {
    autoCenter = !autoCenter;
    followBtn.textContent = autoCenter ? "Pause Follow" : "Follow ISS";
    if (autoCenter && lastPosition) {
        map.flyTo(lastPosition, Math.max(3, map.getZoom()), { duration: 1.1 });
    }
});

zoomISSBtn.addEventListener("click", () => {
    autoCenter = true;
    followBtn.textContent = "Pause Follow";
    if (lastPosition) {
        map.flyTo(lastPosition, 4, { duration: 1.4 });
    }
});

resetBtn.addEventListener("click", () => {
    autoCenter = true;
    followBtn.textContent = "Pause Follow";
    map.setView([0, 0], 2);
});

mapModeBtn.addEventListener("click", () => setViewMode("map"));
globeModeBtn.addEventListener("click", () => setViewMode("globe"));

getCurrentBrowserLocation();
setViewMode("map");
getISS();
setInterval(getISS, UPDATE_INTERVAL_MS);
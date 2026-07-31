import { CONFIG } from './config.js';
import { state } from './state.js';
import { dom } from './dom.js';
import { createMarkerIcon } from './utils.js';

let map = null;
let issMarker = null;
let trailPolyline = null;

export function initMap() {
  if (map) return map;

  map = L.map('map', {
    center: [0, 0],
    zoom: 2,
    zoomControl: true,
    attributionControl: false
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd'
  }).addTo(map);

  return map;
}

export function updateMapPosition(lat, lon, heading) {
  if (!map) return;

  if (!issMarker) {
    issMarker = L.marker([lat, lon], {
      icon: createMarkerIcon(heading || 0),
      zIndexOffset: 1000
    }).addTo(map);
  } else {
    issMarker.setLatLng([lat, lon]);
    issMarker.setIcon(createMarkerIcon(heading || 0));
  }

  if (state.autoCenter && map.getZoom() >= 3) {
    map.panTo([lat, lon], { animate: true, duration: 1.5 });
  }
}

export function updateTrail(lat, lon) {
  if (!map) return;

  state.trailPoints.push([lat, lon]);
  if (state.trailPoints.length > CONFIG.MAX_TRAIL_POINTS) {
    state.trailPoints.shift();
  }

  if (trailPolyline) {
    trailPolyline.setLatLngs(state.trailPoints);
  } else if (state.trailPoints.length > 1) {
    trailPolyline = L.polyline(state.trailPoints, {
      color: '#fc3c23',
      weight: 1.5,
      opacity: 0.6,
      smoothFactor: 1
    }).addTo(map);
  }
}

export function flyToISS(lat, lon) {
  if (!map) return;
  state.autoCenter = true;
  dom.followBtn.textContent = 'Pause Follow';
  map.flyTo([lat, lon], 4, { duration: 1.4 });
}

export function resetView() {
  if (!map) return;
  state.autoCenter = true;
  dom.followBtn.textContent = 'Pause Follow';
  map.setView([0, 0], 2);
}

export function toggleAutoCenter() {
  state.autoCenter = !state.autoCenter;
  dom.followBtn.textContent = state.autoCenter ? 'Pause Follow' : 'Follow ISS';
  if (state.autoCenter && state.motion.current) {
    map.flyTo(state.motion.current, Math.max(3, map.getZoom()), { duration: 1.1 });
  }
}

export function getMap() {
  return map;
}

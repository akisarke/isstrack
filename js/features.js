import { CONFIG } from './config.js';
import { state, CrewCache } from './state.js';
import { dom } from './dom.js';
import { fetchWithTimeout, updateAPIHealth } from './api.js';

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

const AGENCY_LOGOS = {
  NASA: '🛸',
  Roscosmos: '🇷🇺',
  ESA: '🇪🇺',
  JAXA: '🇯🇵',
  SpaceX: '🚀'
};

export function renderCrew() {
  const list = dom.crewList;
  if (!list) return;

  state.crew.members = CREW_DATA.slice(0, 7);
  state.crew.loaded = true;

  if (dom.crewCount) dom.crewCount.textContent = state.crew.members.length;

  list.innerHTML = state.crew.members.map((member) => `
    <div class="crew-member" tabindex="0" role="listitem" aria-label="${member.name}, ${member.role}">
      <div class="crew-avatar" aria-hidden="true">
        ${member.photo ? `<img src="${member.photo}" alt="" loading="lazy" />` : `<span class="crew-avatar-fallback">${AGENCY_LOGOS[member.agency] || '👨‍🚀'}</span>`}
      </div>
      <div class="crew-info">
        <div class="crew-name">${member.name}</div>
        <div class="crew-role">${member.role}</div>
        <div class="crew-meta">
          <span class="crew-agency">${member.agency}</span>
          <span class="crew-sep" aria-hidden="true">·</span>
          <span class="crew-nationality">${member.nationality}</span>
        </div>
        <div class="crew-meta">
          <span>${member.mission}</span>
          <span class="crew-sep" aria-hidden="true">·</span>
          <span>${member.timeInSpace}</span>
        </div>
      </div>
    </div>
  `).join('');
}

export function renderSpacecraft() {
  const list = dom.spacecraftList;
  if (!list) return;

  const statusColors = { Docked: '#ba1e68', Docking: '#fc3c23', Undocking: '#8a1e40' };

  list.innerHTML = SPACECRAFT_DATA.map((craft) => {
    const statusColor = statusColors[craft.status] || '#666';
    return `
      <div class="spacecraft-item" tabindex="0" role="listitem" aria-label="${craft.name}, ${craft.status}">
        <div class="spacecraft-header">
          <strong class="spacecraft-name">${craft.name}</strong>
          <span class="spacecraft-status" style="color: ${statusColor}">${craft.status}</span>
        </div>
        <div class="spacecraft-mission">${craft.mission}</div>
        <div class="spacecraft-meta">
          <span>Type: ${craft.type}</span>
          <span class="crew-sep">·</span>
          <span>Port: ${craft.port}</span>
          <span class="crew-sep">·</span>
          <span>Launched: ${craft.launchDate}</span>
        </div>
      </div>
    `;
  }).join('');
}

let weatherCache = null;
let weatherFetching = false;

export async function fetchSpaceWeather() {
  const kpEl = dom.kpIndex;
  if (!kpEl) return;

  if (weatherCache && Date.now() - weatherCache.time < 300000) {
    renderWeather(weatherCache.data);
    return;
  }
  if (weatherFetching) return;
  weatherFetching = true;

  let success = false;
  try {
    const response = await fetchWithTimeout('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json', {}, 5000);
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        const latest = data[data.length - 1];
        const kp = latest.kp_index || latest.kp || 0;
        weatherCache = { data: { kp: parseFloat(kp) }, time: Date.now() };
        renderWeather(weatherCache.data);
        success = true;
      }
    }
  } catch (e) {
  }

  if (!success) {
    renderPlaceholderWeather();
  }
  weatherFetching = false;
}

function renderWeather(data) {
  const kp = data.kp;
  if (kp != null) {
    const level = kp < 3 ? 'Quiet' : kp < 5 ? 'Active' : kp < 7 ? 'Storm' : 'Severe Storm';
    const color = kp < 3 ? '#4ade80' : kp < 5 ? '#facc15' : kp < 7 ? '#fb923c' : '#ef4444';
    dom.kpIndex.textContent = `${kp.toFixed(1)} (${level})`;
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
  const ph = (label) => `${label} <span class="weather-note">(unavailable)</span>`;
  dom.kpIndex.innerHTML = ph('--');
  dom.solarActivity.innerHTML = ph('--');
  dom.geomagneticConditions.innerHTML = ph('--');
  dom.radiationLevel.innerHTML = ph('--');
  dom.auroraActivity.innerHTML = ph('--');
  dom.spaceWeatherStatus.textContent = 'Data unavailable';
  state.weather.loaded = true;
}

export function updateMissionTimeline(now, data) {
  const container = dom.timelineEvents;
  if (!container) return;

  const nextOrbit = CONFIG.ISS_ORBIT_PERIOD_MIN * 60000;
  const nextOrbitTime = now.getTime() + nextOrbit;

  const events = [
    { time: now, label: 'Last Telemetry Update', type: 'update' },
    { time: new Date(nextOrbitTime), label: 'Next Orbit Completion', type: 'orbit' }
  ];

  if (data?.visibility === 'daylight') {
    const sunsetOffset = 45 * 60000 + Math.random() * 15 * 60000;
    events.push({ time: new Date(now.getTime() + sunsetOffset), label: 'Sunset (estimated)', type: 'sunset' });
  } else {
    const sunriseOffset = 45 * 60000 + Math.random() * 15 * 60000;
    events.push({ time: new Date(now.getTime() + sunriseOffset), label: 'Sunrise (estimated)', type: 'sunrise' });
  }

  events.sort((a, b) => a.time - b.time);

  container.innerHTML = events.slice(0, 5).map((event) => {
    const diff = event.time.getTime() - now.getTime();
    const isPast = diff < 0;
    const timeStr = event.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="timeline-event ${isPast ? 'past' : 'future'}" role="listitem">
        <div class="timeline-dot" aria-hidden="true"></div>
        <div class="timeline-content">
          <div class="timeline-label">${event.label}</div>
          <div class="timeline-time">${timeStr}${isPast ? ' (completed)' : ''}</div>
        </div>
      </div>
    `;
  }).join('');
}

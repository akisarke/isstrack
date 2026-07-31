import { CONFIG } from './config.js';
import { state, Cache } from './state.js';
import { sleep } from './utils.js';

export function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export async function fetchWithRetry(url, options, retries = CONFIG.MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options);
      if (response.status === 429) {
        throw Object.assign(new Error('Rate limited'), { rateLimited: true });
      }
      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const backoff = Math.min(
          CONFIG.RETRY_BASE_DELAY_MS * 2 ** attempt,
          CONFIG.MAX_BACKOFF_MS
        );
        await sleep(backoff);
      }
    }
  }
  throw lastError;
}

export async function fetchJSON(url, options, retries) {
  const response = await fetchWithRetry(url, options, retries);
  return response.json();
}

export function updateDataAge() {
  const el = document.getElementById('dataAge');
  if (!el) return;
  if (!state.net.lastSuccessAt) {
    el.textContent = 'No data received';
    return;
  }
  const age = Date.now() - state.net.lastSuccessAt;
  if (age < 5000) {
    el.textContent = 'Live';
    el.className = 'data-age live';
  } else if (age < 30000) {
    el.textContent = `${Math.round(age / 1000)}s`;
    el.className = 'data-age recent';
  } else if (age < 300000) {
    el.textContent = `${Math.round(age / 60000)}m ago`;
    el.className = 'data-age stale';
  } else {
    el.textContent = `${Math.round(age / 60000)}m ago`;
    el.className = 'data-age old';
  }
}

export function updateAPIHealth(healthy) {
  state.net.apiHealthy = healthy;
  const el = document.getElementById('apiHealth');
  if (!el) return;
  el.textContent = healthy ? 'Connected' : 'Disconnected';
  el.className = healthy ? 'api-health connected' : 'api-health disconnected';
}

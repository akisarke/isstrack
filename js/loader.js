import { state } from './state.js';
import { dom } from './dom.js';

const STAGES = [
  { label: 'Initializing systems', duration: 400 },
  { label: 'Connecting to telemetry', duration: 600 },
  { label: 'Synchronizing orbital data', duration: 500 },
  { label: 'Loading crew information', duration: 400 },
  { label: 'Ready', duration: 300 }
];

export async function runLoadingSequence() {
  const overlay = dom.loadingOverlay;
  const statusEl = dom.loadingStatus;
  if (!overlay || !statusEl) return;

  overlay.classList.remove('hidden');
  overlay.classList.add('loading-active');

  for (const stage of STAGES) {
    state.loadingStage = stage.label;
    statusEl.textContent = stage.label;

    if (stage.label === 'Connecting to telemetry') {
      await new Promise((r) => setTimeout(r, 200));
    }

    await new Promise((r) => setTimeout(r, stage.duration));
  }

  overlay.classList.add('loading-fade');
  await new Promise((r) => setTimeout(r, 500));
  overlay.classList.add('hidden');
  overlay.classList.remove('loading-active', 'loading-fade');

  state.loadingComplete = true;
}

import { dom } from './dom.js';
import { state } from './state.js';

export function animateRollingNumber(element, target, suffix = '', duration = 600) {
  if (!element) return;
  const start = parseFloat(element.dataset.value) || 0;
  const diff = target - start;
  if (Math.abs(diff) < 0.01) return;
  element.dataset.value = target;

  const startTime = performance.now();

  function update(time) {
    const elapsed = time - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + diff * eased;
    element.textContent = `${current.toFixed(1)}${suffix}`;
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}

export function animateCardEntrance(cards) {
  cards.forEach((card, index) => {
    card.style.opacity = '0';
    card.style.transform = 'translateY(8px)';
    card.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    requestAnimationFrame(() => {
      setTimeout(() => {
        card.style.opacity = '1';
        card.style.transform = 'translateY(0)';
      }, index * 50);
    });
  });
}

export function setupHoverAnimations() {
  const cards = document.querySelectorAll('.card');
  cards.forEach((card) => {
    card.addEventListener('pointerenter', () => {
      card.style.transition = 'border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease';
    });
    card.addEventListener('pointerleave', () => {
      card.style.transition = 'border-color 0.3s ease, transform 0.3s ease, box-shadow 0.3s ease';
    });
  });
}

export function animateOrbitDot() {
  const dot = document.querySelector('.orbit-dot');
  if (!dot) return;
  dot.style.animation = 'none';
  void dot.offsetWidth;
  dot.style.animation = 'orbitSpin 8s linear infinite';
}

export function flashElement(el, className = 'u--packet-received') {
  if (!el) return;
  el.classList.add(className);
  setTimeout(() => el.classList.remove(className), 600);
}



export function initAccessibility() {
  document.querySelectorAll('button').forEach((btn) => {
    if (!btn.getAttribute('aria-label') && !btn.getAttribute('aria-labelledby')) {
      btn.setAttribute('aria-label', btn.textContent.trim());
    }
  });

  const sidebar = document.querySelector('.sidebar');
  if (sidebar) sidebar.setAttribute('role', 'region');

  const mapShell = document.querySelector('.map-shell');
  if (mapShell) mapShell.setAttribute('role', 'region');

  document.querySelectorAll('.card').forEach((card) => {
    card.setAttribute('tabindex', '0');
  });

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (prefersReducedMotion.matches) {
    document.documentElement.classList.add('reduced-motion');
  }
  prefersReducedMotion.addEventListener('change', (e) => {
    document.documentElement.classList.toggle('reduced-motion', e.matches);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const banner = document.getElementById('offlineBanner');
      if (banner && !banner.classList.contains('hidden')) {
        banner.classList.add('hidden');
      }
    }
  });
}

// DGC Theme — light/dark toggle, persisted in localStorage
// Include this as the FIRST script in <head> to avoid flash of wrong theme.
(function () {
  const stored = localStorage.getItem('dgc_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', stored);
})();

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('dgc_theme', next);
  _updateThemeBtn();
  // Re-render SVG timeline if present (uses theme-aware colours)
  if (typeof renderTimeline === 'function' && typeof _jobs !== 'undefined') {
    const tlJobs = (_jobs || []).filter(j => j.on_timeline && !j.archived);
    renderTimeline(tlJobs);
  }
  // Re-render deployment board if present
  if (typeof renderResourcePlanner === 'function') renderResourcePlanner();
  // Propagate to embedded iframes (staff sub-tabs)
  document.querySelectorAll('iframe').forEach(f => {
    try { f.contentWindow.postMessage({ type: 'dgc-theme', theme: next }, '*'); } catch (e) {}
  });
}

function _updateThemeBtn() {
  document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.textContent = isDark ? 'Light Mode' : 'Dark Mode';
  });
}

// Listen for theme messages from parent (when embedded as iframe)
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'dgc-theme') {
    document.documentElement.setAttribute('data-theme', e.data.theme);
    localStorage.setItem('dgc_theme', e.data.theme);
    _updateThemeBtn();
  }
});

// Sync button label once DOM is ready
document.addEventListener('DOMContentLoaded', _updateThemeBtn);

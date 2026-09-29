// DGC Theme — light/dark toggle, persisted in localStorage
// Include this as the FIRST script in <head> to avoid flash of wrong theme.
// New users start in light mode. Whatever they pick is remembered on the
// device (localStorage) and, in the planner, on their login too
// (window.dgcSaveTheme), so it follows them to a new phone or computer.
(function () {
  const stored = localStorage.getItem('dgc_theme') || 'light';
  document.documentElement.setAttribute('data-theme', stored);
})();

// Apply a theme everywhere on this page: attribute, storage, buttons,
// redraws, and any embedded pages (staff sub-tabs).
function applyTheme(next) {
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('dgc_theme', next);
  _updateThemeBtn();
  // Re-render SVG timeline only if currently visible (hidden panel gives clientWidth=0 → squish)
  if (typeof renderTimeline === 'function' && typeof _jobs !== 'undefined') {
    const tlPanel = document.getElementById('tab-timeline');
    if (tlPanel && tlPanel.classList.contains('active')) {
      const tlJobs = (_jobs || []).filter(j => j.on_timeline && !j.archived);
      renderTimeline(tlJobs);
    }
  }
  // Re-render deployment board if present
  if (typeof renderResourcePlanner === 'function') renderResourcePlanner();
  // Propagate to embedded iframes (staff sub-tabs)
  document.querySelectorAll('iframe').forEach(f => {
    try { f.contentWindow.postMessage({ type: 'dgc-theme', theme: next }, '*'); } catch (e) {}
  });
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  // Inside the planner: tell it, so the planner and its other tabs follow
  // and it saves the choice on the login.
  if (window.top !== window.self) {
    try { window.top.postMessage({ type: 'dgc-theme-changed', theme: next }, location.origin); } catch (e) {}
  }
  if (typeof window.dgcSaveTheme === 'function') window.dgcSaveTheme(next);
}

function _updateThemeBtn() {
  document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.textContent = isDark ? 'Light Mode' : 'Dark Mode';
  });
}

window.addEventListener('message', function (e) {
  if (!e.data) return;
  // From the parent (when embedded as iframe)
  if (e.data.type === 'dgc-theme') {
    document.documentElement.setAttribute('data-theme', e.data.theme);
    localStorage.setItem('dgc_theme', e.data.theme);
    _updateThemeBtn();
  }
  // From an embedded page whose own toggle was pressed
  if (e.data.type === 'dgc-theme-changed' && e.origin === location.origin && window.top === window.self) {
    applyTheme(e.data.theme);
    if (typeof window.dgcSaveTheme === 'function') window.dgcSaveTheme(e.data.theme);
  }
});

// Sync button label once DOM is ready
document.addEventListener('DOMContentLoaded', _updateThemeBtn);

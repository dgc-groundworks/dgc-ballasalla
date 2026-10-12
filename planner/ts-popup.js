/* "See the timesheet" pop-up (Ash, 12 Oct 2026, night): "Maybe have a button where you could see the picture of the
   timesheet and look, in case there's an AI error."
   One person, one day, three sources side by side, each clearly labelled:
     1. what the worker typed in the Timesheet app,
     2. the photo of the paper dayworks sheet (tap to enlarge) and what the AI read from it,
     3. what's on the Hours grid.
   In-page only (no new tabs). Close with the X, Esc or a click outside. Used by planner/accounts.html and staff/app.js.
   Data: public.acc_day_sources (dgc-ballasalla/staff/accounts.sql)(p_name, p_date) (Staff Hub/web-port/sql/hub-web-012-timesheet-sources.sql).
   Needs SUPABASE_URL, SUPABASE_KEY and ensureLoggedIn() from staff/config.js and staff/auth.js. */
(function () {
  "use strict";
  if (window.TsPopup) return;
  var PHOTO_BASE = (typeof SUPABASE_URL !== "undefined" ? SUPABASE_URL : "https://vigdtpcgeqenznuakdwz.supabase.co") + "/storage/v1/object/public/dayworks-timesheets/";

  var css = "" +
    ".tsp-back{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;padding:24px 12px;overflow-y:auto;-webkit-overflow-scrolling:touch}" +
    ".tsp{background:var(--panel,#1d222b);color:var(--text,#e8ebf0);border:1px solid var(--border,#333a47);border-radius:12px;width:100%;max-width:880px;box-shadow:0 12px 40px rgba(0,0,0,.45);font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}" +
    ".tsp-head{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border,#333a47);position:sticky;top:0;background:var(--panel,#1d222b);border-radius:12px 12px 0 0;z-index:1}" +
    ".tsp-head h2{margin:0;font-size:1.05rem}.tsp-head .tsp-sub{font-size:.8rem;color:var(--muted,#9aa4b2)}" +
    ".tsp-x{margin-left:auto;flex:none;width:36px;height:36px;border-radius:8px;border:1px solid var(--border,#333a47);background:var(--panel2,#262c37);color:var(--text,#e8ebf0);font-size:20px;line-height:1;cursor:pointer}" +
    ".tsp-x:hover,.tsp-x:focus-visible{border-color:var(--accent,#e8b84b)}" +
    ".tsp-body{padding:12px 16px 16px}" +
    ".tsp-sum{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px}" +
    ".tsp-sum>div{background:var(--panel2,#262c37);border:1px solid var(--border,#333a47);border-radius:9px;padding:8px 10px}" +
    ".tsp-sum .k{font-size:.72rem;color:var(--muted,#9aa4b2)}.tsp-sum .v{font-size:1.25rem;font-weight:800}" +
    ".tsp-sum>div.odd{border-color:var(--warn,var(--accent,#d29922));box-shadow:inset 0 0 0 1px var(--warn,var(--accent,#d29922))}" +
    ".tsp-sec{border:1px solid var(--border,#333a47);border-radius:10px;padding:10px 12px;margin-top:10px}" +
    ".tsp-sec h3{margin:0 0 6px;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--accent,#e8b84b)}" +
    ".tsp-sec h3 .tsp-src{text-transform:none;letter-spacing:0;color:var(--muted,#9aa4b2);font-weight:400}" +
    ".tsp-dl{display:grid;grid-template-columns:120px 1fr;gap:3px 10px;font-size:.86rem}.tsp-dl dt{color:var(--muted,#9aa4b2)}.tsp-dl dd{margin:0;word-break:break-word}" +
    ".tsp-one+.tsp-one{border-top:1px dashed var(--border,#333a47);margin-top:8px;padding-top:8px}" +
    ".tsp-none{color:var(--muted,#9aa4b2);font-style:italic}" +
    ".tsp-photo{display:block;width:100%;max-height:70vh;object-fit:contain;background:#000;border-radius:8px;cursor:zoom-in;border:1px solid var(--border,#333a47)}" +
    ".tsp-photo-btn{display:block;width:100%;padding:0;border:0;background:none;cursor:zoom-in}" +
    ".tsp-hint{font-size:.75rem;color:var(--muted,#9aa4b2);margin:4px 0 8px}" +
    ".tsp-grid2{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:12px;align-items:start}" +
    "table.tsp-t{border-collapse:collapse;width:100%;font-size:.78rem;margin-top:6px}table.tsp-t th,table.tsp-t td{border-bottom:1px solid var(--border,#333a47);padding:3px 5px;text-align:left;white-space:nowrap}" +
    "table.tsp-t th{color:var(--muted,#9aa4b2);font-weight:600}table.tsp-t tr.me td{font-weight:800;background:var(--panel2,#262c37)}" +
    ".tsp-warn{color:var(--warn,var(--accent,#d29922))}.tsp-err{color:var(--danger,#e5534b)}" +
    ".tsp-zoom{position:fixed;inset:0;z-index:9100;background:#000;display:flex;flex-direction:column}" +
    ".tsp-zbar{display:flex;gap:6px;align-items:center;padding:8px 10px;background:#111;border-bottom:1px solid #333;flex-wrap:wrap}" +
    ".tsp-zbar button{background:#262c37;color:#fff;border:1px solid #444;border-radius:8px;padding:7px 12px;font:600 14px system-ui,sans-serif;cursor:pointer}" +
    ".tsp-zbar .tsp-x{margin-left:auto;width:40px;height:36px;padding:0}" +
    ".tsp-zarea{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y pinch-zoom}" +
    ".tsp-zarea img{display:block;margin:0 auto;transform-origin:center center}" +
    ".ts-see{font:600 .68rem/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:2px 5px;margin-left:4px;border-radius:5px;border:1px solid var(--accent,#e8b84b);background:transparent;color:var(--accent,#e8b84b);cursor:pointer;vertical-align:middle;white-space:nowrap}" +
    ".ts-see:hover,.ts-see:focus-visible{background:var(--accent,#e8b84b);color:#1a1a1a}" +
    ".ts-see.lg{font-size:.78rem;padding:4px 9px}" +
    "@media (max-width:640px){.tsp-back{padding:0}.tsp{border-radius:0;min-height:100%;border:0}.tsp-head{border-radius:0}.tsp-grid2{grid-template-columns:1fr}.tsp-dl{grid-template-columns:96px 1fr}.tsp-sum .v{font-size:1.05rem}.tsp-body{padding:10px 12px 20px}}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  function esc(s) { return s == null ? "" : String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function n2(v) { var n = Math.round(Number(v) * 100) / 100; if (!isFinite(n)) return ""; return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""); }
  function fmtLong(iso) { var p = String(iso).split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); }
  function fmtShort(iso) { var p = String(iso).split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }); }
  function fmtWhen(ts) { return ts ? new Date(ts).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""; }
  function row(k, v) { return v === "" || v == null ? "" : "<dt>" + esc(k) + "</dt><dd>" + v + "</dd>"; }
  function times(a, b) { return a || b ? esc(a || "?") + " to " + esc(b || "?") : ""; }

  async function defaultFetch(name, date) {
    var sess = typeof ensureLoggedIn === "function" ? await ensureLoggedIn() : null;
    if (!sess) throw new Error("Please sign in again.");
    var r = await fetch(SUPABASE_URL + "/rest/v1/rpc/acc_day_sources", { method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + sess.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ p_name: name, p_date: date }) });
    var txt = await r.text(), body = null; try { body = txt ? JSON.parse(txt) : null; } catch (e) {}
    if (!r.ok) throw new Error(((body && body.message) || txt || "Request failed").replace(/^Accounts: /, ""));
    return body;
  }

  var back = null, lastFocus = null, zoomEl = null;
  function close() {
    if (zoomEl) { closeZoom(); return; }
    if (!back) return;
    back.remove(); back = null;
    document.removeEventListener("keydown", onKey, true);
    document.documentElement.style.overflow = "";
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "Tab" && back) { /* keep the keyboard inside the pop-up */
      var root = zoomEl || back, f = root.querySelectorAll("button, [href], [tabindex]:not([tabindex='-1'])");
      if (!f.length) return; var a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    }
  }
  function openZoom(src, alt) {
    var scale = 1, rot = 0;
    zoomEl = document.createElement("div");
    zoomEl.className = "tsp-zoom"; zoomEl.setAttribute("role", "dialog"); zoomEl.setAttribute("aria-modal", "true"); zoomEl.setAttribute("aria-label", "Timesheet photo, enlarged");
    zoomEl.innerHTML = '<div class="tsp-zbar"><button type="button" data-z="out" aria-label="Zoom out">&minus;</button><button type="button" data-z="in" aria-label="Zoom in">+</button>' +
      '<button type="button" data-z="fit">Fit</button><button type="button" data-z="rot">Rotate</button><button type="button" class="tsp-x" data-z="close" aria-label="Close the enlarged photo">&times;</button></div>' +
      '<div class="tsp-zarea"><img alt="' + esc(alt) + '"></div>';
    var img = zoomEl.querySelector("img"), area = zoomEl.querySelector(".tsp-zarea");
    function apply() {
      var w = area.clientWidth || window.innerWidth, h = area.clientHeight || window.innerHeight;
      var nw = img.naturalWidth || w, nh = img.naturalHeight || h, side = rot % 180 !== 0;
      var fit = Math.min(w / (side ? nh : nw), h / (side ? nw : nh), 1.5);
      img.style.width = Math.round(nw * fit * scale) + "px"; img.style.height = Math.round(nh * fit * scale) + "px";
      img.style.transform = "rotate(" + rot + "deg)";
      var pad = side ? Math.abs(nw - nh) * fit * scale / 2 : 0; img.style.margin = Math.round(pad) + "px auto";
    }
    img.onload = apply; img.src = src;
    zoomEl.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) { if (e.target === img) { scale = scale >= 2.5 ? 1 : scale * 1.6; apply(); } return; }
      var z = b.getAttribute("data-z");
      if (z === "in") scale = Math.min(scale * 1.4, 8); else if (z === "out") scale = Math.max(scale / 1.4, 0.4); else if (z === "fit") scale = 1; else if (z === "rot") rot = (rot + 90) % 360; else if (z === "close") { closeZoom(); return; }
      apply();
    });
    document.body.appendChild(zoomEl);
    zoomEl.querySelector('[data-z="close"]').focus();
  }
  function closeZoom() { if (!zoomEl) return; zoomEl.remove(); zoomEl = null; var b = back && back.querySelector(".tsp-photo-btn"); if (b) b.focus(); }

  /* opts: { name, date, grid: { text, hours, detail }, fetch: async (name, date) => data } */
  async function open(opts) {
    close();
    lastFocus = document.activeElement;
    back = document.createElement("div");
    back.className = "tsp-back";
    back.innerHTML = '<div class="tsp" role="dialog" aria-modal="true" aria-labelledby="tspTitle"><div class="tsp-head"><div><h2 id="tspTitle">Timesheet check: ' + esc(opts.name) + '</h2><div class="tsp-sub">' + esc(fmtLong(opts.date)) + '</div></div>' +
      '<button type="button" class="tsp-x" aria-label="Close">&times;</button></div><div class="tsp-body"><p class="tsp-none">Loading what was sent in for this day...</p></div></div>';
    back.addEventListener("click", function (e) {
      if (e.target === back || e.target.closest(".tsp-x")) { close(); return; }
      var pb = e.target.closest(".tsp-photo-btn"); if (pb) openZoom(pb.getAttribute("data-src"), pb.getAttribute("data-alt"));
    });
    document.body.appendChild(back);
    document.documentElement.style.overflow = "hidden";
    document.addEventListener("keydown", onKey, true);
    back.querySelector(".tsp-x").focus();
    var mine = back, data;
    try { data = await (opts.fetch || defaultFetch)(opts.name, opts.date); }
    catch (e) { if (mine === back) back.querySelector(".tsp-body").innerHTML = '<p class="tsp-err">Couldn\'t load the timesheet: ' + esc(e.message) + '</p>'; return; }
    if (mine !== back) return;
    back.querySelector(".tsp-body").innerHTML = bodyHTML(opts, data || {});
  }

  function bodyHTML(o, d) {
    var ts = d.timesheets || [], dw = d.dayworks || [], grid = o.grid || {}, saved = d.grid || [];
    var tsH = ts.length ? ts.reduce(function (a, t) { return a + Number(t.hours || 0); }, 0) : null;
    var dwH = dw.length ? dw.reduce(function (a, x) { return a + Number(x.hours || 0); }, 0) : null;
    var gH = grid.hours != null ? Number(grid.hours) : null;
    var vals = [gH, tsH, dwH].filter(function (v) { return v != null; });
    var differ = vals.length > 1 && vals.some(function (v) { return Math.abs(v - vals[0]) > 0.01; });
    function box(k, v, odd) { return '<div class="' + (odd ? "odd" : "") + '"><div class="k">' + k + '</div><div class="v">' + (v == null ? '<span class="tsp-none" style="font-size:.85rem;font-weight:400">none</span>' : n2(v) + "h") + "</div></div>"; }
    var h = '<div class="tsp-sum" aria-label="Hours from each source">' + box("Timesheet app", tsH, differ && tsH != null) + box("Paper sheet (AI read)", dwH, differ && dwH != null) + box("Hours grid", gH != null ? gH : null, differ && gH != null) + "</div>";
    h += differ ? '<p class="tsp-warn" style="margin:0 0 4px;font-size:.85rem">The sources don\'t agree. Check the photo below in case the AI misread it.</p>' : "";

    /* 1. Timesheet app */
    h += '<section class="tsp-sec"><h3>1. Timesheet app <span class="tsp-src">what the worker typed</span></h3>';
    if (!ts.length) h += '<p class="tsp-none" style="margin:0">Nothing sent from the Timesheet app for this day.</p>';
    ts.forEach(function (t) {
      h += '<div class="tsp-one"><dl class="tsp-dl">' + row("Site", esc(t.site || "")) + row("Work done", esc(t.description || "")) + row("Times", times(t.start, t.finish)) +
        row("Lunch", t.lunch != null && t.lunch !== "" ? esc(t.lunch) + " min" : "") + row("Hours", "<b>" + n2(t.hours) + "h</b>") + row("Notes", esc(t.notes || "")) +
        row("Sent", esc(fmtWhen(t.submittedAt)) || '<span class="tsp-none">not recorded</span>') + "</dl></div>";
    });
    h += "</section>";

    /* 2. Paper sheet: photo and what the AI read */
    h += '<section class="tsp-sec"><h3>2. Paper timesheet <span class="tsp-src">the photo, and what the AI read from it</span></h3>';
    var photos = []; dw.forEach(function (x) { if (x.imagePath && photos.indexOf(x.imagePath) < 0) photos.push(x.imagePath); });
    if (!dw.length) h += '<p class="tsp-none" style="margin:0">No photo for this day. No paper dayworks sheet was entered for ' + esc(o.name) + " on this date.</p>";
    else {
      h += '<div class="tsp-grid2"><div>';
      if (!photos.length) h += '<p class="tsp-none">No photo for this day.</p>';
      photos.forEach(function (p, i) {
        var src = PHOTO_BASE + encodeURIComponent(p), alt = "Photo of the paper timesheet" + (photos.length > 1 ? " " + (i + 1) : "") + " for " + o.name;
        h += '<button type="button" class="tsp-photo-btn" data-src="' + esc(src) + '" data-alt="' + esc(alt) + '" aria-label="Enlarge the photo"><img class="tsp-photo" src="' + esc(src) + '" alt="' + esc(alt) + '" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement(\'p\'),{className:\'tsp-err\',textContent:\'The photo could not be loaded.\'}))"></button>';
      });
      if (photos.length) h += '<p class="tsp-hint">Tap the photo to enlarge it, zoom in and rotate.</p>';
      h += "</div><div>";
      dw.forEach(function (x) {
        h += '<div class="tsp-one"><dl class="tsp-dl">' + row("Site", esc(x.site || "")) + row("Work done", esc(x.description || "")) + row("Times", times(x.start, x.finish)) +
          row("Lunch", x.lunch != null && x.lunch !== "" ? esc(x.lunch) + " min" : "") + row("Hours", "<b>" + n2(x.hours) + "h</b>") +
          row("Charged", x.billedHours != null && Number(x.billedHours) !== Number(x.hours) ? n2(x.billedHours) + "h" + (x.billedReason ? " (" + esc(x.billedReason) + ")" : "") : "") +
          row("Note", esc(x.note || "")) + row("Checked", x.confirmed ? "Yes, confirmed on the Dayworks screen" : '<span class="tsp-warn">Not confirmed yet</span>') +
          (x.flagged ? row("Flag", '<span class="tsp-warn">Flagged on the Dayworks screen</span>') : "") + "</dl></div>";
      });
      var same = (d.sameSheet || []);
      if (same.length > 1) {
        h += '<p class="tsp-hint" style="margin-top:10px">Everything the AI read from this photo (this day in bold):</p><div style="overflow-x:auto"><table class="tsp-t"><thead><tr><th>Day</th><th>Name</th><th>Times</th><th>Hours</th></tr></thead><tbody>' +
          same.map(function (s) { var me = s.date === o.date && String(s.name || "").trim().toLowerCase() === String(o.name || "").trim().toLowerCase();
            return '<tr class="' + (me ? "me" : "") + '"><td>' + esc(fmtShort(s.date)) + "</td><td>" + esc(s.name) + "</td><td>" + times(s.start, s.finish) + "</td><td>" + n2(s.hours) + "h</td></tr>"; }).join("") + "</tbody></table></div>";
      }
      h += "</div></div>";
    }
    h += "</section>";

    /* 3. Hours grid */
    h += '<section class="tsp-sec"><h3>3. Hours grid <span class="tsp-src">what is being paid</span></h3><dl class="tsp-dl">' +
      row("On the grid", "<b>" + esc(grid.text || (gH != null ? n2(gH) + "h" : "Nothing")) + "</b>") + row("Why", esc(grid.detail || ""));
    saved.forEach(function (g) {
      h += row("Saved entry", (g.hours == null ? "nil" : n2(g.hours) + "h") + (g.updatedBy ? ", last changed by " + esc(g.updatedBy) + " " + esc(fmtWhen(g.updatedAt)) : g.createdBy ? ", added by " + esc(g.createdBy) + " " + esc(fmtWhen(g.createdAt)) : g.createdAt ? ", added " + esc(fmtWhen(g.createdAt)) : "")) +
        row("Note on the cell", esc(g.note || ""));
    });
    if (!saved.length) h += row("Saved entry", '<span class="tsp-none">Nothing typed on the Staff grid for this day</span>');
    h += "</dl></section>";
    return h;
  }

  window.TsPopup = { open: open, close: close };
})();

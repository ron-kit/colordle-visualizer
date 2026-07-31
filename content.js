// Colordle 3D Guess Cube - content script
(function () {
  "use strict";

  const STORAGE_KEY = `c3d:${location.hostname}:${new Date().toDateString()}`;
  const SIG_KEY = `c3d-sig:${location.hostname}`;

  let guessMap = new Map();    // key ("g:N" for scraped guess #N, "m:N" for manual) -> {r,g,b}
  let removedKeys = new Set(); // keys the user explicitly removed / cleared, never re-added
  let manualCounter = 0;
  let signature = null;    // {tag, classes: []}
  let picking = false;
  let panelOpen = false;
  let rescanTimer = null;
  let observer = null;

  function currentGuesses() {
    // numeric guess-number keys sorted ascending (chronological), manual keys after
    const entries = Array.from(guessMap.entries());
    const numeric = entries.filter(([k]) => /^g:\d+$/.test(k))
      .sort((a, b) => parseInt(a[0].slice(2)) - parseInt(b[0].slice(2)));
    const manual = entries.filter(([k]) => k.startsWith("m:"))
      .sort((a, b) => parseInt(a[0].slice(2)) - parseInt(b[0].slice(2)));
    return [...numeric, ...manual].map(([key, c]) => ({ key, c }));
  }

  // ---------- color parsing helpers ----------
  function parseCssColor(str) {
    if (!str) return null;
    str = str.trim();
    const m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (m) {
      return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]) };
    }
    const hex = str.match(/^#?([0-9a-f]{6})$/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    return null;
  }

  function isTransparentOrDefault(bg) {
    if (!bg) return true;
    if (bg === "transparent") return true;
    const m = bg.match(/^rgba\(\s*[\d.]+[,\s]+[\d.]+[,\s]+[\d.]+[,\s]+([\d.]+)\)/i);
    if (m && parseFloat(m[1]) === 0) return true;
    return false;
  }

  function colorKey(c) { return `${c.r},${c.g},${c.b}`; }

  // ---------- persistence ----------
  function save() {
    try {
      chrome.storage.local.set({
        [STORAGE_KEY]: {
          map: Array.from(guessMap.entries()),
          removed: Array.from(removedKeys),
          manualCounter,
        },
      });
    } catch (e) { /* extension context may be reloading */ }
  }
  function saveSignature() {
    try {
      chrome.storage.local.set({ [SIG_KEY]: signature });
    } catch (e) {}
  }
  function load(cb) {
    try {
      chrome.storage.local.get([STORAGE_KEY, SIG_KEY], (res) => {
        const stored = res[STORAGE_KEY];
        if (stored && stored.map) {
          guessMap = new Map(stored.map);
          removedKeys = new Set(stored.removed || []);
          manualCounter = stored.manualCounter || 0;
        } else {
          guessMap = new Map();
          removedKeys = new Set();
        }
        signature = res[SIG_KEY] || null;
        cb && cb();
      });
    } catch (e) { cb && cb(); }
  }

  // ---------- element -> color detection ----------
  function findColorElement(el) {
    if (!el) return null;
    const candidates = [el, ...el.querySelectorAll("*")];
    for (const c of candidates) {
      const bg = getComputedStyle(c).backgroundColor;
      if (!isTransparentOrDefault(bg)) return { el: c, bg };
    }
    let cur = el.parentElement;
    let hops = 0;
    while (cur && hops < 5) {
      const bg = getComputedStyle(cur).backgroundColor;
      if (!isTransparentOrDefault(bg)) return { el: cur, bg };
      cur = cur.parentElement;
      hops++;
    }
    return null;
  }

  function elementSignature(el) {
    const classes = Array.from(el.classList || []);
    return { tag: el.tagName.toLowerCase(), classes };
  }

  function matchesSignature(el) {
    if (!signature) return false;
    if (el.tagName.toLowerCase() !== signature.tag) return false;
    if (signature.classes.length === 0) return true;
    return signature.classes.every((c) => el.classList.contains(c));
  }

  function selectorFromSignature() {
    if (!signature) return null;
    const cls = signature.classes.map((c) => "." + CSS.escape(c)).join("");
    return signature.tag + cls;
  }

  // Parse a row's text to find its guess ordinal ("#3") and whether it has a
  // finished score ("- 72.97%"). Rows with no score are the still-being-typed
  // "current guess" placeholder and must be skipped, otherwise the exact
  // guess we care about most (the newest one) gets locked in prematurely
  // with a stale/placeholder color the moment it appears, before its real
  // color and score are set.
  function parseRowText(text) {
    const numMatch = text.match(/#(\d+)/);
    const hasScore = /-\s*[\d.]+\s*%/.test(text) || /%/.test(text);
    let name = null;
    if (numMatch) {
      let rest = text.slice(text.indexOf(numMatch[0]) + numMatch[0].length);
      rest = rest.replace(/-\s*[\d.]+\s*%.*$/, "").trim();
      if (rest) name = rest;
    }
    return {
      num: numMatch ? parseInt(numMatch[1], 10) : null,
      hasScore,
      name,
    };
  }

  function scanForGuesses() {
    if (!signature) return;
    const sel = selectorFromSignature();
    if (!sel) return;
    let found;
    try {
      found = document.querySelectorAll(sel);
    } catch (e) { return; }
    let changed = false;
    found.forEach((el) => {
      const { num, hasScore, name } = parseRowText(el.textContent || "");
      if (num === null || !hasScore) return; // skip unfinished/placeholder row
      const key = `g:${num}`;
      if (removedKeys.has(key)) return; // user removed this one; don't resurrect it
      const bg = getComputedStyle(el).backgroundColor;
      const c = parseCssColor(bg);
      if (!c) return;
      c.name = name || null;
      const prev = guessMap.get(key);
      if (!prev || prev.r !== c.r || prev.g !== c.g || prev.b !== c.b || prev.name !== c.name) {
        guessMap.set(key, c);
        changed = true;
      }
    });
    if (changed) {
      save();
      renderList();
      requestFrame();
    }
  }

  function startObserving() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => scanForGuesses());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    if (rescanTimer) clearInterval(rescanTimer);
    rescanTimer = setInterval(scanForGuesses, 1200);
  }

  // ---------- picker mode ----------
  let hoverEl = null;
  function onPickMouseOver(e) {
    if (hoverEl) hoverEl.classList.remove("c3d-pick-highlight");
    hoverEl = e.target;
    hoverEl.classList.add("c3d-pick-highlight");
  }
  function onPickClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const found = findColorElement(e.target);
    if (hoverEl) hoverEl.classList.remove("c3d-pick-highlight");
    if (!found) {
      setStatus("Couldn't find a color there — try clicking directly on a guess swatch.", false);
      stopPicking();
      return;
    }
    signature = elementSignature(found.el);
    saveSignature();
    setStatus(`Tracking swatches like <${signature.tag}${signature.classes.length ? "." + signature.classes.join(".") : ""}>`, false);
    stopPicking();
    scanForGuesses();
    startObserving();
  }
  function startPicking() {
    picking = true;
    setStatus("Click on one of your guess color swatches on the page…", true);
    document.addEventListener("mouseover", onPickMouseOver, true);
    document.addEventListener("click", onPickClick, true);
    pickBtn.classList.add("c3d-active");
    pickBtn.textContent = "Cancel picking";
  }
  function stopPicking() {
    picking = false;
    document.removeEventListener("mouseover", onPickMouseOver, true);
    document.removeEventListener("click", onPickClick, true);
    if (hoverEl) { hoverEl.classList.remove("c3d-pick-highlight"); hoverEl = null; }
    pickBtn.classList.remove("c3d-active");
    pickBtn.textContent = "🎯 Pick guess swatches";
  }

  function setStatus(msg, isPicking) {
    statusEl.textContent = msg;
    statusEl.classList.toggle("c3d-picking", !!isPicking);
  }

  // ---------- UI construction ----------
  const toggleBtn = document.createElement("button");
  toggleBtn.id = "c3d-toggle-btn";
  toggleBtn.innerHTML = '<span class="c3d-swatch"></span><span>3D Guesses</span>';
  document.documentElement.appendChild(toggleBtn);

  const panel = document.createElement("div");
  panel.id = "c3d-panel";
  panel.innerHTML = `
    <div id="c3d-header">
      <h1>Guesses in RGB space</h1>
      <button id="c3d-close-btn" title="Close">×</button>
    </div>
    <div id="c3d-canvas-wrap">
      <canvas id="c3d-canvas"></canvas>
      <div id="c3d-hint">drag to rotate · scroll to zoom</div>
    </div>
    <div id="c3d-controls">
      <div class="c3d-row">
        <button class="c3d-btn" id="c3d-pick-btn">🎯 Pick guess swatches</button>
        <button class="c3d-btn c3d-danger" id="c3d-clear-btn">Clear</button>
      </div>
      <div class="c3d-row">
        <input class="c3d-input" id="c3d-manual-input" placeholder="Violet #a83c5e or 168,60,94 Violet" />
        <button class="c3d-btn" id="c3d-manual-add" style="flex:0 0 auto;">Add</button>
      </div>
      <div id="c3d-status"></div>
    </div>
    <div id="c3d-list-wrap">
      <h2>Captured colors</h2>
      <ul id="c3d-list"></ul>
      <div id="c3d-empty">No guesses captured yet. Click "Pick guess swatches" and select one of your color guesses on the page, or add colors manually above.</div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  const closeBtn = panel.querySelector("#c3d-close-btn");
  const pickBtn = panel.querySelector("#c3d-pick-btn");
  const clearBtn = panel.querySelector("#c3d-clear-btn");
  const manualInput = panel.querySelector("#c3d-manual-input");
  const manualAdd = panel.querySelector("#c3d-manual-add");
  const statusEl = panel.querySelector("#c3d-status");
  const listEl = panel.querySelector("#c3d-list");
  const emptyEl = panel.querySelector("#c3d-empty");
  const canvasWrap = panel.querySelector("#c3d-canvas-wrap");
  const canvas = panel.querySelector("#c3d-canvas");

  toggleBtn.addEventListener("click", () => {
    panelOpen = !panelOpen;
    panel.classList.toggle("c3d-open", panelOpen);
    if (panelOpen) {
      resizeCanvas();
      requestFrame();
    } else if (picking) {
      stopPicking();
    }
  });
  closeBtn.addEventListener("click", () => {
    panelOpen = false;
    panel.classList.remove("c3d-open");
    if (picking) stopPicking();
  });
  pickBtn.addEventListener("click", () => {
    if (picking) stopPicking();
    else startPicking();
  });
  clearBtn.addEventListener("click", () => {
    // Blacklist every key we currently have so a rescan of still-visible
    // page elements doesn't silently bring them back.
    for (const key of guessMap.keys()) removedKeys.add(key);
    guessMap = new Map();
    save();
    renderList();
    requestFrame();
    setStatus("Cleared captured guesses.", false);
  });
  manualAdd.addEventListener("click", addManual);
  manualInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addManual();
  });
  function addManual() {
    const val = manualInput.value.trim();
    if (!val) return;
    let c = null;
    let name = null;
    const hexMatch = val.match(/#([0-9a-f]{6})\b/i) || val.match(/\b([0-9a-f]{6})\b/i);
    const rgbMatch = val.match(/(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/);
    if (hexMatch) {
      c = parseCssColor(hexMatch[0]);
      name = val.slice(0, hexMatch.index) + val.slice(hexMatch.index + hexMatch[0].length);
    } else if (rgbMatch) {
      c = { r: clamp255(+rgbMatch[1]), g: clamp255(+rgbMatch[2]), b: clamp255(+rgbMatch[3]) };
      name = val.slice(0, rgbMatch.index) + val.slice(rgbMatch.index + rgbMatch[0].length);
    }
    if (!c) {
      setStatus("Couldn't parse that color. Try #a83c5e or 168,60,94 (optionally with a name).", false);
      return;
    }
    name = name.replace(/^[\s,-]+|[\s,-]+$/g, "").trim();
    c.name = name || null;
    const key = `m:${manualCounter++}`;
    guessMap.set(key, c);
    save();
    renderList();
    requestFrame();
    manualInput.value = "";
    setStatus("Added manually.", false);
  }
  function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }

  function renderList() {
    listEl.innerHTML = "";
    const list = currentGuesses();
    emptyEl.style.display = list.length ? "none" : "block";
    list.forEach(({ key, c }, i) => {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "c3d-dot";
      dot.style.background = `rgb(${c.r},${c.g},${c.b})`;
      const txt = document.createElement("span");
      txt.className = "c3d-rgb-text";
      const label = c.name ? `${c.name} — ` : "";
      txt.textContent = `#${i + 1}  ${label}rgb(${c.r}, ${c.g}, ${c.b})`;
      const rm = document.createElement("button");
      rm.className = "c3d-remove";
      rm.textContent = "×";
      rm.title = "Remove";
      rm.addEventListener("click", () => {
        removedKeys.add(key);
        guessMap.delete(key);
        save();
        renderList();
        requestFrame();
      });
      li.appendChild(dot);
      li.appendChild(txt);
      li.appendChild(rm);
      listEl.appendChild(li);
    });
  }

  // ---------- lightweight 3D engine (no external deps) ----------
  const ctx = canvas.getContext("2d");
  const view = { yaw: 0.6, pitch: -0.35, zoom: 1, baseScale: 1 };
  let dragging = false, lastX = 0, lastY = 0;
  let needsFrame = false;

  function resizeCanvas() {
    const rect = canvasWrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.baseScale = Math.min(rect.width, rect.height) * 0.34;
  }

  canvasWrap.addEventListener("mousedown", (e) => {
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    canvasWrap.classList.add("c3d-dragging");
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    canvasWrap.classList.remove("c3d-dragging");
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    view.yaw += dx * 0.007;
    view.pitch -= dy * 0.007;
    view.pitch = Math.max(-1.45, Math.min(1.45, view.pitch));
    requestFrame();
  });
  canvasWrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.zoom *= 1 - e.deltaY * 0.001;
    view.zoom = Math.max(0.4, Math.min(3.2, view.zoom));
    requestFrame();
  }, { passive: false });

  // touch support
  let touchLast = null, pinchDist = null;
  canvasWrap.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      touchLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      pinchDist = touchDist(e.touches);
    }
  }, { passive: true });
  canvasWrap.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1 && touchLast) {
      const dx = e.touches[0].clientX - touchLast.x;
      const dy = e.touches[0].clientY - touchLast.y;
      touchLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      view.yaw += dx * 0.007;
      view.pitch -= dy * 0.007;
      view.pitch = Math.max(-1.45, Math.min(1.45, view.pitch));
      requestFrame();
    } else if (e.touches.length === 2 && pinchDist) {
      const d = touchDist(e.touches);
      view.zoom *= d / pinchDist;
      view.zoom = Math.max(0.4, Math.min(3.2, view.zoom));
      pinchDist = d;
      requestFrame();
    }
    e.preventDefault();
  }, { passive: false });
  function touchDist(t) {
    const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  window.addEventListener("resize", () => { resizeCanvas(); requestFrame(); });

  function project(x, y, z) {
    // center coords around 0, cube spans -127.5..127.5
    const cosY = Math.cos(view.yaw), sinY = Math.sin(view.yaw);
    let x1 = x * cosY - z * sinY;
    let z1 = x * sinY + z * cosY;
    const cosX = Math.cos(view.pitch), sinX = Math.sin(view.pitch);
    let y1 = y * cosX - z1 * sinX;
    let z2 = y * sinX + z1 * cosX;
    // Fixed perspective distance (fixed "field of view") so rotation never
    // warps. Zoom is applied afterward as a plain uniform scale multiplier,
    // like a camera dolly/lens zoom rather than moving the vanishing point.
    const distance = 620;
    const perspective = distance / (distance + z2);
    const scale = perspective * view.zoom;
    const sx = x1 * scale * view.baseScale / 127.5 + canvas.clientWidth / 2;
    const sy = -y1 * scale * view.baseScale / 127.5 + canvas.clientHeight / 2;
    return { x: sx, y: sy, scale, z: z2 };
  }

  function cubeCorner(rx, gy, bz) {
    return [rx ? 127.5 : -127.5, gy ? 127.5 : -127.5, bz ? 127.5 : -127.5];
  }

  const EDGES = [
    [0,0,0,1,0,0],[0,0,0,0,1,0],[0,0,0,0,0,1],
    [1,0,0,1,1,0],[1,0,0,1,0,1],
    [0,1,0,1,1,0],[0,1,0,0,1,1],
    [0,0,1,1,0,1],[0,0,1,0,1,1],
    [1,1,0,1,1,1],[1,0,1,1,1,1],[0,1,1,1,1,1],
  ];

  function draw() {
    needsFrame = false;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // draw cube edges
    ctx.lineWidth = 1;
    EDGES.forEach(([ax,ay,az,bx,by,bz]) => {
      const A = cubeCorner(ax,ay,az), B = cubeCorner(bx,by,bz);
      const pa = project(...A), pb = project(...B);
      ctx.strokeStyle = "rgba(140,140,165,0.35)";
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    });

    // draw axes from origin (min corner) with color + label
    const axes = [
      { to: [127.5, -127.5, -127.5], color: "#ff5b5b", label: "R" },
      { to: [-127.5, 127.5, -127.5], color: "#57d97e", label: "G" },
      { to: [-127.5, -127.5, 127.5], color: "#5b9bff", label: "B" },
    ];
    const origin = [-127.5, -127.5, -127.5];
    const pOrigin = project(...origin);
    axes.forEach((ax) => {
      const p = project(...ax.to);
      ctx.strokeStyle = ax.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pOrigin.x, pOrigin.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.fillStyle = ax.color;
      ctx.font = "bold 13px sans-serif";
      ctx.fillText(ax.label, p.x + 6, p.y + 4);
    });

    // draw guess spheres, sorted by depth (far first)
    const pts = currentGuesses().map(({ c }) => {
      const x = c.r - 127.5, y = c.g - 127.5, z = c.b - 127.5;
      const p = project(x, y, z);
      return { p, c };
    });
    pts.sort((a, b) => a.p.z - b.p.z);

    pts.forEach(({ p, c }) => {
      const radius = Math.max(2.5, 9 * p.scale);
      const grad = ctx.createRadialGradient(
        p.x - radius * 0.35, p.y - radius * 0.35, radius * 0.15,
        p.x, p.y, radius
      );
      const lighten = (v) => Math.min(255, v + (255 - v) * 0.55);
      grad.addColorStop(0, `rgb(${lighten(c.r)|0},${lighten(c.g)|0},${lighten(c.b)|0})`);
      grad.addColorStop(1, `rgb(${c.r},${c.g},${c.b})`);
      ctx.beginPath();
      ctx.fillStyle = grad;
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.stroke();
    });
  }

  function requestFrame() {
    if (needsFrame) return;
    needsFrame = true;
    requestAnimationFrame(draw);
  }

  // ---------- init ----------
  load(() => {
    renderList();
    if (signature) {
      scanForGuesses();
      startObserving();
      setStatus(`Tracking swatches like <${signature.tag}${signature.classes.length ? "." + signature.classes.join(".") : ""}>`, false);
    }
    resizeCanvas();
    requestFrame();
  });
})();

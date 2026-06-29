/* =========================================================
   FLOOR PLAN DESIGNER
   A lightweight, single-file-app, canvas-based room/furniture
   planner. No build step, no framework — plain JS + Canvas2D.
   ========================================================= */

// ---------- STATE ----------
const state = {
  scalePxPerMeter: null,      // calibrated scale
  bgImage: null,               // Image object for traced floor plan
  bgImageVisible: true,
  rooms: [],                   // {id, name, x, y, w, h, color}  (x,y,w,h in meters)
  furnitureCatalog: [],        // {id, name, w, h, color}
  placedFurniture: [],         // {id, catalogId, name, w, h, color, x, y, rotation}
  selectedId: null,            // id of selected room or furniture (placed)
  selectedType: null,          // 'room' | 'furniture'
  multiSelection: new Set(),   // Set of placed furniture IDs (multi-select)
  tool: 'select',              // 'select' | 'room'
  zoom: 1,
  gridVisible: true,
  snapEnabled: true,
  snapStep: 0.1,               // meters
  nextIds: { room: 1, catalog: 1, placed: 1 },
};

// canvas world: 1 meter = state.scalePxPerMeter px, at zoom=1
const BASE_PX_PER_METER = 60; // used until user calibrates a real scale
const CANVAS_MARGIN_M = 1.5;  // padding around content in meters

function pxPerMeter() {
  return (state.scalePxPerMeter || BASE_PX_PER_METER) * state.zoom;
}

// ---------- DOM ----------
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const canvasScroll = document.getElementById('canvas-scroll');

const roomList = document.getElementById('room-list');
const catalogList = document.getElementById('furniture-catalog-list');
const inspectorEmpty = document.getElementById('inspector-empty');
const inspectorContent = document.getElementById('inspector-content');
const legendPreview = document.getElementById('legend-preview');
const coordText = document.getElementById('coord-text');
const scaleValueEl = document.getElementById('scale-value');
const zoomLevelEl = document.getElementById('zoom-level');
const toastEl = document.getElementById('toast');

// ---------- UTIL ----------
function uid(kind) {
  return kind + '_' + (state.nextIds[kind]++);
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function snap(v) {
  if (!state.snapEnabled) return Math.round(v * 100) / 100;
  return Math.round(v / state.snapStep) * state.snapStep;
}

function fmt(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

// ---------- UNITS ----------
// Internal storage is always meters. These helpers convert for display/input.
const UNITS = {
  main: 'm',   // 'm' or 'ft'
};

function metersToDisplay(m) {
  return UNITS.main === 'ft' ? m / 0.3048 : m;
}
function displayToMeters(v) {
  return UNITS.main === 'ft' ? v * 0.3048 : v;
}
// Small dimensions (furniture) show in cm when metric, inches when imperial
function metersToSmall(m) {
  return UNITS.main === 'ft' ? m / 0.0254 : m * 100;
}
function smallToMeters(v) {
  return UNITS.main === 'ft' ? v * 0.0254 : v / 100;
}
function unitLabel() { return UNITS.main; }
function smallUnitLabel() { return UNITS.main === 'ft' ? 'in' : 'cm'; }
function fmtU(m) { return fmt(metersToDisplay(m)); }
function fmtS(m) { return fmt(metersToSmall(m)); }

// ---------- UNDO ----------
const undoStack = [];
const UNDO_LIMIT = 60;

function snapshotState() {
  undoStack.push(JSON.stringify({
    rooms: state.rooms,
    furnitureCatalog: state.furnitureCatalog,
    placedFurniture: state.placedFurniture,
    scalePxPerMeter: state.scalePxPerMeter,
    nextIds: state.nextIds,
    multiSelection: [...state.multiSelection],
  }));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo() {
  if (!undoStack.length) { showToast('Nothing to undo'); return; }
  const snap = JSON.parse(undoStack.pop());
  state.rooms = snap.rooms;
  state.furnitureCatalog = snap.furnitureCatalog;
  state.placedFurniture = snap.placedFurniture;
  state.scalePxPerMeter = snap.scalePxPerMeter;
  state.nextIds = snap.nextIds;
  state.multiSelection = new Set(snap.multiSelection || []);
  if (state.selectedType === 'room' && !state.rooms.find(r => r.id === state.selectedId)) selectItem(null, null);
  if (state.selectedType === 'furniture' && !state.placedFurniture.find(f => f.id === state.selectedId)) selectItem(null, null);
  inspectorBuiltKey = null;
  syncRoomList();
  syncCatalogList();
  syncLegendPreview();
  updateInspector();
  render();
  showToast('Undone');
}

function findRoom(id) { return state.rooms.find(r => r.id === id); }
function findCatalog(id) { return state.furnitureCatalog.find(f => f.id === id); }
function findPlaced(id) { return state.placedFurniture.find(f => f.id === id); }

// content bounds across rooms + furniture, in meters
function contentBoundsMeters() {
  let minX = 0, minY = 0, maxX = 6, maxY = 5; // sensible default canvas size
  const all = [...state.rooms, ...state.placedFurniture];
  if (all.length) {
    minX = Math.min(...all.map(o => o.x));
    minY = Math.min(...all.map(o => o.y));
    maxX = Math.max(...all.map(o => o.x + o.w));
    maxY = Math.max(...all.map(o => o.y + o.h));
  }
  if (state.bgImage && state.scalePxPerMeter) {
    maxX = Math.max(maxX, state.bgImage.width / state.scalePxPerMeter);
    maxY = Math.max(maxY, state.bgImage.height / state.scalePxPerMeter);
  }
  return {
    minX: Math.min(0, minX) - CANVAS_MARGIN_M,
    minY: Math.min(0, minY) - CANVAS_MARGIN_M,
    maxX: maxX + CANVAS_MARGIN_M,
    maxY: maxY + CANVAS_MARGIN_M,
  };
}

// ---------- CANVAS SIZING ----------
function resizeCanvas() {
  const b = contentBoundsMeters();
  const widthM = b.maxX - b.minX;
  const heightM = b.maxY - b.minY;
  const ppm = pxPerMeter();
  const dpr = window.devicePixelRatio || 1;

  canvas.style.width = (widthM * ppm) + 'px';
  canvas.style.height = (heightM * ppm) + 'px';
  canvas.width = Math.round(widthM * ppm * dpr);
  canvas.height = Math.round(heightM * ppm * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  canvas._originX = b.minX;
  canvas._originY = b.minY;
}

function worldToCanvas(xm, ym) {
  const ppm = pxPerMeter();
  return {
    x: (xm - canvas._originX) * ppm,
    y: (ym - canvas._originY) * ppm,
  };
}
function canvasToWorld(px, py) {
  const ppm = pxPerMeter();
  return {
    x: canvas._originX + px / ppm,
    y: canvas._originY + py / ppm,
  };
}

// ---------- RENDERING ----------
function render() {
  resizeCanvas();
  const ppm = pxPerMeter();
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);

  ctx.clearRect(0, 0, w, h);

  // paper background
  ctx.fillStyle = '#FAF8F2';
  ctx.fillRect(0, 0, w, h);

  // grid
  if (state.gridVisible) {
    drawGrid(w, h, ppm);
  }

  // background floor plan image
  if (state.bgImage && state.bgImageVisible && state.scalePxPerMeter) {
    const widthM = state.bgImage.width / state.scalePxPerMeter;
    const heightM = state.bgImage.height / state.scalePxPerMeter;
    const origin = worldToCanvas(0, 0);
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.drawImage(state.bgImage, origin.x, origin.y, widthM * ppm, heightM * ppm);
    ctx.restore();
  }

  // rooms
  state.rooms.forEach(r => drawRoom(r, ppm));

  // furniture
  state.placedFurniture.forEach(f => drawFurniture(f, ppm));

  // scale calibration overlay points
  if (calibration.active) {
    drawCalibrationPoints();
  }

  // scale ruler (signature element, bottom-right of canvas)
  drawScaleRuler(w, h, ppm);

  // Trigger autosave after every render (debounced — only writes after 1s quiet)
  if (typeof autosave === 'function') autosave();

  // Multi-select badge in toolbar
  const badge = document.getElementById('multi-badge');
  if (badge) {
    if (state.multiSelection.size > 1) {
      badge.style.display = 'inline-block';
      badge.textContent = state.multiSelection.size + ' selected';
    } else {
      badge.style.display = 'none';
    }
  }

  // Focus mode: dim everything outside the selected room
  if (typeof focusState !== 'undefined' && focusState.active && focusState.roomId) {
    applyFocusDim();
  }
}

function drawGrid(w, h, ppm) {
  ctx.save();
  ctx.strokeStyle = 'rgba(139,131,120,0.18)';
  ctx.lineWidth = 1;
  const step = ppm; // 1 meter grid
  const offX = -((canvas._originX % 1) * ppm);
  const offY = -((canvas._originY % 1) * ppm);
  for (let x = offX; x < w; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = offY; y < h; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  // origin axes a bit stronger
  const origin = worldToCanvas(0, 0);
  ctx.strokeStyle = 'rgba(139,131,120,0.35)';
  ctx.beginPath(); ctx.moveTo(origin.x, 0); ctx.lineTo(origin.x, h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, origin.y); ctx.lineTo(w, origin.y); ctx.stroke();
  ctx.restore();
}

function drawRoom(r, ppm) {
  const selected = state.selectedType === 'room' && state.selectedId === r.id;

  if (r.vertices && r.vertices.length >= 3) {
    // ---- polygon room ----
    const pts = r.vertices.map(v => worldToCanvas(v.x, v.y));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(r.color, 0.16);
    ctx.fill();
    ctx.strokeStyle = selected ? '#C9622A' : r.color;
    ctx.lineWidth = selected ? 2.5 : 1.8;
    ctx.stroke();
    ctx.restore();

    // label at centroid
    const cxL = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cyL = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    ctx.fillStyle = '#1B2A41';
    ctx.font = '600 13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(r.name, cxL, cyL - 8);
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.fillStyle = '#6B6259';
    ctx.fillText(fmt(polygonArea(r.vertices)) + ' m²', cxL, cyL + 8);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    if (selected) {
      // vertex handles
      pts.forEach((p, i) => {
        const isActive = drag.mode === 'move-vertex' && drag.vertexIndex === i && drag.origItem && drag.origItem.id === r.id;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = isActive ? '#C9622A' : '#FAF8F2';
        ctx.fill();
        ctx.strokeStyle = '#C9622A';
        ctx.lineWidth = 2;
        ctx.stroke();
      });
      // edge midpoint handles
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.beginPath();
        ctx.arc(mx, my, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(201,98,42,0.35)';
        ctx.fill();
        ctx.strokeStyle = '#C9622A';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  } else {
    // ---- legacy rectangle room ----
    const p = worldToCanvas(r.x, r.y);
    const wPx = r.w * ppm;
    const hPx = r.h * ppm;
    const scaled = { ...r, w: wPx, h: hPx, notchW: (r.notchW || r.w / 2) * ppm, notchH: (r.notchH || r.h / 2) * ppm };

    ctx.save();
    ctx.translate(p.x, p.y);
    tracePath(ctx, scaled);
    ctx.fillStyle = hexToRgba(r.color, 0.16);
    ctx.fill();
    ctx.strokeStyle = selected ? '#C9622A' : r.color;
    ctx.lineWidth = selected ? 2.5 : 1.8;
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#1B2A41';
    ctx.font = '600 13px Inter, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(r.name, p.x + 8, p.y + 6);
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.fillStyle = '#6B6259';
    ctx.fillText(fmtU(r.w) + ' × ' + fmtU(r.h) + ' ' + unitLabel(), p.x + 8, p.y + 23);

    if (selected) {
      ctx.fillStyle = '#C9622A';
      ctx.fillRect(p.x + wPx - 9, p.y + hPx - 9, 9, 9);
    }
  }
}

function drawFurniture(f, ppm) {
  const p = worldToCanvas(f.x, f.y);
  const wPx = f.w * ppm;
  const hPx = f.h * ppm;
  const selected = state.selectedType === 'furniture' && state.selectedId === f.id;
  const multiSelected = state.multiSelection.has(f.id);
  const cx = p.x + wPx / 2;
  const cy = p.y + hPx / 2;
  const scaled = { ...f, w: wPx, h: hPx, notchW: (f.notchW || f.w / 2) * ppm, notchH: (f.notchH || f.h / 2) * ppm };

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((f.rotation || 0) * Math.PI / 180);
  ctx.translate(-wPx / 2, -hPx / 2);

  ctx.fillStyle = hexToRgba(f.color, 0.85);
  ctx.strokeStyle = selected ? '#1B2A41' : multiSelected ? '#4A6FA5' : 'rgba(27,42,65,0.4)';
  ctx.lineWidth = (selected || multiSelected) ? 2.5 : 1.2;
  if (!f.shape || f.shape === 'rect') {
    roundRect(ctx, 0, 0, wPx, hPx, 4);
  } else {
    tracePath(ctx, scaled);
  }
  ctx.fill();
  ctx.stroke();

  // label (only if it fits reasonably)
  if (wPx > 30 && hPx > 16) {
    ctx.fillStyle = '#FAF8F2';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncateLabel(f.name, wPx), wPx / 2, hPx / 2);
  }
  ctx.restore();

  if (selected) {
    const angleRad = -(f.rotation || 0) * Math.PI / 180;
    const handleDist = hPx / 2 + 14;
    const hx = cx - Math.sin(angleRad) * handleDist;
    const hy = cy - Math.cos(angleRad) * handleDist;
    const stemEndX = cx - Math.sin(angleRad) * (hPx / 2);
    const stemEndY = cy - Math.cos(angleRad) * (hPx / 2);

    ctx.save();
    ctx.strokeStyle = '#1B2A41';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(stemEndX, stemEndY);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.fillStyle = '#1B2A41';
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function truncateLabel(text, maxWidthPx) {
  const maxChars = Math.max(3, Math.floor(maxWidthPx / 7));
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}

/* ---------------------------------------------------------
   SHAPE GEOMETRY
   Every room/furniture item has a `shape` field:
     'rect'     - plain rectangle, w x h
     'circle'   - inscribed in the w x h box (w should equal h; UI enforces this as diameter)
     'triangle' - right triangle within the w x h box (right angle at bottom-left)
     'lshape'   - rectangle w x h with a rectangular notch cut from the
                  top-right corner, sized notchW x notchH
   All shapes are defined in LOCAL space: (0,0) top-left to (w,h) bottom-right,
   pre-rotation. This local polygon is reused for drawing, hit-testing, and PDF export.
   --------------------------------------------------------- */

function defaultNotch(w, h) {
  return { notchW: w / 2, notchH: h / 2 };
}

// Returns an array of {x,y} points in local space (0,0)-(w,h), or null for circle (handled separately).
function shapePolygon(item) {
  const w = item.w, h = item.h;
  switch (item.shape) {
    case 'triangle':
      return [{ x: 0, y: h }, { x: w, y: h }, { x: 0, y: 0 }];
    case 'lshape': {
      const nw = clampNotch(item.notchW, w);
      const nh = clampNotch(item.notchH, h);
      return [
        { x: 0, y: 0 }, { x: w - nw, y: 0 }, { x: w - nw, y: nh },
        { x: w, y: nh }, { x: w, y: h }, { x: 0, y: h },
      ];
    }
    case 'circle':
      return null; // handled via ellipse, not polygon
    case 'rect':
    default:
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  }
}

function clampNotch(n, full) {
  const v = (typeof n === 'number' && n > 0) ? n : full / 2;
  return Math.min(v, full - 0.02);
}

function shapeArea(item) {
  const w = item.w, h = item.h;
  switch (item.shape) {
    case 'triangle': return (w * h) / 2;
    case 'circle': return Math.PI * (w / 2) * (h / 2);
    case 'lshape': {
      const nw = clampNotch(item.notchW, w);
      const nh = clampNotch(item.notchH, h);
      return w * h - nw * nh;
    }
    case 'rect':
    default: return w * h;
  }
}

// builds the ctx path for the item's shape, in local (0,0)-(w,h) space.
// caller is responsible for ctx.save()/translate()/rotate() beforehand and stroke/fill+restore after.
function tracePath(ctx, item) {
  if (item.shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(item.w / 2, item.h / 2, item.w / 2, item.h / 2, 0, 0, Math.PI * 2);
    return;
  }
  if (item.shape === 'rect' || !item.shape) {
    // rounded rect for furniture-style softness; rooms call strokeRect-equivalent via plain rect
    ctx.beginPath();
    ctx.rect(0, 0, item.w, item.h);
    return;
  }
  const pts = shapePolygon(item);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

// point-in-shape test, xm/ym already transformed into the item's LOCAL unrotated space
function pointInShapeLocal(lx, ly, item) {
  if (item.shape === 'circle') {
    const rx = item.w / 2, ry = item.h / 2;
    const dx = (lx - rx) / rx, dy = (ly - ry) / ry;
    return dx * dx + dy * dy <= 1;
  }
  const pts = shapePolygon(item) || [{ x: 0, y: 0 }, { x: item.w, y: 0 }, { x: item.w, y: item.h }, { x: 0, y: item.h }];
  return pointInPolygon(lx, ly, pts);
}

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawScaleRuler(w, h, ppm) {
  // shows a 1m reference bar, bottom-right corner of canvas
  const barLen = UNITS.main === 'ft' ? ppm * 0.3048 : ppm;
  const x0 = w - barLen - 24;
  const y0 = h - 28;
  ctx.save();
  ctx.strokeStyle = '#1B2A41';
  ctx.fillStyle = '#1B2A41';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 + barLen, y0);
  ctx.stroke();
  // end ticks
  [x0, x0 + barLen].forEach(x => {
    ctx.beginPath(); ctx.moveTo(x, y0 - 5); ctx.lineTo(x, y0 + 5); ctx.stroke();
  });
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('1 ' + unitLabel(), x0 + barLen / 2, y0 - 9);
  ctx.restore();
}

function drawCalibrationPoints() {
  calibration.points.forEach((pt) => {
    ctx.save();
    ctx.fillStyle = '#C9622A';
    ctx.beginPath();
    ctx.arc(pt.px, pt.py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FAF8F2';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  });

  // line between the two confirmed points
  if (calibration.points.length === 2) {
    const a = calibration.points[0], b = calibration.points[1];
    ctx.save();
    ctx.strokeStyle = '#C9622A';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(a.px, a.py);
    ctx.lineTo(b.px, b.py);
    ctx.stroke();
    ctx.restore();
  }

  // live preview line from point 1 to mouse (before second point is placed)
  if (calibration.points.length === 1 && calibration.mousePos) {
    const a = calibration.points[0];
    const m = calibration.mousePos;
    ctx.save();
    ctx.strokeStyle = 'rgba(201,98,42,0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(a.px, a.py);
    ctx.lineTo(m.px, m.py);
    ctx.stroke();
    // ghost dot at snapped position
    ctx.fillStyle = 'rgba(201,98,42,0.4)';
    ctx.beginPath();
    ctx.arc(m.px, m.py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/* =========================================================
   HIT TESTING & SELECTION
   ========================================================= */

function hitTestFurniture(xm, ym) {
  // iterate in reverse so top-most (last drawn) wins
  for (let i = state.placedFurniture.length - 1; i >= 0; i--) {
    const f = state.placedFurniture[i];
    if (pointInRotatedRect(xm, ym, f)) return f;
  }
  return null;
}

function pointInRotatedRect(xm, ym, f) {
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  const angle = -(f.rotation || 0) * Math.PI / 180;
  const dx = xm - cx, dy = ym - cy;
  const rx = dx * Math.cos(angle) - dy * Math.sin(angle);
  const ry = dx * Math.sin(angle) + dy * Math.cos(angle);
  // shift from center-relative to top-left-relative local space for shape testing
  const lx = rx + f.w / 2;
  const ly = ry + f.h / 2;
  if (!f.shape || f.shape === 'rect') {
    return lx >= 0 && lx <= f.w && ly >= 0 && ly <= f.h;
  }
  return pointInShapeLocal(lx, ly, f);
}

function hitTestRoom(xm, ym) {
  for (let i = state.rooms.length - 1; i >= 0; i--) {
    const r = state.rooms[i];
    if (r.vertices && r.vertices.length >= 3) {
      if (pointInPolygon(xm, ym, r.vertices)) return r;
    } else {
      const lx = xm - r.x, ly = ym - r.y;
      if (lx < 0 || lx > r.w || ly < 0 || ly > r.h) continue;
      if (!r.shape || r.shape === 'rect') return r;
      if (pointInShapeLocal(lx, ly, r)) return r;
    }
  }
  return null;
}

// hit test vertex handles on selected polygon room
function hitTestRoomVertex(xm, ym) {
  if (state.selectedType !== 'room') return null;
  const r = findRoom(state.selectedId);
  if (!r || !r.vertices) return null;
  const mp = worldToCanvas(xm, ym);
  for (let i = 0; i < r.vertices.length; i++) {
    const vp = worldToCanvas(r.vertices[i].x, r.vertices[i].y);
    if (Math.hypot(mp.x - vp.x, mp.y - vp.y) < 8) return { room: r, index: i };
  }
  return null;
}

// hit test edge midpoint handles on selected polygon room
function hitTestRoomEdgeMid(xm, ym) {
  if (state.selectedType !== 'room') return null;
  const r = findRoom(state.selectedId);
  if (!r || !r.vertices) return null;
  const mp = worldToCanvas(xm, ym);
  for (let i = 0; i < r.vertices.length; i++) {
    const a = r.vertices[i], b = r.vertices[(i + 1) % r.vertices.length];
    const midCanvas = worldToCanvas((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (Math.hypot(mp.x - midCanvas.x, mp.y - midCanvas.y) < 7) return { room: r, edgeIndex: i };
  }
  return null;
}

function hitTestRoomResizeHandle(xm, ym) {
  if (state.selectedType !== 'room') return null;
  const r = findRoom(state.selectedId);
  if (!r || r.vertices) return null; // polygon rooms use vertex handles
  const handlePx = 9;
  const p = worldToCanvas(r.x + r.w, r.y + r.h);
  const mp = worldToCanvas(xm, ym);
  if (Math.abs(mp.x - p.x) < handlePx && Math.abs(mp.y - p.y) < handlePx) return r;
  return null;
}

function hitTestRotateHandle(xm, ym) {
  if (state.selectedType !== 'furniture') return null;
  const f = findPlaced(state.selectedId);
  if (!f) return null;
  const ppm = pxPerMeter();
  const p = worldToCanvas(f.x, f.y);
  const cx = p.x + (f.w * ppm) / 2;
  const cy = p.y + (f.h * ppm) / 2;
  const angleRad = -(f.rotation || 0) * Math.PI / 180;
  const handleDist = (f.h * ppm) / 2 + 14;
  const hx = cx - Math.sin(angleRad) * handleDist;
  const hy = cy - Math.cos(angleRad) * handleDist;
  const mouseCanvas = worldToCanvas(xm, ym);
  return Math.hypot(mouseCanvas.x - hx, mouseCanvas.y - hy) < 8 ? f : null;
}

/* =========================================================
   MOUSE / DRAG INTERACTION
   ========================================================= */

const drag = {
  active: false,
  mode: null,
  startWorld: null,
  origItem: null,
  drawStart: null,
  vertexIndex: -1,
  origVertices: null,
  mouseOffsetX: 0,
  mouseOffsetY: 0,
  // multi-select
  multiOrigPositions: null,  // Map<id, {x,y}> snapshot for group move
  rubberBand: null,          // {x,y,w,h} in world coords while drawing selection box
};

const calibration = {
  active: false,
  points: [],
  mousePos: null,  // tracks live mouse position during capture for preview line
};

canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const world = canvasToWorld(px, py);

  if (calibration.active) {
    let snappedPx = px, snappedPy = py;
    if (state.snapEnabled && calibration.points.length === 1) {
      const a = calibration.points[0];
      const dx = px - a.px;
      const dy = py - a.py;
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      const snappedAngle = Math.round(angle / 15) * 15;
      const dist = Math.hypot(dx, dy);
      const rad = snappedAngle * Math.PI / 180;
      snappedPx = a.px + Math.cos(rad) * dist;
      snappedPy = a.py + Math.sin(rad) * dist;
    }
    calibration.points.push({ px: snappedPx, py: snappedPy });
    updateCalibrationStatus();
    render();
    return;
  }

  if (state.tool === 'room') {
    snapshotState();
    drag.active = true;
    drag.mode = 'draw-room';
    drag.drawStart = { x: snap(world.x), y: snap(world.y) };
    return;
  }

  // select tool: check vertex/edge handles first (polygon rooms only)
  const vertexHit = hitTestRoomVertex(world.x, world.y);
  if (vertexHit) {
    clearMultiSelection();
    snapshotState();
    drag.active = true;
    drag.mode = 'move-vertex';
    drag.origItem = vertexHit.room;
    drag.vertexIndex = vertexHit.index;
    drag.origVertices = vertexHit.room.vertices.map(v => ({ ...v }));
    drag.startWorld = world;
    const vx = vertexHit.room.vertices[vertexHit.index];
    drag.mouseOffsetX = vx.x - world.x;
    drag.mouseOffsetY = vx.y - world.y;
    return;
  }

  const edgeMidHit = hitTestRoomEdgeMid(world.x, world.y);
  if (edgeMidHit) {
    clearMultiSelection();
    const r = edgeMidHit.room;
    const i = edgeMidHit.edgeIndex;
    const a = r.vertices[i], b = r.vertices[(i + 1) % r.vertices.length];
    const newV = { x: snap((a.x + b.x) / 2), y: snap((a.y + b.y) / 2) };
    r.vertices.splice(i + 1, 0, newV);
    snapshotState();
    drag.active = true;
    drag.mode = 'move-vertex';
    drag.origItem = r;
    drag.vertexIndex = i + 1;
    drag.origVertices = r.vertices.map(v => ({ ...v }));
    drag.startWorld = world;
    drag.mouseOffsetX = newV.x - world.x;
    drag.mouseOffsetY = newV.y - world.y;
    render();
    return;
  }

  // check resize handle, rotate handle, then bodies
  const resizeTarget = hitTestRoomResizeHandle(world.x, world.y);
  if (resizeTarget) {
    clearMultiSelection();
    snapshotState();
    drag.active = true;
    drag.mode = 'resize-room';
    drag.origItem = { ...resizeTarget };
    drag.startWorld = world;
    return;
  }

  const rotateTarget = hitTestRotateHandle(world.x, world.y);
  if (rotateTarget) {
    if (state.multiSelection.size <= 1) {
      snapshotState();
      drag.active = true;
      drag.mode = 'rotate-furniture';
      drag.origItem = rotateTarget;
    }
    return;
  }

  const furn = hitTestFurniture(world.x, world.y);
  if (furn) {
    if (e.shiftKey) {
      // Shift+click: toggle this item in/out of multi-selection
      // Clear any single room selection first
      if (state.selectedType === 'room') selectItem(null, null);
      if (state.multiSelection.has(furn.id)) {
        state.multiSelection.delete(furn.id);
        // If only one left, revert to single select
        if (state.multiSelection.size === 1) {
          const lastId = [...state.multiSelection][0];
          state.multiSelection.clear();
          selectItem('furniture', lastId);
        } else if (state.multiSelection.size === 0) {
          selectItem(null, null);
        }
      } else {
        // Add current single-selected item to set first if needed
        if (state.selectedType === 'furniture' && state.selectedId) {
          state.multiSelection.add(state.selectedId);
        }
        state.multiSelection.add(furn.id);
        selectItem(null, null); // clear single selection — multi is active
      }
      render();
      updateMultiInspector();
      return;
    }

    // Normal click — if item already in multi-selection, start group move
    if (state.multiSelection.has(furn.id) && state.multiSelection.size > 1) {
      snapshotState();
      drag.active = true;
      drag.mode = 'move-multi';
      drag.startWorld = { x: world.x, y: world.y };
      // Snapshot all positions
      drag.multiOrigPositions = new Map();
      state.multiSelection.forEach(id => {
        const f2 = findPlaced(id);
        if (f2) drag.multiOrigPositions.set(id, { x: f2.x, y: f2.y });
      });
      return;
    }

    // Normal click on unselected item — single select, clear multi
    clearMultiSelection();
    selectItem('furniture', furn.id);
    snapshotState();
    drag.active = true;
    drag.mode = 'move-furniture';
    drag.origItem = { ...furn };
    drag.startWorld = world;
    drag.mouseOffsetX = furn.x - world.x;
    drag.mouseOffsetY = furn.y - world.y;
    render();
    return;
  }

  const room = hitTestRoom(world.x, world.y);
  if (room) {
    clearMultiSelection();
    selectItem('room', room.id);
    snapshotState();
    drag.active = true;
    drag.mode = 'move-room';
    drag.origItem = { ...room };
    drag.origVertices = room.vertices ? room.vertices.map(v => ({ ...v })) : null;
    drag.startWorld = { x: world.x, y: world.y };
    drag.mouseOffsetX = room.x - world.x;
    drag.mouseOffsetY = room.y - world.y;
    render();
    return;
  }

  // Clicked on empty canvas — start rubber-band selection (or clear selection)
  if (!e.shiftKey) clearMultiSelection();
  selectItem(null, null);
  drag.active = true;
  drag.mode = 'rubber-band';
  drag.drawStart = { x: world.x, y: world.y };
  drag.rubberBand = null;
  render();
});

window.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const world = canvasToWorld(px, py);

  // coord readout (only update if mouse is roughly over canvas area)
  if (px >= 0 && py >= 0) {
    coordText.textContent = `x: ${fmt(world.x)}m   y: ${fmt(world.y)}m`;
  }

  if (calibration.active) {
    const rect = canvas.getBoundingClientRect();
    let livePx = e.clientX - rect.left;
    let livePy = e.clientY - rect.top;
    if (state.snapEnabled && calibration.points.length === 1) {
      const a = calibration.points[0];
      const dx = livePx - a.px;
      const dy = livePy - a.py;
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      const snappedAngle = Math.round(angle / 15) * 15;
      const dist = Math.hypot(dx, dy);
      const rad = snappedAngle * Math.PI / 180;
      livePx = a.px + Math.cos(rad) * dist;
      livePy = a.py + Math.sin(rad) * dist;
    }
    calibration.mousePos = { px: livePx, py: livePy };
    render();
    return;
  }

  if (!drag.active) return;

  if (drag.mode === 'draw-room') {
    render();
    const ppm = pxPerMeter();
    const a = worldToCanvas(drag.drawStart.x, drag.drawStart.y);
    const cur = snap2(world);
    const b = worldToCanvas(cur.x, cur.y);
    ctx.save();
    ctx.strokeStyle = '#C9622A';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.restore();
    return;
  }

  if (drag.mode === 'move-furniture') {
    const f = findPlaced(drag.origItem.id);
    if (!f) return;
    f.x = snap(world.x + drag.mouseOffsetX);
    f.y = snap(world.y + drag.mouseOffsetY);
    render();
    updateInspector();
    return;
  }

  if (drag.mode === 'move-room') {
    const r = findRoom(drag.origItem.id);
    if (!r) return;
    if (r.vertices && drag.origVertices) {
      // polygon: translate all vertices by delta from click point — no anchor jump
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      r.vertices = drag.origVertices.map(v => ({
        x: snap(v.x + dx),
        y: snap(v.y + dy),
      }));
    } else {
      // rect: mouseOffset keeps item anchored to exact click position
      r.x = snap(world.x + drag.mouseOffsetX);
      r.y = snap(world.y + drag.mouseOffsetY);
    }
    render();
    syncRoomList();
    updateInspector();
    return;
  }

  if (drag.mode === 'resize-room') {
    const r = findRoom(drag.origItem.id);
    if (!r) return;
    const newW = Math.max(0.3, snap(world.x - r.x));
    const newH = Math.max(0.3, snap(world.y - r.y));
    r.w = newW;
    r.h = newH;
    render();
    syncRoomList();
    updateInspector();
    return;
  }

  if (drag.mode === 'rotate-furniture') {
    const f = drag.origItem;
    const ppm = pxPerMeter();
    const p = worldToCanvas(f.x, f.y);
    const cx = p.x + (f.w * ppm) / 2;
    const cy = p.y + (f.h * ppm) / 2;
    const mouseCanvas = worldToCanvas(world.x, world.y);
    let angle = (Math.atan2(mouseCanvas.x - cx, -(mouseCanvas.y - cy)) * 180 / Math.PI);
    if (state.snapEnabled) angle = Math.round(angle / 15) * 15;
    f.rotation = (((angle % 360) + 360) % 360);
    render();
    updateInspector();
    return;
  }

  if (drag.mode === 'move-vertex') {
    const r = drag.origItem;
    if (!r || !r.vertices) return;
    r.vertices[drag.vertexIndex] = {
      x: snap(world.x + drag.mouseOffsetX),
      y: snap(world.y + drag.mouseOffsetY),
    };
    render();
    updateInspector();
    return;
  }

  if (drag.mode === 'move-multi') {
    const dx = world.x - drag.startWorld.x;
    const dy = world.y - drag.startWorld.y;
    state.multiSelection.forEach(id => {
      const f = findPlaced(id);
      const orig = drag.multiOrigPositions.get(id);
      if (f && orig) {
        f.x = snap(orig.x + dx);
        f.y = snap(orig.y + dy);
      }
    });
    render();
    return;
  }

  if (drag.mode === 'rubber-band') {
    const x1 = Math.min(drag.drawStart.x, world.x);
    const y1 = Math.min(drag.drawStart.y, world.y);
    const x2 = Math.max(drag.drawStart.x, world.x);
    const y2 = Math.max(drag.drawStart.y, world.y);
    drag.rubberBand = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    render();
    // Draw rubber-band box
    const a = worldToCanvas(x1, y1);
    const b = worldToCanvas(x2, y2);
    ctx.save();
    ctx.strokeStyle = '#4A6FA5';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fillStyle = 'rgba(74,111,165,0.07)';
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
    return;
  }
});

function snap2(world) {
  return { x: snap(world.x), y: snap(world.y) };
}

window.addEventListener('mouseup', (e) => {
  if (drag.mode === 'rubber-band') {
    // Commit rubber-band: select all furniture whose centre falls inside the box
    if (drag.rubberBand && (drag.rubberBand.w > 0.1 || drag.rubberBand.h > 0.1)) {
      const rb = drag.rubberBand;
      const hits = state.placedFurniture.filter(f => {
        const cx = f.x + f.w / 2;
        const cy = f.y + f.h / 2;
        return cx >= rb.x && cx <= rb.x + rb.w && cy >= rb.y && cy <= rb.y + rb.h;
      });
      if (hits.length > 1) {
        state.multiSelection = new Set(hits.map(f => f.id));
        selectItem(null, null);
        updateMultiInspector();
      } else if (hits.length === 1) {
        selectItem('furniture', hits[0].id);
      }
    }
    drag.active = false;
    drag.mode = null;
    drag.rubberBand = null;
    render();
    return;
  }

  if (drag.mode === 'draw-room') {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const world = canvasToWorld(px, py);
    const end = snap2(world);
    const x = Math.min(drag.drawStart.x, end.x);
    const y = Math.min(drag.drawStart.y, end.y);
    const w = Math.abs(end.x - drag.drawStart.x);
    const h = Math.abs(end.y - drag.drawStart.y);
    if (w >= 0.3 && h >= 0.3) {
      const room = {
        id: uid('room'),
        name: `Room ${state.rooms.length + 1}`,
        x, y, w, h,
        shape: 'rect',
        color: roomColors[state.rooms.length % roomColors.length],
      };
      state.rooms.push(room);
      selectItem('room', room.id);
      syncRoomList();
      setTool('select');
    }
    render();
  }
  drag.active = false;
  drag.mode = null;
  drag.origItem = null;
});

const roomColors = ['#5C7A6B', '#4A6FA5', '#A6763F', '#8B5E83', '#C9622A', '#6B6259'];

// ---- Polygon room helpers ----

// Convert rect room to 4-vertex polygon
function roomToVertices(r) {
  return [
    { x: r.x,       y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x,       y: r.y + r.h },
  ];
}

// Shoelace formula — signed area in world meters
function polygonArea(vertices) {
  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

// Double-click: convert rect → polygon, or delete a vertex (min 3)
canvas.addEventListener('dblclick', (e) => {
  if (state.tool !== 'select') return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const world = canvasToWorld(px, py);

  if (state.selectedType !== 'room') return;
  const r = findRoom(state.selectedId);
  if (!r) return;

  if (r.vertices && r.vertices.length >= 3) {
    // check if near a vertex — delete it
    const mp = worldToCanvas(world.x, world.y);
    for (let i = 0; i < r.vertices.length; i++) {
      const vp = worldToCanvas(r.vertices[i].x, r.vertices[i].y);
      if (Math.hypot(mp.x - vp.x, mp.y - vp.y) < 8) {
        if (r.vertices.length > 3) {
          snapshotState();
          r.vertices.splice(i, 1);
          render();
          showToast('Vertex removed');
        } else {
          showToast('Need at least 3 vertices');
        }
        return;
      }
    }
  } else {
    // convert rect to polygon
    snapshotState();
    r.vertices = roomToVertices(r);
    inspectorBuiltKey = null;
    updateInspector();
    render();
    showToast('Room converted — drag corners or midpoints to reshape. Double-click a corner to remove it.');
  }
});

/* =========================================================
   SELECTION & INSPECTOR
   ========================================================= */

function selectItem(type, id) {
  state.selectedType = type;
  state.selectedId = id;
  // Selecting a room or explicit single item clears multi-selection
  if (type === 'room' || (type === 'furniture' && id)) {
    state.multiSelection.clear();
  }
  syncRoomList();
  syncCatalogList();
  updateInspector();
}

// tracks which item is currently built in the DOM, so we only rebuild
// the inspector's HTML when the selection actually changes — never on
// every keystroke, which would steal focus / cursor position mid-edit.
let inspectorBuiltKey = null;

/* =========================================================
   MULTI-SELECT HELPERS
   ========================================================= */

function clearMultiSelection() {
  state.multiSelection.clear();
}

function isMultiSelecting() {
  return state.multiSelection.size > 1;
}

function updateMultiInspector() {
  if (!isMultiSelecting()) return;
  inspectorBuiltKey = null;
  inspectorEmpty.style.display = 'none';
  inspectorContent.style.display = 'block';

  const count = state.multiSelection.size;
  const items = [...state.multiSelection].map(id => findPlaced(id)).filter(Boolean);
  const totalCost = items.reduce((s, f) => {
    const p = typeof itemPriceUsd === 'function' ? itemPriceUsd(f) : null;
    return s + (p || 0);
  }, 0);
  const hasPrice = items.some(f => typeof itemPriceUsd === 'function' && itemPriceUsd(f) != null);

  inspectorContent.innerHTML = `
    <div class="inspector-title">${count} items selected</div>
    <div class="area-readout" style="margin-bottom:10px;">
      ${hasPrice ? 'Combined cost: $' + totalCost.toLocaleString() : 'Select items from the furniture catalog to see costs.'}
    </div>
    <div class="hint" style="margin-bottom:12px;">Drag any selected item to move the group. Shift+click to add or remove items.</div>
    <button class="btn btn-secondary btn-full" id="ms-duplicate" style="margin-bottom:6px;">Duplicate All</button>
    <button class="btn btn-ghost btn-full" id="ms-delete" style="color:var(--danger);">Delete All</button>
  `;

  document.getElementById('ms-duplicate').onclick = () => {
    snapshotState();
    const newIds = [];
    [...state.multiSelection].forEach(id => {
      const f = findPlaced(id);
      if (!f) return;
      const copy = { ...f, id: uid('placed'), x: snap(f.x + 0.3), y: snap(f.y + 0.3) };
      state.placedFurniture.push(copy);
      newIds.push(copy.id);
    });
    state.multiSelection = new Set(newIds);
    render();
    syncLegendPreview();
    updateMultiInspector();
  };

  document.getElementById('ms-delete').onclick = () => {
    snapshotState();
    state.placedFurniture = state.placedFurniture.filter(f => !state.multiSelection.has(f.id));
    clearMultiSelection();
    selectItem(null, null);
    render();
    syncLegendPreview();
  };
}

function updateInspector() {
  if (!state.selectedType) {
    inspectorEmpty.style.display = 'block';
    inspectorContent.style.display = 'none';
    inspectorBuiltKey = null;
    return;
  }
  inspectorEmpty.style.display = 'none';
  inspectorContent.style.display = 'block';

  const key = state.selectedType + ':' + state.selectedId;

  if (state.selectedType === 'room') {
    const r = findRoom(state.selectedId);
    if (!r) { selectItem(null, null); return; }
    if (inspectorBuiltKey !== key) {
      buildRoomInspector(r);
      inspectorBuiltKey = key;
    }
  }

  if (state.selectedType === 'furniture') {
    const f = findPlaced(state.selectedId);
    if (!f) { selectItem(null, null); return; }
    if (inspectorBuiltKey !== key) {
      buildFurnitureInspector(f);
      inspectorBuiltKey = key;
    }
  }
}

function buildRoomInspector(r) {
  const isPoly = !!(r.vertices && r.vertices.length >= 3);
  const areaVal = isPoly ? fmt(polygonArea(r.vertices)) : fmt(shapeArea(r));
  inspectorContent.innerHTML = `
    <div class="inspector-title">Room</div>
    <div class="field-group">
      <label>Name</label>
      <input type="text" id="insp-name" value="${escapeHtml(r.name)}" maxlength="30">
    </div>
    ${!isPoly ? `
    <div class="field-group">
      <label>Width × Length (${unitLabel()})</label>
      <div class="dim-row">
        <input type="number" id="insp-w" value="${fmtU(r.w)}" step="0.05" min="0.1">
        <span class="x-sep">×</span>
        <input type="number" id="insp-h" value="${fmtU(r.h)}" step="0.05" min="0.1">
      </div>
    </div>
    <div class="field-group">
      <label>Position X / Y (${unitLabel()})</label>
      <div class="dim-row">
        <input type="number" id="insp-x" value="${fmtU(r.x)}" step="0.05">
        <span class="x-sep">,</span>
        <input type="number" id="insp-y" value="${fmtU(r.y)}" step="0.05">
      </div>
    </div>` : `
    <div class="hint" style="margin-bottom:10px;">Drag corners to reshape. Click a midpoint dot to add a vertex. Double-click a corner to remove it.</div>
    `}
    <div class="area-readout" id="insp-area">Area: ${areaVal} m²</div>
    <button class="btn btn-ghost btn-full" id="insp-edit-shape" style="margin-bottom:6px;">${isPoly ? 'Reset to Rectangle' : 'Edit Shape'}</button>
    <button class="btn btn-ghost btn-full" id="insp-delete">Delete Room</button>
  `;
  document.getElementById('insp-name').oninput = (e) => {
    r.name = e.target.value || 'Room';
    syncRoomList();
    render();
  };
  if (!isPoly) {
    let _roomInspSnapped = false;
    const _roomSnap = () => { if (!_roomInspSnapped) { snapshotState(); _roomInspSnapped = true; } };
    document.getElementById('insp-w').oninput = (e) => {
      _roomSnap();
      r.w = Math.max(0.1, displayToMeters(parseFloat(e.target.value) || 0.1));
      render(); updateAreaReadout(r); syncRoomList();
    };
    document.getElementById('insp-h').oninput = (e) => {
      _roomSnap();
      r.h = Math.max(0.1, displayToMeters(parseFloat(e.target.value) || 0.1));
      render(); updateAreaReadout(r); syncRoomList();
    };
    document.getElementById('insp-x').oninput = (e) => { _roomSnap(); r.x = displayToMeters(parseFloat(e.target.value) || 0); render(); };
    document.getElementById('insp-y').oninput = (e) => { _roomSnap(); r.y = displayToMeters(parseFloat(e.target.value) || 0); render(); };
  }
  document.getElementById('insp-edit-shape').onclick = () => {
    snapshotState();
    if (r.vertices) {
      delete r.vertices;
    } else {
      r.vertices = roomToVertices(r);
    }
    inspectorBuiltKey = null;
    updateInspector();
    render();
  };
  document.getElementById('insp-delete').onclick = () => { deleteRoom(r.id); };
}

function updateAreaReadout(item) {
  const el = document.getElementById('insp-area');
  if (el) el.textContent = `Area: ${fmt(shapeArea(item))} m²`;
}

function buildFurnitureInspector(f) {
  const shape = f.shape || 'rect';
  const isCircle = shape === 'circle';
  const isLshape = shape === 'lshape';

  inspectorContent.innerHTML = `
    <div class="inspector-title">Furniture</div>
    <div class="field-group">
      <label>Name</label>
      <input type="text" id="insp-name" value="${escapeHtml(f.name)}" maxlength="28">
    </div>
    <div class="field-group">
      <label>Shape</label>
      <select id="insp-shape">
        <option value="rect"${shape==='rect'?' selected':''}>Rectangle</option>
        <option value="circle"${shape==='circle'?' selected':''}>Circle</option>
        <option value="triangle"${shape==='triangle'?' selected':''}>Triangle</option>
        <option value="lshape"${shape==='lshape'?' selected':''}>L-Shape</option>
      </select>
    </div>
    <div class="field-group" id="insp-dims-group" style="${isCircle ? 'display:none' : ''}">
      <label>Width × Length (${smallUnitLabel()})</label>
      <div class="dim-row">
        <input type="number" id="insp-w" value="${fmtS(f.w)}" step="0.5" min="0.1">
        <span class="x-sep">×</span>
        <input type="number" id="insp-h" value="${fmtS(f.h)}" step="0.5" min="0.1">
      </div>
    </div>
    <div class="field-group" id="insp-diameter-group" style="${isCircle ? '' : 'display:none'}">
      <label>Diameter (${smallUnitLabel()})</label>
      <input type="number" id="insp-diameter" value="${fmtS(f.w)}" step="0.5" min="0.1">
    </div>
    <div class="field-group" id="insp-notch-group" style="${isLshape ? '' : 'display:none'}">
      <label>Notch Cut (${smallUnitLabel()}, from top-right)</label>
      <div class="dim-row">
        <input type="number" id="insp-notch-w" value="${fmtS(f.notchW || f.w/2)}" step="0.5" min="0.1">
        <span class="x-sep">×</span>
        <input type="number" id="insp-notch-h" value="${fmtS(f.notchH || f.h/2)}" step="0.5" min="0.1">
      </div>
    </div>
    <div class="field-group">
      <label>Position X / Y (m)</label>
      <div class="dim-row">
        <input type="number" id="insp-x" value="${fmt(f.x)}" step="0.05">
        <span class="x-sep">,</span>
        <input type="number" id="insp-y" value="${fmt(f.y)}" step="0.05">
      </div>
    </div>
    <div class="field-group">
      <label>Rotation (°)</label>
      <input type="number" id="insp-rot" value="${Math.round(f.rotation || 0)}" step="15">
    </div>
    <div class="field-group">
      <label>Color</label>
      <div class="swatch-row" id="insp-swatches"></div>
    </div>
    ${f.affiliate_url ? `<a class="btn btn-view-product-insp btn-full" href="${f.affiliate_url}" target="_blank" rel="noopener noreferrer">View Product on Retailer Site ↗</a>` : ''}
    <button class="btn btn-ghost btn-full" id="insp-delete">Remove from Plan</button>
  `;

  const swatchRow = document.getElementById('insp-swatches');
  furnitureColors.forEach(c => {
    const b = document.createElement('button');
    b.className = 'swatch-btn' + (f.color === c ? ' active' : '');
    b.style.background = c;
    b.onclick = () => {
      f.color = c;
      swatchRow.querySelectorAll('.swatch-btn').forEach(btn => btn.classList.remove('active'));
      b.classList.add('active');
      render(); syncLegendPreview();
    };
    swatchRow.appendChild(b);
  });

  document.getElementById('insp-name').oninput = (e) => { f.name = e.target.value || 'Item'; render(); syncLegendPreview(); };

  document.getElementById('insp-shape').onchange = (e) => {
    f.shape = e.target.value;
    if (f.shape === 'lshape' && (!f.notchW || !f.notchH)) {
      f.notchW = f.w / 2; f.notchH = f.h / 2;
    }
    inspectorBuiltKey = null; // force a full rebuild since the field set changes
    updateInspector();
    render(); syncLegendPreview();
  };

  document.getElementById('insp-x').oninput = (e) => { f.x = parseFloat(e.target.value) || 0; render(); };
  document.getElementById('insp-y').oninput = (e) => { f.y = parseFloat(e.target.value) || 0; render(); };
  document.getElementById('insp-rot').oninput = (e) => { f.rotation = parseFloat(e.target.value) || 0; render(); };
  document.getElementById('insp-delete').onclick = () => { deletePlacedFurniture(f.id); };

  if (isCircle) {
    document.getElementById('insp-diameter').oninput = (e) => {
      _fSnap(); const d = Math.max(0.01, smallToMeters(parseFloat(e.target.value) || 0.01));
      f.w = d; f.h = d;
      render(); syncLegendPreview();
    };
  } else {
    document.getElementById('insp-w').oninput = (e) => { _fSnap(); f.w = Math.max(0.01, smallToMeters(parseFloat(e.target.value) || 0.01)); render(); syncLegendPreview(); };
    document.getElementById('insp-h').oninput = (e) => { _fSnap(); f.h = Math.max(0.01, smallToMeters(parseFloat(e.target.value) || 0.01)); render(); syncLegendPreview(); };
  }

  if (isLshape) {
    document.getElementById('insp-notch-w').oninput = (e) => {
      _fSnap(); f.notchW = Math.max(0.01, smallToMeters(parseFloat(e.target.value) || 0.01));
      render(); syncLegendPreview();
    };
    document.getElementById('insp-notch-h').oninput = (e) => {
      _fSnap(); f.notchH = Math.max(0.01, smallToMeters(parseFloat(e.target.value) || 0.01));
      render(); syncLegendPreview();
    };
  }
}

const furnitureColors = ["#F5F0E8", "#E8E0D0", "#C8BFB0", "#8B8378", "#3D3530", "#1A1A1A", "#D4A96A", "#A6763F", "#7A4E2D", "#5C3D1E", "#B8C9D4", "#4A6FA5", "#2C4A6E", "#5C7A6B", "#3D6B5C", "#2E5545", "#7B9EB0", "#E8C4A0", "#C9855A", "#C9622A", "#A84F1F", "#8B5E83", "#6B3F6B", "#B8956A"];

// Build the left-rail color swatch picker for the Add Furniture form
function buildFnColorSwatches() {
  const wrap = document.getElementById('fn-color-swatches');
  const hidden = document.getElementById('fn-color');
  if (!wrap) return;
  wrap.innerHTML = '';
  furnitureColors.forEach(c => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fn-swatch' + (c === hidden.value ? ' active' : '');
    btn.style.background = c;
    btn.title = c;
    btn.onclick = () => {
      hidden.value = c;
      wrap.querySelectorAll('.fn-swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
    wrap.appendChild(btn);
  });
}


function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function swatchShapeClass(shape) {
  if (shape === 'circle') return 'swatch-circle';
  if (shape === 'triangle') return 'swatch-triangle';
  if (shape === 'lshape') return 'swatch-lshape';
  return '';
}

function dimsLabel(item) {
  if (item.shape === 'circle') return 'Ø' + fmtS(item.w) + smallUnitLabel();
  return fmtS(item.w) + '×' + fmtS(item.h) + smallUnitLabel();
}

function deleteRoom(id) {
  snapshotState();
  state.rooms = state.rooms.filter(r => r.id !== id);
  if (state.selectedType === 'room' && state.selectedId === id) selectItem(null, null);
  syncRoomList();
  render();
}

function deletePlacedFurniture(id) {
  snapshotState();
  state.placedFurniture = state.placedFurniture.filter(f => f.id !== id);
  if (state.selectedType === 'furniture' && state.selectedId === id) selectItem(null, null);
  render();
  syncLegendPreview();
}

/* =========================================================
   LIST SYNC (rooms / catalog / legend)
   ========================================================= */

function syncRoomList() {
  roomList.innerHTML = '';
  document.getElementById('room-hint').style.display = state.rooms.length ? 'none' : 'block';
  state.rooms.forEach(r => {
    const li = document.createElement('li');
    li.className = state.selectedType === 'room' && state.selectedId === r.id ? 'selected' : '';
    li.innerHTML = `
      <span class="item-swatch" style="background:${r.color}"></span>
      <span class="item-name">${escapeHtml(r.name)}</span>
      <span class="item-dims">${r.vertices ? fmt(polygonArea(r.vertices)) + 'm²' : fmtU(r.w)+'×'+fmtU(r.h)+unitLabel()}</span>
      <span class="item-del" title="Delete">×</span>
    `;
    li.querySelector('.item-name').onclick = () => { selectItem('room', r.id); render(); centerOn(r); };
    li.querySelector('.item-dims').onclick = () => { selectItem('room', r.id); render(); centerOn(r); };
    li.onclick = (e) => { if (e.target.classList.contains('item-del')) return; selectItem('room', r.id); render(); };
    li.querySelector('.item-del').onclick = (e) => { e.stopPropagation(); deleteRoom(r.id); };
    roomList.appendChild(li);
  });
}

function centerOn(obj) {
  const ppm = pxPerMeter();
  const p = worldToCanvas(obj.x + obj.w / 2, obj.y + obj.h / 2);
  canvasScroll.scrollTo({
    left: p.x - canvasScroll.clientWidth / 2,
    top: p.y - canvasScroll.clientHeight / 2,
    behavior: 'smooth',
  });
}

function syncCatalogList() {
  catalogList.innerHTML = '';
  state.furnitureCatalog.forEach(f => {
    const li = document.createElement('li');
    li.draggable = true;
    li.innerHTML = `
      <span class="item-swatch ${swatchShapeClass(f.shape)}" style="background:${f.color}; color:${f.color}"></span>
      <span class="item-name">${escapeHtml(f.name)}</span>
      <span class="item-dims">${dimsLabel(f)}</span>
      <span class="item-del" title="Remove from catalog">×</span>
    `;
    li.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', f.id);
      e.dataTransfer.effectAllowed = 'copy';
    };
    li.querySelector('.item-del').onclick = (e) => {
      e.stopPropagation();
      state.furnitureCatalog = state.furnitureCatalog.filter(c => c.id !== f.id);
      syncCatalogList();
    };
    catalogList.appendChild(li);
  });
  if (!state.furnitureCatalog.length) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Add furniture above, then drag items from this list onto the canvas.';
    catalogList.appendChild(hint);
  } else {
    const hint = document.createElement('div');
    hint.className = 'catalog-drag-hint';
    hint.textContent = 'Drag an item onto the canvas to place it.';
    catalogList.insertBefore(hint, catalogList.firstChild);
  }
}

function syncLegendPreview() {
  // Keep cost/room panels live whenever furniture state changes
  if (typeof refreshCostAndRoomPanels === 'function') refreshCostAndRoomPanels();

  if (!state.placedFurniture.length) {
    legendPreview.innerHTML = '<div class="legend-empty">No furniture placed yet.</div>';
    return;
  }
  // group by name+shape+dims+color for a compact legend with counts
  const groups = {};
  state.placedFurniture.forEach(f => {
    const key = `${f.name}|${f.shape}|${fmt(f.w)}|${fmt(f.h)}|${f.color}`;
    if (!groups[key]) groups[key] = { ...f, count: 0 };
    groups[key].count++;
  });
  legendPreview.innerHTML = '';
  Object.values(groups).forEach(g => {
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML = `
      <span class="item-swatch ${swatchShapeClass(g.shape)}" style="background:${g.color}; color:${g.color}"></span>
      <span class="legend-name">${escapeHtml(g.name)}${g.count > 1 ? ` ×${g.count}` : ''}</span>
      <span class="legend-dims">${dimsLabel(g)}</span>
    `;
    legendPreview.appendChild(row);
  });
}

/* =========================================================
   DRAG FROM CATALOG -> CANVAS (drop to place furniture)
   ========================================================= */

canvasScroll.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
canvasScroll.addEventListener('drop', (e) => {
  e.preventDefault();
  const catalogId = e.dataTransfer.getData('text/plain');
  const catItem = findCatalog(catalogId);
  if (!catItem) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const world = canvasToWorld(px, py);
  const placed = {
    id: uid('placed'),
    catalogId: catItem.id,
    name: catItem.name,
    shape: catItem.shape || 'rect',
    w: catItem.w,
    h: catItem.h,
    color: catItem.color,
    x: snap(world.x - catItem.w / 2),
    y: snap(world.y - catItem.h / 2),
    rotation: 0,
    // Carry price data through from catalog so cost panel works
    price: catItem.price || null,
    price_usd: catItem.price_usd || null,
    currency: catItem.currency || null,
    sourceId: catItem.sourceId || null,
    affiliate_url: catItem.affiliate_url || null,
  };
  if (catItem.shape === 'lshape') { placed.notchW = catItem.notchW; placed.notchH = catItem.notchH; }
  snapshotState();
  state.placedFurniture.push(placed);
  selectItem('furniture', placed.id);
  render();
  syncLegendPreview();
  showToast(`Placed "${placed.name}"`);
});

/* =========================================================
   TOOLBAR: tools, rotate, duplicate, delete, grid, snap, zoom
   ========================================================= */

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  canvas.style.cursor = tool === 'room' ? 'crosshair' : 'default';
}
document.getElementById('tool-select').onclick = () => setTool('select');
document.getElementById('tool-room').onclick = () => setTool('room');

document.getElementById('btn-add-room').onclick = () => {
  const room = {
    id: uid('room'),
    name: `Room ${state.rooms.length + 1}`,
    x: 0, y: 0, w: 3, h: 3,
    shape: 'rect',
    color: roomColors[state.rooms.length % roomColors.length],
  };
  // offset new rooms so they don't fully overlap
  room.x = state.rooms.length ? Math.max(...state.rooms.map(r => r.x + r.w)) + 0.5 : 0;
  snapshotState();
  state.rooms.push(room);
  selectItem('room', room.id);
  syncRoomList();
  render();
  centerOn(room);
};

document.getElementById('btn-rotate').onclick = () => {
  if (state.selectedType !== 'furniture') { showToast('Select a furniture item first'); return; }
  const f = findPlaced(state.selectedId);
  if (f) { snapshotState(); f.rotation = ((f.rotation || 0) + 90) % 360; render(); updateInspector(); }
};

document.getElementById('btn-duplicate').onclick = () => {
  if (isMultiSelecting()) {
    snapshotState();
    const newIds = [];
    [...state.multiSelection].forEach(id => {
      const f = findPlaced(id);
      if (!f) return;
      const copy = { ...f, id: uid('placed'), x: snap(f.x + 0.3), y: snap(f.y + 0.3) };
      state.placedFurniture.push(copy);
      newIds.push(copy.id);
    });
    state.multiSelection = new Set(newIds);
    render(); syncLegendPreview(); updateMultiInspector();
    showToast(newIds.length + ' items duplicated');
  } else if (state.selectedType === 'furniture') {
    const f = findPlaced(state.selectedId);
    if (!f) return;
    snapshotState();
    const copy = { ...f, id: uid('placed'), x: snap(f.x + 0.3), y: snap(f.y + 0.3) };
    state.placedFurniture.push(copy);
    selectItem('furniture', copy.id);
    render(); syncLegendPreview();
  } else if (state.selectedType === 'room') {
    const r = findRoom(state.selectedId);
    if (!r) return;
    snapshotState();
    const copy = { ...r, id: uid('room'), name: r.name + ' copy', x: snap(r.x + 0.3), y: snap(r.y + 0.3) };
    state.rooms.push(copy);
    selectItem('room', copy.id);
    syncRoomList(); render();
  } else {
    showToast('Select something to duplicate first');
  }
};

document.getElementById('btn-delete').onclick = () => {
  if (isMultiSelecting()) {
    snapshotState();
    state.placedFurniture = state.placedFurniture.filter(f => !state.multiSelection.has(f.id));
    clearMultiSelection();
    selectItem(null, null);
    render();
    syncLegendPreview();
  } else if (state.selectedType === 'furniture') {
    deletePlacedFurniture(state.selectedId);
  } else if (state.selectedType === 'room') {
    deleteRoom(state.selectedId);
  }
};

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if (e.key === 'Escape' && document.getElementById('modal-share') && document.getElementById('modal-share').classList.contains('open')) {
    document.getElementById('modal-share').classList.remove('open');
    return;
  }
  if (e.key === 'Escape' && (calibration.active || modalScale.classList.contains('open'))) {
    calibration.active = false;
    calibration.points = [];
    captureBanner.classList.remove('visible');
    modalScale.classList.remove('open');
    render();
    return;
  }
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (e.key === 'v' || e.key === 'V') setTool('select');
  if (e.key === 'r' || e.key === 'R') setTool('room');
  if (e.key === 'q' || e.key === 'Q') document.getElementById('btn-rotate').click();
  if (e.key === 'd' || e.key === 'D') document.getElementById('btn-duplicate').click();
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); document.getElementById('btn-delete').click(); }
  if (e.key === 'Escape') { clearMultiSelection(); selectItem(null, null); render(); }
});

document.getElementById('toggle-grid').onchange = (e) => { state.gridVisible = e.target.checked; render(); };
document.getElementById('toggle-snap').onchange = (e) => { state.snapEnabled = e.target.checked; };
document.getElementById('toggle-bg').onchange = (e) => { state.bgImageVisible = e.target.checked; render(); };

document.getElementById('zoom-in').onclick = () => setZoom(state.zoom * 1.2);
document.getElementById('zoom-out').onclick = () => setZoom(state.zoom / 1.2);
canvasScroll.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.08 : 0.93));
}, { passive: false });

function setZoom(z) {
  state.zoom = Math.min(4, Math.max(0.25, z));
  zoomLevelEl.textContent = Math.round(state.zoom * 100) + '%';
  render();
}

/* =========================================================
   FURNITURE CATALOG: add new item
   ========================================================= */

const fnShapeSelect = document.getElementById('fn-shape');
const fnDimsRow = document.getElementById('fn-dims-row');
const fnDimsRowCircle = document.getElementById('fn-dims-row-circle');
const fnNotchRow = document.getElementById('fn-notch-row');
const fnNotchHint = document.getElementById('fn-notch-hint');

fnShapeSelect.onchange = () => {
  const shape = fnShapeSelect.value;
  fnDimsRow.style.display = shape === 'circle' ? 'none' : 'flex';
  fnDimsRowCircle.style.display = shape === 'circle' ? 'flex' : 'none';
  const showNotch = shape === 'lshape';
  fnNotchRow.style.display = showNotch ? 'flex' : 'none';
  fnNotchHint.style.display = showNotch ? 'block' : 'none';
};

document.getElementById('btn-add-furniture').onclick = () => {
  const name = document.getElementById('fn-name').value.trim();
  const shape = fnShapeSelect.value;
  const color = document.getElementById('fn-color').value;
  if (!name) { showToast('Give the item a name'); return; }

  let w, h, notchW, notchH;
  if (shape === 'circle') {
    const d = parseFloat(document.getElementById('fn-diameter').value);
    if (!d || d <= 0) { showToast('Enter a valid diameter'); return; }
    w = smallToMeters(d); h = w;
  } else {
    const wRaw = parseFloat(document.getElementById('fn-width').value);
    const hRaw = parseFloat(document.getElementById('fn-length').value);
    if (!wRaw || !hRaw || wRaw <= 0 || hRaw <= 0) { showToast('Enter valid width and length'); return; }
    w = smallToMeters(wRaw); h = smallToMeters(hRaw);
  }
  if (shape === 'lshape') {
    const nwRaw = parseFloat(document.getElementById('fn-notch-w').value) || 0;
    const nhRaw = parseFloat(document.getElementById('fn-notch-h').value) || 0;
    notchW = nwRaw ? smallToMeters(nwRaw) : w / 2;
    notchH = nhRaw ? smallToMeters(nhRaw) : h / 2;
    if (notchW >= w || notchH >= h) { showToast('Notch must be smaller than the full W × L'); return; }
  }

  const item = { id: uid('catalog'), name, shape, w, h, color };
  if (shape === 'lshape') { item.notchW = notchW; item.notchH = notchH; }
  snapshotState();
  state.furnitureCatalog.push(item);

  document.getElementById('fn-name').value = '';
  document.getElementById('fn-width').value = '';
  document.getElementById('fn-length').value = '';
  document.getElementById('fn-diameter').value = '';
  document.getElementById('fn-notch-w').value = '';
  document.getElementById('fn-notch-h').value = '';
  syncCatalogList();
  showToast(`Added "${name}" to catalog — drag it onto the plan`);
};

/* =========================================================
   SCALE CALIBRATION
   ========================================================= */

const modalScale = document.getElementById('modal-scale');
const scaleDistanceInput = document.getElementById('modal-scale-distance');
const scaleUnitSelect = document.getElementById('modal-scale-unit');
const scaleConfirmBtn = document.getElementById('modal-scale-confirm');
const scalePointsStatus = document.getElementById('scale-points-status');
const captureBanner = document.getElementById('scale-capture-banner');
const capturePointNum = document.getElementById('capture-point-num');

let activeScaleTab = 'manual';

// ----- Tab switching -----
document.getElementById('scale-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.scale-tab');
  if (!tab) return;
  activeScaleTab = tab.dataset.tab;

  document.querySelectorAll('.scale-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === activeScaleTab)
  );
  document.querySelectorAll('.scale-tab-panel').forEach(p =>
    p.style.display = 'none'
  );
  document.getElementById('scale-panel-' + activeScaleTab).style.display = 'block';

  if (activeScaleTab === 'points') {
    calibration.points = [];
    updateCalibrationStatus(); // hides modal, shows banner, activates capture
  } else {
    calibration.active = false;
    calibration.points = [];
    captureBanner.classList.remove('visible');
    render();
  }
  refreshScaleConfirmButton();
});

// ----- Manual px/m tab -----
const manualPxInput = document.getElementById('manual-px-per-meter');
const manualPreview = document.getElementById('manual-scale-preview');

manualPxInput.oninput = () => {
  const v = parseFloat(manualPxInput.value);
  if (v > 0) {
    const ratio = Math.round(96 / 2.54 / v * 100);
    manualPreview.textContent = `≈ 1 : ${ratio} at 96 dpi`;
  } else {
    manualPreview.textContent = '—';
  }
  refreshScaleConfirmButton();
};

// ----- Ratio tab -----
const ratioInput = document.getElementById('ratio-value');
const ratioUnitSelect = document.getElementById('ratio-screen-unit');
const ratioPreview = document.getElementById('ratio-scale-preview');

function ratioToPxPerMeter() {
  const ratio = parseFloat(ratioInput.value);
  if (!ratio || ratio <= 0) return null;
  const screenUnit = ratioUnitSelect.value;
  let screenPxPerUnit;
  if (screenUnit === 'cm') screenPxPerUnit = 96 / 2.54;
  else if (screenUnit === 'mm') screenPxPerUnit = 96 / 25.4;
  else screenPxPerUnit = 96;
  return screenPxPerUnit * ratio;
}

function updateRatioPreview() {
  const ppm = ratioToPxPerMeter();
  ratioPreview.textContent = ppm ? `≈ ${Math.round(ppm)} px per meter` : '—';
  refreshScaleConfirmButton();
}
ratioInput.oninput = updateRatioPreview;
ratioUnitSelect.onchange = updateRatioPreview;

// ----- Two-point tab -----
function updateCalibrationStatus() {
  if (calibration.points.length === 0) {
    modalScale.classList.remove('open');
    calibration.active = true;
    capturePointNum.textContent = '1';
    captureBanner.classList.add('visible');
    if (scalePointsStatus) scalePointsStatus.textContent = 'Step 1: Click the first point on the canvas.';
  } else if (calibration.points.length === 1) {
    capturePointNum.textContent = '2';
    if (scalePointsStatus) scalePointsStatus.textContent = 'Step 2: Click the second point on the canvas.';
  } else {
    captureBanner.classList.remove('visible');
    calibration.active = false;
    modalScale.classList.add('open');
    if (scalePointsStatus) scalePointsStatus.textContent = '✓ Two points set. Enter the real-world distance below.';
  }
  refreshScaleConfirmButton();
  render();
}

// ----- Confirm button state -----
function refreshScaleConfirmButton() {
  let ok = false;
  if (activeScaleTab === 'manual') {
    ok = parseFloat(manualPxInput.value) > 0;
  } else if (activeScaleTab === 'ratio') {
    ok = ratioToPxPerMeter() !== null;
  } else if (activeScaleTab === 'points') {
    ok = calibration.points.length === 2 && parseFloat(scaleDistanceInput.value) > 0;
  }
  scaleConfirmBtn.disabled = !ok;
}
if (scaleDistanceInput) scaleDistanceInput.oninput = () => refreshScaleConfirmButton();

// ----- Open modal -----
document.getElementById('btn-set-scale').onclick = () => {
  calibration.active = false;
  calibration.points = [];
  captureBanner.classList.remove('visible');
  activeScaleTab = 'manual';

  document.querySelectorAll('.scale-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === 'manual')
  );
  document.querySelectorAll('.scale-tab-panel').forEach(p =>
    p.style.display = 'none'
  );
  document.getElementById('scale-panel-manual').style.display = 'block';

  if (state.scalePxPerMeter) {
    manualPxInput.value = Math.round(state.scalePxPerMeter);
    manualPxInput.dispatchEvent(new Event('input'));
  } else {
    manualPxInput.value = '';
    manualPreview.textContent = '—';
  }

  refreshScaleConfirmButton();
  modalScale.classList.add('open');
  setTool('select');
};

// ----- Cancel -----
document.getElementById('modal-scale-cancel').onclick = () => {
  calibration.active = false;
  calibration.points = [];
  captureBanner.classList.remove('visible');
  modalScale.classList.remove('open');
  render();
};

document.getElementById('modal-scale').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    calibration.active = false;
    calibration.points = [];
    captureBanner.classList.remove('visible');
    modalScale.classList.remove('open');
    render();
  }
});

// ----- Apply -----
scaleConfirmBtn.onclick = () => {
  let newPpm = null;

  if (activeScaleTab === 'manual') {
    const v = parseFloat(manualPxInput.value);
    if (v > 0) newPpm = v;

  } else if (activeScaleTab === 'ratio') {
    newPpm = ratioToPxPerMeter();

  } else if (activeScaleTab === 'points') {
    if (calibration.points.length !== 2) return;
    const distInput = parseFloat(scaleDistanceInput.value);
    if (!distInput || distInput <= 0) return;
    const unit = scaleUnitSelect.value;
    const distMeters = unit === 'ft' ? distInput * 0.3048 : distInput;
    const a = calibration.points[0], b = calibration.points[1];
    const pixelDist = Math.hypot(b.px - a.px, b.py - a.py);
    newPpm = (pixelDist / distMeters) / state.zoom;
  }

  if (!newPpm || newPpm <= 0) return;

  state.scalePxPerMeter = newPpm;
  scaleValueEl.textContent = `1m = ${Math.round(state.scalePxPerMeter)}px`;
  calibration.active = false;
  calibration.points = [];
  captureBanner.classList.remove('visible');
  modalScale.classList.remove('open');
  if (scaleDistanceInput) scaleDistanceInput.value = '';
  showToast('Scale updated.');
  render();
};

/* =========================================================
   IMAGE UPLOAD (trace floor plan)
   ========================================================= */

document.getElementById('input-upload-image').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      state.bgImage = img;
      state.bgImageDataUrl = ev.target.result;
      if (!state.scalePxPerMeter) {
        state.scalePxPerMeter = BASE_PX_PER_METER; // placeholder until calibrated
      }
      document.getElementById('toggle-bg-wrap').style.display = 'flex';
      showToast('Floor plan loaded. Click "Set Scale" to calibrate real-world measurements.');
      render();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

/* =========================================================
   PROJECT SAVE / LOAD (JSON)
   ========================================================= */

document.getElementById('btn-save-project').onclick = () => {
  const data = {
    version: 1,
    projectName: document.getElementById('project-name').value.trim(),
    scalePxPerMeter: state.scalePxPerMeter,
    bgImageDataUrl: state.bgImageDataUrl || null,
    rooms: state.rooms,
    furnitureCatalog: state.furnitureCatalog,
    placedFurniture: state.placedFurniture,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const projectName = document.getElementById('project-name').value.trim() || 'floorplan-project';
  const safeName = projectName.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-');
  a.download = safeName + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Project saved');
};

document.getElementById('input-load-project').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      loadProjectData(data);
      showToast('Project loaded');
    } catch (err) {
      showToast('Could not read that file — is it a valid project JSON?');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

function loadProjectData(data) {
  document.getElementById('project-name').value = data.projectName || '';
  state.rooms = data.rooms || [];
  state.furnitureCatalog = data.furnitureCatalog || [];
  state.placedFurniture = data.placedFurniture || [];
  state.scalePxPerMeter = data.scalePxPerMeter || null;
  state.selectedId = null;
  state.selectedType = null;

  // recompute next ids to avoid collisions
  const maxId = (arr, prefix) => arr.reduce((m, o) => {
    const n = parseInt((o.id || '').split('_')[1]) || 0;
    return Math.max(m, n);
  }, 0);
  state.nextIds.room = maxId(state.rooms, 'room') + 1;
  state.nextIds.catalog = maxId(state.furnitureCatalog, 'catalog') + 1;
  state.nextIds.placed = maxId(state.placedFurniture, 'placed') + 1;

  if (data.bgImageDataUrl) {
    const img = new Image();
    img.onload = () => {
      state.bgImage = img;
      state.bgImageDataUrl = data.bgImageDataUrl;
      document.getElementById('toggle-bg-wrap').style.display = 'flex';
      finishLoad();
    };
    img.src = data.bgImageDataUrl;
  } else {
    state.bgImage = null;
    document.getElementById('toggle-bg-wrap').style.display = 'none';
    finishLoad();
  }
}

function finishLoad() {
  scaleValueEl.textContent = state.scalePxPerMeter ? `1m = ${Math.round(state.scalePxPerMeter)}px` : 'not set';
  syncRoomList();
  syncCatalogList();
  syncLegendPreview();
  updateInspector();
  render();
}

/* =========================================================
   SHARE LINK  (URL-hash based, no server needed)
   Plan JSON → compress (DeflateRaw) → base64url → #plan/<hash>
   On load: detect hash → decompress → loadProjectData()
   Note: bgImageDataUrl is stripped — too large for a URL.
   ========================================================= */

// --- Encode ---
async function encodePlanToHash(data) {
  // Strip the floor plan image — it can be hundreds of KB
  const exportData = { ...data, bgImageDataUrl: null };
  const json = JSON.stringify(exportData);
  const bytes = new TextEncoder().encode(json);

  // Compress with built-in CompressionStream (supported in all modern browsers)
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();

  // base64url encode (URL-safe, no padding issues)
  const b64 = btoa(String.fromCharCode(...new Uint8Array(compressed)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// --- Decode ---
async function decodePlanFromHash(hash) {
  // Restore base64url → base64
  const b64 = hash.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));

  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const decompressed = await new Response(ds.readable).arrayBuffer();

  const json = new TextDecoder().decode(decompressed);
  return JSON.parse(json);
}

// --- Build the full share URL ---
async function buildShareUrl() {
  const data = {
    version: 1,
    projectName: document.getElementById('project-name').value.trim(),
    scalePxPerMeter: state.scalePxPerMeter,
    bgImageDataUrl: state.bgImageDataUrl || null,
    rooms: state.rooms,
    furnitureCatalog: state.furnitureCatalog,
    placedFurniture: state.placedFurniture,
  };
  const hash = await encodePlanToHash(data);
  const base = window.location.origin + window.location.pathname;
  return base + '#plan/' + hash;
}

// --- Open share modal ---
const modalShare = document.getElementById('modal-share');
const shareUrlInput = document.getElementById('share-url-input');

document.getElementById('btn-share').onclick = async () => {
  const hasImage = !!state.bgImageDataUrl;
  document.getElementById('share-warning').style.display = hasImage ? 'flex' : 'none';

  // Show modal immediately with a loading state
  shareUrlInput.value = 'Generating link…';
  modalShare.classList.add('open');

  try {
    const url = await buildShareUrl();
    shareUrlInput.value = url;
  } catch (err) {
    shareUrlInput.value = '';
    showToast('Could not generate share link');
    console.error(err);
  }
};

document.getElementById('modal-share-close').onclick = () => modalShare.classList.remove('open');
document.getElementById('modal-share').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) modalShare.classList.remove('open');
});

// --- Copy button ---
document.getElementById('btn-copy-url').onclick = async () => {
  const url = shareUrlInput.value;
  if (!url || url === 'Generating link…') return;
  try {
    await navigator.clipboard.writeText(url);
    const btn = document.getElementById('btn-copy-url');
    const shareBtn = document.getElementById('btn-share');
    btn.textContent = '✓ Copied';
    shareBtn.classList.add('copied');
    shareBtn.textContent = '✓ Link copied';
    setTimeout(() => {
      btn.textContent = 'Copy';
      shareBtn.classList.remove('copied');
      // Restore share button content (has SVG + text)
      shareBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="flex-shrink:0">'
        + '<circle cx="10.5" cy="2.5" r="1.5" stroke="currentColor" stroke-width="1.4"/>'
        + '<circle cx="10.5" cy="10.5" r="1.5" stroke="currentColor" stroke-width="1.4"/>'
        + '<circle cx="2.5" cy="6.5" r="1.5" stroke="currentColor" stroke-width="1.4"/>'
        + '<line x1="3.9" y1="5.7" x2="9.1" y2="3.3" stroke="currentColor" stroke-width="1.4"/>'
        + '<line x1="3.9" y1="7.3" x2="9.1" y2="9.7" stroke="currentColor" stroke-width="1.4"/>'
        + '</svg> Share';
    }, 2500);
  } catch (err) {
    // Clipboard API not available (e.g. non-HTTPS) — select the text instead
    shareUrlInput.select();
    showToast('Press Ctrl/Cmd+C to copy');
  }
};

// Also close share modal on Escape (handled by existing keydown listener)
// — already covered by the general Escape handler in keydown

// --- On page load: check for shared plan in URL hash ---
async function checkUrlHash() {
  const hash = window.location.hash;
  if (!hash.startsWith('#plan/')) return;

  const encoded = hash.slice(6); // strip '#plan/'
  if (!encoded) return;

  try {
    const data = await decodePlanFromHash(encoded);
    loadProjectData(data);
    // Clean up the URL so refreshing doesn't re-trigger the load
    // (use replaceState so Back button still works)
    history.replaceState(null, '', window.location.pathname);
    const name = data.projectName ? ('"' + data.projectName + '"') : 'Shared plan';
    showToast('Loaded ' + name + ' from share link');
  } catch (err) {
    showToast('Could not load plan from link — it may be corrupted or too old');
    console.error('Share link decode error:', err);
    history.replaceState(null, '', window.location.pathname);
  }
}

/* =========================================================
   NEW PROJECT
   ========================================================= */

const modalConfirm = document.getElementById('modal-confirm');
document.getElementById('btn-new-project').onclick = () => {
  modalConfirm.classList.add('open');
};
document.getElementById('modal-confirm-cancel').onclick = () => modalConfirm.classList.remove('open');
document.getElementById('modal-confirm-ok').onclick = () => {
  state.rooms = [];
  state.furnitureCatalog = [];
  state.placedFurniture = [];
  state.bgImage = null;
  state.bgImageDataUrl = null;
  state.scalePxPerMeter = null;
  state.selectedId = null;
  state.selectedType = null;
  state.zoom = 1;
  document.getElementById('toggle-bg-wrap').style.display = 'none';
  scaleValueEl.textContent = 'not set';
  zoomLevelEl.textContent = '100%';
  document.getElementById('project-name').value = '';
  modalConfirm.classList.remove('open');
  clearAutosave(); // wipe saved state so refresh gives a blank canvas
  finishLoad();
  showToast('New project started');
};

/* =========================================================
   PDF EXPORT
   ========================================================= */

const modalExport = document.getElementById('modal-export');

document.getElementById('btn-export-pdf').onclick = () => {
  if (!state.rooms.length && !state.placedFurniture.length) {
    showToast('Add at least one room or furniture item before exporting');
    return;
  }
  modalExport.classList.add('open');
};

document.getElementById('modal-export-cancel').onclick = () => modalExport.classList.remove('open');
document.getElementById('modal-export').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) modalExport.classList.remove('open');
});

document.getElementById('modal-export-confirm').onclick = () => {
  const mode = document.querySelector('input[name="export-mode"]:checked').value;
  modalExport.classList.remove('open');
  try {
    exportPdf(mode);
  } catch (err) {
    console.error('PDF export error:', err);
    showToast('Export failed — check the browser console for details');
  }
};

function exportPdf(mode = 'full') {
  const { jsPDF } = window.jspdf;
  const wasSelected = { type: state.selectedType, id: state.selectedId };
  const wasMulti = state.multiSelection ? new Set(state.multiSelection) : new Set();
  selectItem(null, null);
  if (state.multiSelection) state.multiSelection.clear();
  render();

  const projectName = document.getElementById('project-name').value.trim() || 'Floor Plan';
  const pdfName = projectName.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-') || 'floor-plan';
  const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  if (mode === 'full' || mode === 'both') {
    exportFullPlanPage(pdf, projectName, dateStr);
  }

  if (mode === 'rooms' || mode === 'both') {
    if (state.rooms.length === 0) {
      showToast('No rooms defined — add rooms to use per-room export');
    } else {
      state.rooms.forEach((r, i) => {
        // Add new page unless this is the very first page and full plan wasn't added
        if (mode === 'both' || i > 0) pdf.addPage();
        exportRoomPage(pdf, r, projectName, dateStr);
      });
    }
  }

  pdf.save(pdfName + '.pdf');
  showToast('PDF exported');

  // Restore selection
  if (state.multiSelection !== undefined) state.multiSelection = wasMulti;
  if (wasSelected.type) selectItem(wasSelected.type, wasSelected.id);
  render();
}

/* ---------------------------------------------------------
   PAGE 1: Full plan
   --------------------------------------------------------- */
function exportFullPlanPage(pdf, projectName, dateStr) {
  const pageW = 297, pageH = 210, margin = 10;

  // Title block
  drawPdfHeader(pdf, projectName.toUpperCase(), dateStr, margin, pageW);

  // Plan canvas
  const exportCanvas = buildExportCanvas(null); // null = whole plan
  const planAreaW = pageW - margin * 2 - 78;
  const planAreaH = pageH - 26 - margin;
  const ratio = exportCanvas.width / exportCanvas.height;
  let drawW = planAreaW, drawH = drawW / ratio;
  if (drawH > planAreaH) { drawH = planAreaH; drawW = drawH * ratio; }
  pdf.setDrawColor(216, 210, 194); pdf.setLineWidth(0.3);
  pdf.rect(margin - 1, 25, drawW + 2, drawH + 2);
  pdf.addImage(exportCanvas.toDataURL('image/png'), 'PNG', margin, 26, drawW, drawH);

  // Right legend column
  const legendX = pageW - margin - 72;
  let ly = 26;

  // ROOMS section
  ly = drawPdfSectionHeader(pdf, 'ROOMS', legendX, pageW, margin, ly);
  if (state.rooms.length) {
    state.rooms.forEach(r => {
      if (ly > pageH - margin - 4) return;
      const area = r.vertices ? polygonArea(r.vertices) : r.w * r.h;
      const dimsLine = r.vertices
        ? fmt(area) + ' m²'
        : fmtU(r.w) + ' × ' + fmtU(r.h) + ' ' + unitLabel() + '  (' + fmt(area) + ' m²)';
      const roomCost = getFurnitureForRoom(r.id).reduce((s, f) => s + (itemPriceUsd(f) || 0), 0);
      pdf.setFillColor(...hexToRgbArr(r.color));
      pdf.rect(legendX, ly - 3, 3, 3, 'F');
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(27, 42, 65);
      pdf.text(truncatePdfText(r.name, 24), legendX + 5, ly);
      if (roomCost > 0) {
        pdf.setFont('courier', 'bold'); pdf.setTextColor(201, 98, 42);
        pdf.text('$' + roomCost.toLocaleString(), legendX + 65, ly);
      }
      pdf.setFont('courier', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(120, 120, 120);
      pdf.text(dimsLine, legendX + 5, ly + 3.5);
      ly += 9;
    });
  } else {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(150, 150, 150);
    pdf.text('No rooms defined.', legendX, ly); ly += 8;
  }

  ly += 3;

  // FURNITURE section
  ly = drawPdfSectionHeader(pdf, 'FURNITURE', legendX, pageW, margin, ly);
  const groups = groupFurnitureForLegend(state.placedFurniture);
  if (groups.length) {
    groups.forEach(g => {
      if (ly > pageH - margin - 4) return;
      const priceStr = g.totalUsd > 0 ? '$' + g.totalUsd.toLocaleString() : '';
      pdf.setFillColor(...hexToRgbArr(g.color));
      pdf.rect(legendX, ly - 3, 3, 3, 'F');
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(27, 42, 65);
      const label = g.name + (g.count > 1 ? ' ×' + g.count : '');
      pdf.text(truncatePdfText(label, 24), legendX + 5, ly);
      if (priceStr) {
        pdf.setFont('courier', 'bold'); pdf.setTextColor(201, 98, 42);
        pdf.text(priceStr, legendX + 65, ly);
      }
      pdf.setFont('courier', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(120, 120, 120);
      pdf.text(dimsLabel(g), legendX + 5, ly + 3.5);
      ly += 9;
    });
  } else {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(150, 150, 150);
    pdf.text('No furniture placed.', legendX, ly); ly += 8;
  }

  ly += 3;

  // TOTAL
  const total = totalPlanCostUsd();
  if (total > 0) {
    pdf.setDrawColor(216, 210, 194); pdf.setLineWidth(0.3);
    pdf.line(legendX, ly, legendX + 65, ly);
    ly += 4;
    pdf.setFont('courier', 'bold'); pdf.setFontSize(9); pdf.setTextColor(27, 42, 65);
    pdf.text('TOTAL', legendX, ly);
    pdf.setTextColor(201, 98, 42);
    pdf.text('$' + total.toLocaleString(), legendX + 65, ly);
  }

  drawPdfFooter(pdf, pageW, pageH, margin);
}

/* ---------------------------------------------------------
   PER ROOM PAGE
   --------------------------------------------------------- */
function exportRoomPage(pdf, room, projectName, dateStr) {
  const pageW = 297, pageH = 210, margin = 10;
  const furniture = getFurnitureForRoom(room.id);
  const roomCost = furniture.reduce((s, f) => s + (itemPriceUsd(f) || 0), 0);

  // Header: "PROJECT NAME — ROOM NAME"
  const titleText = (projectName + '  —  ' + room.name).toUpperCase();
  drawPdfHeader(pdf, titleText, dateStr, margin, pageW);

  // Room canvas (cropped + padded to just this room)
  const roomCanvas = buildExportCanvas(room);
  const planAreaW = pageW - margin * 2 - 82;
  const planAreaH = pageH - 26 - margin;
  const ratio = roomCanvas.width / roomCanvas.height;
  let drawW = planAreaW, drawH = drawW / ratio;
  if (drawH > planAreaH) { drawH = planAreaH; drawW = drawH * ratio; }
  pdf.setDrawColor(216, 210, 194); pdf.setLineWidth(0.3);
  pdf.rect(margin - 1, 25, drawW + 2, drawH + 2);
  pdf.addImage(roomCanvas.toDataURL('image/png'), 'PNG', margin, 26, drawW, drawH);

  // Right panel
  const panelX = pageW - margin - 76;
  let ly = 26;

  // Room dimensions
  ly = drawPdfSectionHeader(pdf, 'ROOM', panelX, pageW, margin, ly);
  const area = room.vertices ? polygonArea(room.vertices) : room.w * room.h;
  pdf.setFillColor(...hexToRgbArr(room.color));
  pdf.rect(panelX, ly - 3, 3, 3, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(27, 42, 65);
  pdf.text(truncatePdfText(room.name, 26), panelX + 5, ly);
  ly += 5;
  pdf.setFont('courier', 'normal'); pdf.setFontSize(8); pdf.setTextColor(100, 100, 100);
  if (!room.vertices) {
    pdf.text(fmtU(room.w) + ' × ' + fmtU(room.h) + ' ' + unitLabel(), panelX + 5, ly); ly += 4.5;
  }
  pdf.text('Area: ' + fmt(area) + ' m²', panelX + 5, ly); ly += 9;

  // Furniture in this room
  ly = drawPdfSectionHeader(pdf, 'FURNITURE IN ROOM', panelX, pageW, margin, ly);

  if (furniture.length === 0) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(150, 150, 150);
    pdf.text('No furniture placed in this room.', panelX + 2, ly); ly += 8;
  } else {
    const groups = groupFurnitureForLegend(furniture);
    groups.forEach(g => {
      if (ly > pageH - margin - 18) return;
      pdf.setFillColor(...hexToRgbArr(g.color));
      pdf.rect(panelX, ly - 3, 3, 3, 'F');
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(27, 42, 65);
      const label = g.name + (g.count > 1 ? ' ×' + g.count : '');
      pdf.text(truncatePdfText(label, 22), panelX + 5, ly);
      if (g.totalUsd > 0) {
        pdf.setFont('courier', 'bold'); pdf.setTextColor(201, 98, 42);
        pdf.text('$' + g.totalUsd.toLocaleString(), panelX + 68, ly);
      }
      pdf.setFont('courier', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(120, 120, 120);
      pdf.text(dimsLabel(g), panelX + 5, ly + 3.5);
      ly += 9;
    });
  }

  // Room total
  if (roomCost > 0) {
    ly += 2;
    pdf.setDrawColor(216, 210, 194); pdf.setLineWidth(0.3);
    pdf.line(panelX, ly, panelX + 70, ly); ly += 4;
    pdf.setFont('courier', 'bold'); pdf.setFontSize(9.5); pdf.setTextColor(27, 42, 65);
    pdf.text('ROOM TOTAL', panelX, ly);
    pdf.setTextColor(201, 98, 42);
    pdf.text('$' + roomCost.toLocaleString(), panelX + 68, ly);
  }

  drawPdfFooter(pdf, pageW, pageH, margin);
}

/* ---------------------------------------------------------
   PDF HELPERS
   --------------------------------------------------------- */
function drawPdfHeader(pdf, title, dateStr, margin, pageW) {
  pdf.setFont('courier', 'bold');
  pdf.setFontSize(14);
  pdf.setTextColor(27, 42, 65);
  pdf.text(title, margin, 13);
  pdf.setFont('courier', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(110, 110, 110);
  let scaleNote = '';
  if (state.scalePxPerMeter) {
    const r = Math.round(state.scalePxPerMeter / (96 / 2.54));
    scaleNote = '   •   Scale 1:' + r;
  }
  pdf.text('Generated ' + dateStr + scaleNote, margin, 18.5);
  pdf.setDrawColor(201, 98, 42); pdf.setLineWidth(0.6);
  pdf.line(margin, 21, pageW - margin, 21);
}

function drawPdfSectionHeader(pdf, label, x, pageW, margin, ly) {
  pdf.setFont('courier', 'bold');
  pdf.setFontSize(8.5);
  pdf.setTextColor(139, 131, 120);
  pdf.text(label, x, ly);
  ly += 2.5;
  pdf.setDrawColor(216, 210, 194); pdf.setLineWidth(0.25);
  pdf.line(x, ly, pageW - margin, ly);
  ly += 4;
  return ly;
}

function drawPdfFooter(pdf, pageW, pageH, margin) {
  pdf.setFont('courier', 'normal');
  pdf.setFontSize(7);
  pdf.setTextColor(180, 180, 180);
  pdf.text('Generated with Plan/Scale', margin, pageH - 4);
}

function groupFurnitureForLegend(furnitureList) {
  const groups = {};
  furnitureList.forEach(f => {
    const key = f.sourceId || (f.name + '|' + fmt(f.w) + '|' + fmt(f.h) + '|' + f.color);
    if (!groups[key]) groups[key] = { ...f, count: 0, totalUsd: 0 };
    groups[key].count++;
    groups[key].totalUsd += itemPriceUsd(f) || 0;
  });
  return Object.values(groups);
}

function truncatePdfText(text, maxChars) {
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}

function hexToRgbArr(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

/* ---------------------------------------------------------
   buildExportCanvas(roomFilter)
   roomFilter = null  → render the whole plan
   roomFilter = room  → crop to just that room with padding
   --------------------------------------------------------- */
function buildExportCanvas(roomFilter) {
  let b;
  const exportPpm = 80;

  if (roomFilter) {
    // Crop tightly to the room with 1.2m padding
    const pad = 1.2;
    if (roomFilter.vertices && roomFilter.vertices.length >= 3) {
      const xs = roomFilter.vertices.map(v => v.x);
      const ys = roomFilter.vertices.map(v => v.y);
      b = { minX: Math.min(...xs) - pad, minY: Math.min(...ys) - pad,
            maxX: Math.max(...xs) + pad, maxY: Math.max(...ys) + pad };
    } else {
      b = { minX: roomFilter.x - pad, minY: roomFilter.y - pad,
            maxX: roomFilter.x + roomFilter.w + pad, maxY: roomFilter.y + roomFilter.h + pad };
    }
  } else {
    b = contentBoundsMeters();
  }

  const widthM = b.maxX - b.minX;
  const heightM = b.maxY - b.minY;
  const c = document.createElement('canvas');
  c.width = Math.round(widthM * exportPpm);
  c.height = Math.round(heightM * exportPpm);
  const ec = c.getContext('2d');
  const origin = { x: b.minX, y: b.minY };
  const w2c = (xm, ym) => ({ x: (xm - origin.x) * exportPpm, y: (ym - origin.y) * exportPpm });

  ec.fillStyle = '#FFFFFF';
  ec.fillRect(0, 0, c.width, c.height);

  // Grid
  ec.strokeStyle = 'rgba(139,131,120,0.1)';
  ec.lineWidth = 1;
  const gridStart = { x: Math.floor(b.minX), y: Math.floor(b.minY) };
  for (let gx = gridStart.x; gx <= b.maxX + 1; gx++) {
    const px = (gx - b.minX) * exportPpm;
    ec.beginPath(); ec.moveTo(px, 0); ec.lineTo(px, c.height); ec.stroke();
  }
  for (let gy = gridStart.y; gy <= b.maxY + 1; gy++) {
    const py = (gy - b.minY) * exportPpm;
    ec.beginPath(); ec.moveTo(0, py); ec.lineTo(c.width, py); ec.stroke();
  }

  // Background image (whole plan only)
  if (!roomFilter && state.bgImage && state.bgImageVisible && state.scalePxPerMeter) {
    const wImg = state.bgImage.width / state.scalePxPerMeter;
    const hImg = state.bgImage.height / state.scalePxPerMeter;
    const p = w2c(0, 0);
    ec.save(); ec.globalAlpha = 0.4;
    ec.drawImage(state.bgImage, p.x, p.y, wImg * exportPpm, hImg * exportPpm);
    ec.restore();
  }

  // Rooms — if filtering, dim rooms other than the focus room
  state.rooms.forEach(r => {
    const isFocused = !roomFilter || r.id === roomFilter.id;
    ec.globalAlpha = isFocused ? 1 : 0.25;
    exportDrawRoom(ec, r, exportPpm, w2c);
    ec.globalAlpha = 1;
  });

  // Furniture — if filtering, dim furniture not in this room
  const roomFurnIds = roomFilter
    ? new Set(getFurnitureForRoom(roomFilter.id).map(f => f.id))
    : null;

  state.placedFurniture.forEach(f => {
    const inFocus = !roomFilter || roomFurnIds.has(f.id);
    ec.globalAlpha = inFocus ? 1 : 0.2;
    exportDrawFurniture(ec, f, exportPpm, w2c);
    ec.globalAlpha = 1;
  });

  // Scale ruler
  const barLen = UNITS.main === 'ft' ? exportPpm * 0.3048 : exportPpm;
  const x0 = c.width - barLen - 24, y0 = c.height - 24;
  ec.globalAlpha = 1;
  ec.strokeStyle = '#1B2A41'; ec.fillStyle = '#1B2A41'; ec.lineWidth = 2;
  ec.beginPath(); ec.moveTo(x0, y0); ec.lineTo(x0 + barLen, y0); ec.stroke();
  [x0, x0 + barLen].forEach(x => {
    ec.beginPath(); ec.moveTo(x, y0 - 5); ec.lineTo(x, y0 + 5); ec.stroke();
  });
  ec.font = '11px JetBrains Mono, monospace';
  ec.textAlign = 'center';
  ec.fillText('1 ' + unitLabel(), x0 + barLen / 2, y0 - 9);

  return c;
}

function exportDrawRoom(ec, r, exportPpm, w2c) {
  if (r.vertices && r.vertices.length >= 3) {
    const pts = r.vertices.map(v => w2c(v.x, v.y));
    ec.save();
    ec.beginPath();
    ec.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ec.lineTo(pts[i].x, pts[i].y);
    ec.closePath();
    ec.fillStyle = hexToRgba(r.color, 0.16); ec.fill();
    ec.strokeStyle = r.color; ec.lineWidth = 2; ec.stroke();
    ec.restore();
    const cxE = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cyE = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    ec.fillStyle = '#1B2A41'; ec.font = '600 14px Inter, sans-serif';
    ec.textAlign = 'center'; ec.textBaseline = 'middle';
    ec.fillText(r.name, cxE, cyE - 9);
    ec.font = '11px JetBrains Mono, monospace'; ec.fillStyle = '#6B6259';
    ec.fillText(fmt(polygonArea(r.vertices)) + ' m²', cxE, cyE + 9);
    ec.textAlign = 'left'; ec.textBaseline = 'alphabetic';
  } else {
    const p = w2c(r.x, r.y);
    const wPx = r.w * exportPpm, hPx = r.h * exportPpm;
    const scaled = { ...r, w: wPx, h: hPx,
      notchW: (r.notchW || r.w / 2) * exportPpm, notchH: (r.notchH || r.h / 2) * exportPpm };
    ec.save(); ec.translate(p.x, p.y);
    tracePath(ec, scaled);
    ec.fillStyle = hexToRgba(r.color, 0.16); ec.fill();
    ec.strokeStyle = r.color; ec.lineWidth = 2; ec.stroke();
    ec.restore();
    ec.fillStyle = '#1B2A41'; ec.font = '600 14px Inter, sans-serif';
    ec.textBaseline = 'top';
    ec.fillText(r.name, p.x + 8, p.y + 7);
    ec.font = '11px JetBrains Mono, monospace'; ec.fillStyle = '#6B6259';
    ec.fillText(fmtU(r.w) + ' × ' + fmtU(r.h) + ' ' + unitLabel(), p.x + 8, p.y + 24);
  }
}

function exportDrawFurniture(ec, f, exportPpm, w2c) {
  const p = w2c(f.x, f.y);
  const wPx = f.w * exportPpm, hPx = f.h * exportPpm;
  const cx = p.x + wPx / 2, cy = p.y + hPx / 2;
  const scaled = { ...f, w: wPx, h: hPx,
    notchW: (f.notchW || f.w / 2) * exportPpm, notchH: (f.notchH || f.h / 2) * exportPpm };
  ec.save();
  ec.translate(cx, cy);
  ec.rotate((f.rotation || 0) * Math.PI / 180);
  ec.translate(-wPx / 2, -hPx / 2);
  ec.fillStyle = hexToRgba(f.color, 0.88);
  ec.strokeStyle = 'rgba(27,42,65,0.5)'; ec.lineWidth = 1.3;
  if (!f.shape || f.shape === 'rect') {
    roundRect(ec, 0, 0, wPx, hPx, 4);
  } else {
    tracePath(ec, scaled);
  }
  ec.fill(); ec.stroke();
  if (wPx > 34 && hPx > 18) {
    ec.fillStyle = '#FAF8F2';
    ec.font = '600 11px Inter, sans-serif';
    ec.textAlign = 'center'; ec.textBaseline = 'middle';
    ec.fillText(truncateLabel(f.name, wPx), wPx / 2, hPx / 2);
  }
  ec.restore();
}


/* =========================================================
   UNIT SWITCHER
   ========================================================= */
document.getElementById('unit-select').onchange = (e) => {
  UNITS.main = e.target.value;
  inspectorBuiltKey = null; // force inspector rebuild with new units
  updateInspector();
  syncRoomList();
  syncCatalogList();
  render();
  // update furniture form placeholders
  document.getElementById('fn-width').placeholder = `W (${smallUnitLabel()})`;
  document.getElementById('fn-length').placeholder = `L (${smallUnitLabel()})`;
  document.getElementById('fn-diameter').placeholder = `Diameter (${smallUnitLabel()})`;
  document.getElementById('fn-notch-w').placeholder = `Notch W (${smallUnitLabel()})`;
  document.getElementById('fn-notch-h').placeholder = `Notch H (${smallUnitLabel()})`;
};

/* =========================================================
   BROWSE REAL FURNITURE
   ========================================================= */

const CATALOG_COLORS = ["#F5F0E8", "#E8E0D0", "#C8BFB0", "#8B8378", "#3D3530", "#1A1A1A", "#D4A96A", "#A6763F", "#7A4E2D", "#5C3D1E", "#B8C9D4", "#4A6FA5", "#2C4A6E", "#5C7A6B", "#3D6B5C", "#2E5545", "#7B9EB0", "#E8C4A0", "#C9855A", "#C9622A", "#A84F1F", "#8B5E83", "#6B3F6B", "#B8956A"];

// Currency symbols for display
const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'CA$' };

// Which display currency to use per region (falls back to USD)
const REGION_CURRENCY = { eu: 'EUR', us: 'USD', uk: 'GBP', au: 'AUD', ca: 'CAD' };

var browse = {
  catalog: null,         // full catalog JSON
  exchangeRates: {},     // currency -> USD rate, from catalog JSON
  filters: {
    region: '',
    categories: new Set(),
    brands: new Set(),
    maxPriceUsd: Infinity,  // always in USD internally
    search: '',
  },
};

// ── Open / Close ───────────────────────────────────────────

document.getElementById('btn-browse-furniture').onclick = () => {
  document.getElementById('modal-browse').classList.add('open');
  if (!browse.catalog) {
    loadFurnitureCatalog();
  } else {
    // Re-render so "already added" state is always fresh
    renderBrowseGrid();
  }
};

function closeBrowseModal() {
  document.getElementById('modal-browse').classList.remove('open');
}
document.getElementById('btn-browse-close').onclick = closeBrowseModal;
document.getElementById('modal-browse').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeBrowseModal();
});

// Escape key — wire into the existing keydown handler by appending here
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('modal-browse').classList.contains('open')) {
    closeBrowseModal();
  }
});

// ── Load catalog from server ───────────────────────────────

function loadFurnitureCatalog() {
  document.getElementById('browse-loading').style.display = 'block';
  document.getElementById('browse-grid').style.display = 'none';
  document.getElementById('browse-empty').style.display = 'none';

  fetch('/api/furniture-catalog')
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(data => {
      browse.catalog = data;
      browse.exchangeRates = data.exchange_rates_to_usd || {};

      // Set price slider max to the highest USD-normalised price, rounded up
      const maxUsd = getMaxUsdPrice(data.items);
      browse.filters.maxPriceUsd = maxUsd;
      const slider = document.getElementById('filter-price');
      slider.max = maxUsd;
      slider.value = maxUsd;
      document.getElementById('filter-price-label').textContent = 'any price';

      buildBrowseFilters(data);
      document.getElementById('browse-loading').style.display = 'none';
      document.getElementById('browse-grid').style.display = 'grid';
      renderBrowseGrid();
    })
    .catch(err => {
      document.getElementById('browse-loading').textContent =
        'Could not load catalog — make sure the server is running (node server.js).';
      console.error('Catalog load error:', err);
    });
}

// ── Currency helpers ───────────────────────────────────────

function getMaxUsdPrice(items) {
  return Math.ceil(Math.max(...items.map(i => i.price_usd || i.price), 500) / 100) * 100;
}

// Convert a USD amount to the currently selected display currency
function usdToDisplay(usd) {
  const currency = getDisplayCurrency();
  const rate = browse.exchangeRates[currency] || 1;
  return Math.round(usd / rate); // USD -> target: divide by "currency per USD" rate? No:
  // Our rates are currency->USD, so to go USD->currency we divide by the rate... wait:
  // rate = how many USD one unit of currency is worth  (EUR: 1.08 means 1 EUR = 1.08 USD)
  // USD -> EUR:  usd / 1.08
  // correct ↑
}

function formatPrice(item) {
  const displayCurrency = getDisplayCurrency();
  const sym = CURRENCY_SYMBOLS[displayCurrency] || displayCurrency + ' ';

  if (item.currency === displayCurrency) {
    // Native — show exact price
    return `${sym}${item.price.toLocaleString()}`;
  }
  // Converted — show approx
  const rate = browse.exchangeRates[displayCurrency] || 1;
  const converted = Math.round((item.price_usd || item.price) / rate);
  return `≈ ${sym}${converted.toLocaleString()}`;
}

function getDisplayCurrency() {
  return REGION_CURRENCY[browse.filters.region] || 'USD';
}

// ── Build filter controls ──────────────────────────────────

function buildBrowseFilters(data) {
  // Regions
  const regionSel = document.getElementById('filter-region');
  regionSel.innerHTML = '<option value="">All Regions</option>';
  data.regions.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.label;
    regionSel.appendChild(opt);
  });
  regionSel.onchange = () => {
    browse.filters.region = regionSel.value;
    // Update currency note below price slider
    const currency = getDisplayCurrency();
    const note = document.getElementById('filter-price-note');
    if (browse.filters.region && currency !== 'USD') {
      note.textContent = `Prices converted to ${currency} (approximate). Filter compares in USD.`;
    } else {
      note.textContent = 'Prices shown in USD. Select a region to see local currency (approximate).';
    }
    // Re-render: region affects both item visibility AND displayed currency
    updatePriceSliderLabel();
    renderBrowseGrid();
  };

  // Category pills
  const catWrap = document.getElementById('filter-categories');
  catWrap.innerHTML = '';
  data.categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'filter-pill';
    const count = data.items.filter(i => i.category === cat).length;
    btn.innerHTML = `${cat}<span class="filter-pill-count">${count}</span>`;
    btn.onclick = () => {
      browse.filters.categories.has(cat)
        ? (browse.filters.categories.delete(cat), btn.classList.remove('active'))
        : (browse.filters.categories.add(cat), btn.classList.add('active'));
      renderBrowseGrid();
    };
    catWrap.appendChild(btn);
  });

  // Brand pills
  const brandWrap = document.getElementById('filter-brands');
  brandWrap.innerHTML = '';
  [...new Set(data.items.map(i => i.brand))].sort().forEach(brand => {
    const btn = document.createElement('button');
    btn.className = 'filter-pill';
    const count = data.items.filter(i => i.brand === brand).length;
    btn.innerHTML = `${brand}<span class="filter-pill-count">${count}</span>`;
    btn.onclick = () => {
      browse.filters.brands.has(brand)
        ? (browse.filters.brands.delete(brand), btn.classList.remove('active'))
        : (browse.filters.brands.add(brand), btn.classList.add('active'));
      renderBrowseGrid();
    };
    brandWrap.appendChild(btn);
  });

  // Price slider — always in USD internally, label shows display currency
  const priceRange = document.getElementById('filter-price');
  priceRange.oninput = () => {
    browse.filters.maxPriceUsd = parseInt(priceRange.value);
    updatePriceSliderLabel();
    renderBrowseGrid();
  };

  // Search
  document.getElementById('filter-search').oninput = (e) => {
    browse.filters.search = e.target.value.trim().toLowerCase();
    renderBrowseGrid();
  };

  // Clear all
  document.getElementById('btn-clear-filters').onclick = () => {
    const maxUsd = getMaxUsdPrice(data.items);
    browse.filters.region = '';
    browse.filters.categories.clear();
    browse.filters.brands.clear();
    browse.filters.maxPriceUsd = maxUsd;
    browse.filters.search = '';
    regionSel.value = '';
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-price-note').textContent =
      'Prices shown in USD. Select a region to see local currency (approximate).';
    priceRange.value = priceRange.max;
    document.getElementById('filter-price-label').textContent = 'any price';
    catWrap.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    brandWrap.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    renderBrowseGrid();
  };
}

function updatePriceSliderLabel() {
  const slider = document.getElementById('filter-price');
  const label = document.getElementById('filter-price-label');
  const val = parseInt(slider.value);
  const max = parseInt(slider.max);
  if (val >= max) { label.textContent = 'any price'; return; }

  const currency = getDisplayCurrency();
  const rate = browse.exchangeRates[currency] || 1;
  const displayVal = Math.round(val / rate);
  const sym = CURRENCY_SYMBOLS[currency] || currency + ' ';
  const approxNote = currency !== 'USD' ? ' ≈' : '';
  label.textContent = `${approxNote}${sym}${displayVal.toLocaleString()}`;
}

// ── Filter items ───────────────────────────────────────────

function getFilteredItems() {
  if (!browse.catalog) return [];
  const f = browse.filters;
  return browse.catalog.items.filter(item => {
    if (f.region && !item.regions.includes(f.region)) return false;
    if (f.categories.size && !f.categories.has(item.category)) return false;
    if (f.brands.size && !f.brands.has(item.brand)) return false;
    // Price comparison always in USD
    if ((item.price_usd || item.price) > f.maxPriceUsd) return false;
    if (f.search) {
      const hay = [item.name, item.brand, item.category, ...(item.tags || [])].join(' ').toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    return true;
  });
}

// ── Render grid ────────────────────────────────────────────

function renderBrowseGrid() {
  const grid = document.getElementById('browse-grid');
  const empty = document.getElementById('browse-empty');
  const items = getFilteredItems();

  document.getElementById('browse-count').textContent =
    `${items.length} item${items.length !== 1 ? 's' : ''}`;

  if (!items.length) {
    grid.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  grid.style.display = 'grid';
  empty.style.display = 'none';
  grid.innerHTML = '';
  items.forEach(item => grid.appendChild(buildBrowseCard(item)));
}

// ── Build a single card ────────────────────────────────────

function buildBrowseCard(item) {
  const card = document.createElement('div');
  card.className = 'browse-card';

  const alreadyAdded = state.furnitureCatalog.some(c => c.sourceId === item.id);

  let dimsStr = item.shape === 'circle'
    ? `Ø${item.width} cm`
    : `${item.width} × ${item.length} cm`;

  const priceStr = formatPrice(item);

  const colorDots = (item.color_options || []).slice(0, 5).map((name, i) => {
    const col = CATALOG_COLORS[i % CATALOG_COLORS.length];
    return `<span class="browse-color-dot" style="background:${col}" title="${name}"></span>`;
  }).join('');

  const hasUrl = !!item.affiliate_url;

  card.innerHTML = `
    <div class="browse-card-img-wrap">
      <img class="browse-card-img" src="${item.image_url || ''}" alt="${item.name}" loading="lazy">
      <div class="browse-card-img-overlay"></div>
      <div class="browse-card-shape-badge"></div>
    </div>
    <div class="browse-card-body">
      <div class="browse-card-brand">${item.brand}</div>
      <div class="browse-card-name">${item.name}</div>
      <div class="browse-card-dims">${dimsStr}</div>
      <div class="browse-card-desc">${item.description}</div>
      <div class="browse-card-footer">
        <span class="browse-card-price">${priceStr}</span>
        <div class="browse-card-colors">${colorDots}</div>
      </div>
      <div class="browse-card-actions">
        <button class="btn-add-to-catalog${alreadyAdded ? ' added' : ''}">
          ${alreadyAdded ? '✓ In catalog' : '+ Add to Plan'}
        </button>
        ${hasUrl ? `<a class="btn-view-product" href="${item.affiliate_url}" target="_blank" rel="noopener noreferrer">View Product ↗</a>` : ''}
      </div>
    </div>
  `;

  // Draw the small shape badge onto its canvas
  const badgeEl = card.querySelector('.browse-card-shape-badge');
  drawShapeBadge(badgeEl, item);

  // Image error fallback → show shape badge more prominently
  const img = card.querySelector('.browse-card-img');
  img.onerror = () => {
    img.style.display = 'none';
    card.querySelector('.browse-card-img-overlay').style.display = 'none';
    badgeEl.classList.add('badge-fallback');
  };

  // Add to catalog
  const addBtn = card.querySelector('.btn-add-to-catalog');
  if (!alreadyAdded) {
    addBtn.onclick = () => {
      addBrowseItemToCatalog(item);
      addBtn.textContent = '✓ In catalog';
      addBtn.classList.add('added');
      addBtn.onclick = null;
    };
  }

  return card;
}

// ── Shape badge (small canvas in corner of image) ─────────

function drawShapeBadge(container, item) {
  const size = 44;
  const c = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  c.width = size * dpr; c.height = size * dpr;
  c.style.width = size + 'px'; c.style.height = size + 'px';
  const cx = c.getContext('2d');
  cx.scale(dpr, dpr);

  const pad = 6;
  const avail = size - pad * 2;
  // Scale shape to fit the badge square, preserving aspect ratio
  const scaleF = Math.min(avail / item.width, avail / item.length);
  const drawW = item.width * scaleF;
  const drawH = item.length * scaleF;
  const ox = (size - drawW) / 2;
  const oy = (size - drawH) / 2;

  cx.save();
  cx.translate(ox, oy);

  if (item.shape === 'circle') {
    cx.beginPath();
    cx.ellipse(drawW / 2, drawH / 2, drawW / 2, drawH / 2, 0, 0, Math.PI * 2);
  } else if (item.shape === 'triangle') {
    cx.beginPath(); cx.moveTo(0, drawH); cx.lineTo(drawW, drawH); cx.lineTo(0, 0); cx.closePath();
  } else if (item.shape === 'lshape') {
    const nw = (item.notch_width || item.width / 2) * scaleF;
    const nh = (item.notch_length || item.length / 2) * scaleF;
    cx.beginPath();
    cx.moveTo(0, 0); cx.lineTo(drawW - nw, 0); cx.lineTo(drawW - nw, nh);
    cx.lineTo(drawW, nh); cx.lineTo(drawW, drawH); cx.lineTo(0, drawH); cx.closePath();
  } else {
    cx.beginPath(); cx.roundRect(0, 0, drawW, drawH, 2);
  }
  cx.fillStyle = 'rgba(255,255,255,0.9)';
  cx.fill();
  cx.strokeStyle = 'rgba(27,42,65,0.6)';
  cx.lineWidth = 1.5;
  cx.stroke();
  cx.restore();
  container.appendChild(c);
}

// ── Add to personal catalog ────────────────────────────────

function addBrowseItemToCatalog(item) {
  const w = item.width / 100;
  const h = item.length / 100;
  const color = CATALOG_COLORS[state.furnitureCatalog.length % CATALOG_COLORS.length];
  const catItem = {
    id: uid('catalog'),
    sourceId: item.id,
    name: item.name,
    shape: item.shape || 'rect',
    w, h, color,
    brand: item.brand,
    price: item.price,
    price_usd: item.price_usd,
    currency: item.currency,
    affiliate_url: item.affiliate_url || null,
  };
  if (item.shape === 'lshape' && item.notch_width) {
    catItem.notchW = item.notch_width / 100;
    catItem.notchH = item.notch_length / 100;
  }
  snapshotState();
  state.furnitureCatalog.push(catItem);
  syncCatalogList();
  syncLegendPreview();
  showToast(`"${item.name}" added — drag it onto the plan`);
}

/* =========================================================
   RIGHT RAIL TABS
   ========================================================= */

document.querySelectorAll('.right-tab').forEach(tab => {
  tab.addEventListener('click', () => switchRightTab(tab.dataset.tab));
});

function switchRightTab(tabName) {
  document.querySelectorAll('.right-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tabName)
  );
  document.querySelectorAll('.right-tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('right-panel-' + tabName);
  if (panel) panel.classList.add('active');
  if (tabName === 'costs') syncCostSummary();
  if (tabName === 'rooms') syncRoomView();
}

/* =========================================================
   COST ENGINE
   — furniture "belongs" to a room if its centre point falls
     inside that room's bounding box (or polygon).
   ========================================================= */

const COST_CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'CA$' };

function furnitureCentreInRoom(f, r) {
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  if (r.vertices && r.vertices.length >= 3) {
    return pointInPolygon(cx, cy, r.vertices);
  }
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
}

function getFurnitureForRoom(roomId) {
  const r = findRoom(roomId);
  if (!r) return [];
  return state.placedFurniture.filter(f => furnitureCentreInRoom(f, r));
}

function getUnassignedFurniture() {
  return state.placedFurniture.filter(f =>
    !state.rooms.some(r => furnitureCentreInRoom(f, r))
  );
}

function itemPriceUsd(f) {
  // price_usd from catalog, or convert if currency known, or null
  if (f.price_usd != null) return f.price_usd;
  if (f.price != null && f.currency) {
    // Use browse exchange rates if loaded, else rough fallback
    const rates = (browse.catalog && browse.catalog.exchange_rates_to_usd) || {
      USD: 1, EUR: 1.08, GBP: 1.27, AUD: 0.65, CAD: 0.74,
    };
    return Math.round(f.price * (rates[f.currency] || 1));
  }
  return null;
}

function formatItemPrice(f) {
  const usd = itemPriceUsd(f);
  if (usd == null) return null;
  // Show in USD unless the item has a native currency
  if (f.currency && f.currency !== 'USD' && f.price != null) {
    const sym = COST_CURRENCY_SYMBOLS[f.currency] || f.currency + ' ';
    return `${sym}${f.price.toLocaleString()}`;
  }
  return `$${usd.toLocaleString()}`;
}

function sumRoomCostUsd(roomId) {
  return getFurnitureForRoom(roomId).reduce((sum, f) => {
    const p = itemPriceUsd(f);
    return sum + (p || 0);
  }, 0);
}

function totalPlanCostUsd() {
  return state.placedFurniture.reduce((sum, f) => {
    const p = itemPriceUsd(f);
    return sum + (p || 0);
  }, 0);
}

function hasPricedItems() {
  return state.placedFurniture.some(f => itemPriceUsd(f) != null);
}

/* =========================================================
   COST SUMMARY PANEL
   ========================================================= */

function syncCostSummary() {
  const el = document.getElementById('cost-summary');
  if (!state.placedFurniture.length) {
    el.innerHTML = '<div class="cost-empty">Place furniture on the canvas to see cost estimates.</div>';
    return;
  }

  const total = totalPlanCostUsd();
  const priced = state.placedFurniture.filter(f => itemPriceUsd(f) != null).length;
  const unpriced = state.placedFurniture.length - priced;
  const noteText = unpriced > 0
    ? `${priced} of ${state.placedFurniture.length} items have prices. Custom items not included.`
    : `All ${priced} item${priced !== 1 ? 's' : ''} priced.`;

  let html = `
    <div class="cost-total-block">
      <div class="cost-total-label">Estimated Total</div>
      <div class="cost-total-amount">$${total.toLocaleString()}</div>
      <div class="cost-total-note">${noteText}</div>
    </div>
  `;

  // Per-room breakdown
  if (state.rooms.length) {
    state.rooms.forEach(r => {
      const furniture = getFurnitureForRoom(r.id);
      const roomTotal = furniture.reduce((s, f) => s + (itemPriceUsd(f) || 0), 0);

      // Group furniture rows by name for compact display
      const groups = {};
      furniture.forEach(f => {
        const key = f.sourceId || `${f.name}|${f.w}|${f.h}`;
        if (!groups[key]) groups[key] = { f, count: 0 };
        groups[key].count++;
      });

      const itemRows = Object.values(groups).map(({ f, count }) => {
        const priceStr = formatItemPrice(f);
        const totalForGroup = itemPriceUsd(f) != null ? itemPriceUsd(f) * count : null;
        const totalStr = totalForGroup != null ? `$${totalForGroup.toLocaleString()}` : '—';
        const qtyBadge = count > 1 ? `<span class="cost-item-qty">×${count}</span>` : '';
        return `
          <div class="cost-item-row">
            <span class="cost-item-swatch" style="background:${f.color}"></span>
            <span class="cost-item-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            ${qtyBadge}
            <span class="cost-item-price${totalForGroup == null ? ' no-price' : ''}">${totalStr}</span>
          </div>`;
      }).join('');

      const emptyMsg = furniture.length === 0
        ? '<div class="room-view-furn-empty">No furniture placed in this room yet.</div>'
        : '';

      html += `
        <div class="cost-room-block" id="cost-room-${r.id}">
          <div class="cost-room-header" onclick="toggleCostRoom('${r.id}')">
            <span class="cost-room-swatch" style="background:${r.color}"></span>
            <span class="cost-room-name">${escapeHtml(r.name)}</span>
            <span class="cost-room-subtotal">${roomTotal > 0 ? '$' + roomTotal.toLocaleString() : '—'}</span>
            <span class="cost-room-chevron">▶</span>
          </div>
          <div class="cost-room-items">
            ${itemRows}${emptyMsg}
          </div>
        </div>`;
    });
  }

  // Unassigned furniture
  const unassigned = getUnassignedFurniture();
  if (unassigned.length) {
    const unassignedTotal = unassigned.reduce((s, f) => s + (itemPriceUsd(f) || 0), 0);
    const groups = {};
    unassigned.forEach(f => {
      const key = f.sourceId || `${f.name}|${f.w}|${f.h}`;
      if (!groups[key]) groups[key] = { f, count: 0 };
      groups[key].count++;
    });
    const rows = Object.values(groups).map(({ f, count }) => {
      const totalForGroup = itemPriceUsd(f) != null ? itemPriceUsd(f) * count : null;
      const totalStr = totalForGroup != null ? `$${totalForGroup.toLocaleString()}` : '—';
      const qtyBadge = count > 1 ? `<span class="cost-item-qty">×${count}</span>` : '';
      return `
        <div class="cost-item-row">
          <span class="cost-item-swatch" style="background:${f.color}"></span>
          <span class="cost-item-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
          ${qtyBadge}
          <span class="cost-item-price${totalForGroup == null ? ' no-price' : ''}">${totalStr}</span>
        </div>`;
    }).join('');

    html += `
      <div class="cost-unassigned-block" style="margin-top:10px;">
        <div class="cost-unassigned-label">Not inside a room ${unassignedTotal > 0 ? '— $' + unassignedTotal.toLocaleString() : ''}</div>
        ${rows}
      </div>`;
  }

  el.innerHTML = html;
}

function toggleCostRoom(roomId) {
  const block = document.getElementById('cost-room-' + roomId);
  if (block) block.classList.toggle('open');
}

// Called after furniture changes to keep cost/room panels live
function refreshCostAndRoomPanels() {
  const costPanel = document.getElementById('right-panel-costs');
  if (costPanel && costPanel.classList.contains('active')) syncCostSummary();
  const roomPanel = document.getElementById('right-panel-rooms');
  if (roomPanel && roomPanel.classList.contains('active')) syncRoomView();
}

/* =========================================================
   ROOM VIEW PANEL
   ========================================================= */

function syncRoomView() {
  const el = document.getElementById('room-view-panel');
  if (!state.rooms.length) {
    el.innerHTML = '<div class="room-view-empty">Add rooms to the canvas to see them here.</div>';
    return;
  }

  el.innerHTML = '';
  state.rooms.forEach(r => {
    const furniture = getFurnitureForRoom(r.id);
    const roomCostUsd = furniture.reduce((s, f) => s + (itemPriceUsd(f) || 0), 0);
    const areaStr = r.vertices
      ? fmt(polygonArea(r.vertices)) + ' m²'
      : fmt(r.w * r.h) + ' m²';
    const dimsStr = r.vertices
      ? 'Polygon room'
      : `${fmtU(r.w)} × ${fmtU(r.h)} ${unitLabel()}`;

    const card = document.createElement('div');
    card.className = 'room-view-card';
    card.id = 'rv-' + r.id;

    // Furniture rows
    const furnRows = furniture.length
      ? furniture.map(f => `
          <div class="room-view-furn-row">
            <span class="room-view-furn-swatch" style="background:${f.color}"></span>
            <span class="room-view-furn-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            <span class="room-view-furn-dims">${fmtS(f.w)}×${fmtS(f.h)}${smallUnitLabel()}</span>
          </div>`).join('')
      : '<div class="room-view-furn-empty">No furniture placed in this room.</div>';

    card.innerHTML = `
      <div class="room-view-card-header">
        <span class="room-view-swatch" style="background:${r.color}"></span>
        <div style="flex:1; min-width:0;">
          <div class="room-view-name">${escapeHtml(r.name)}</div>
          <div class="room-view-meta">${dimsStr} · ${areaStr}</div>
        </div>
        <button class="room-view-btn-focus" data-roomid="${r.id}">Focus</button>
      </div>
      <div class="room-view-furniture">
        ${furnRows}
        <div class="room-view-footer">
          <span style="font-size:11px; color:var(--graphite);">${furniture.length} item${furniture.length !== 1 ? 's' : ''}</span>
          <span class="room-view-cost">${roomCostUsd > 0 ? '$' + roomCostUsd.toLocaleString() : '—'}</span>
        </div>
      </div>
    `;

    // Toggle furniture list
    card.querySelector('.room-view-card-header').addEventListener('click', (e) => {
      if (e.target.closest('.room-view-btn-focus')) return;
      card.classList.toggle('open');
    });

    // Focus button
    card.querySelector('.room-view-btn-focus').addEventListener('click', (e) => {
      e.stopPropagation();
      enterFocusMode(r.id);
    });

    el.appendChild(card);
  });
}

/* =========================================================
   FOCUS MODE
   — zooms the canvas to frame the selected room tightly,
     dims furniture outside it, and shows a banner.
   ========================================================= */

var focusState = {
  active: false,
  roomId: null,
};

function enterFocusMode(roomId) {
  const r = findRoom(roomId);
  if (!r) return;

  focusState.active = true;
  focusState.roomId = roomId;

  // Show banner
  const bar = document.getElementById('focus-mode-bar');
  bar.classList.add('visible');
  document.getElementById('focus-mode-label').textContent = `Focusing: ${r.name}`;

  // Zoom to fit the room with padding
  const padM = 1.5;
  const roomW = r.vertices ? (Math.max(...r.vertices.map(v => v.x)) - Math.min(...r.vertices.map(v => v.x))) : r.w;
  const roomH = r.vertices ? (Math.max(...r.vertices.map(v => v.y)) - Math.min(...r.vertices.map(v => v.y))) : r.h;
  const scroll = document.getElementById('canvas-scroll');
  const viewW = scroll.clientWidth;
  const viewH = scroll.clientHeight;
  const basePpm = state.scalePxPerMeter || BASE_PX_PER_METER;
  const targetZoom = Math.min(
    (viewW * 0.85) / ((roomW + padM * 2) * basePpm),
    (viewH * 0.85) / ((roomH + padM * 2) * basePpm),
    3
  );
  setZoom(targetZoom);

  // Centre on room after zoom
  setTimeout(() => centerOn(r.vertices ? roomBoundsRect(r) : r), 30);

  render();

  // Switch to rooms tab so context is visible
  switchRightTab('rooms');
}

function exitFocusMode() {
  focusState.active = false;
  focusState.roomId = null;
  document.getElementById('focus-mode-bar').classList.remove('visible');
  render();
}

document.getElementById('btn-exit-focus').addEventListener('click', exitFocusMode);

// Also exit on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && focusState.active) exitFocusMode();
});

// Helper: bounding rect for polygon room
function roomBoundsRect(r) {
  if (!r.vertices || !r.vertices.length) return r;
  const xs = r.vertices.map(v => v.x);
  const ys = r.vertices.map(v => v.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

// Focus-mode dimming is called directly from the original render() below.

function applyFocusDim() {
  const r = findRoom(focusState.roomId);
  if (!r) return;
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);

  // Build a clipping region for the focused room so we dim everything outside
  ctx.save();
  ctx.fillStyle = 'rgba(27, 42, 65, 0.38)';

  // Fill entire canvas, then cut out the room shape
  ctx.beginPath();
  ctx.rect(0, 0, w, h);

  if (r.vertices && r.vertices.length >= 3) {
    const pts = r.vertices.map(v => worldToCanvas(v.x, v.y));
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  } else {
    const p = worldToCanvas(r.x, r.y);
    const ppm = pxPerMeter();
    ctx.rect(p.x, p.y, r.w * ppm, r.h * ppm);
  }

  ctx.evenoddFill = true;
  ctx.fill('evenodd');

  // Highlight border of focused room
  ctx.strokeStyle = 'rgba(201, 98, 42, 0.7)';
  ctx.lineWidth = 2.5;
  if (r.vertices && r.vertices.length >= 3) {
    const pts = r.vertices.map(v => worldToCanvas(v.x, v.y));
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
  } else {
    const p = worldToCanvas(r.x, r.y);
    const ppm = pxPerMeter();
    ctx.strokeRect(p.x, p.y, r.w * ppm, r.h * ppm);
  }

  ctx.restore();
}


/* =========================================================
   AUTO-SAVE  (localStorage)
   Saves project state automatically after changes.
   Excludes bgImageDataUrl — too large for localStorage.
   On load: restore from localStorage unless a share link
   is present in the URL hash (share link takes priority).
   ========================================================= */

const AUTOSAVE_KEY = 'planscale_autosave';
let _autosaveTimer = null;

// Debounced save — waits 1s after last change before writing
function autosave() {
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(_doAutosave, 1000);
}

function _doAutosave() {
  try {
    const data = {
      version: 1,
      projectName: document.getElementById('project-name').value.trim(),
      scalePxPerMeter: state.scalePxPerMeter,
      bgImageDataUrl: null,  // excluded — too large
      rooms: state.rooms,
      furnitureCatalog: state.furnitureCatalog,
      placedFurniture: state.placedFurniture,
      savedAt: Date.now(),
    };
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
    _showAutosaveIndicator();
  } catch (e) {
    // localStorage can throw if storage is full or disabled
    console.warn('Autosave failed:', e);
  }
}

function _showAutosaveIndicator() {
  const el = document.getElementById('autosave-indicator');
  if (!el) return;
  el.textContent = 'Auto-saved';
  el.classList.add('visible');
  clearTimeout(_showAutosaveIndicator._t);
  _showAutosaveIndicator._t = setTimeout(() => el.classList.remove('visible'), 2500);
}

function clearAutosave() {
  localStorage.removeItem(AUTOSAVE_KEY);
}

function restoreAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    // Only restore if there's actually something there
    if (!data.rooms?.length && !data.placedFurniture?.length && !data.furnitureCatalog?.length) return false;
    loadProjectData(data);
    const ago = data.savedAt ? _timeAgo(data.savedAt) : '';
    showToast('Restored your last session' + (ago ? ' (' + ago + ')' : ''));
    return true;
  } catch (e) {
    console.warn('Could not restore autosave:', e);
    return false;
  }
}

function _timeAgo(ts) {
  const diff = Math.round((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  return Math.round(diff / 86400) + 'd ago';
}

// Also save on project name changes
document.getElementById('project-name').addEventListener('input', autosave);

/* =========================================================
   INIT
   ========================================================= */
setZoom(1);
buildFnColorSwatches();
syncRoomList();
syncCatalogList();
syncLegendPreview();
updateInspector();
render();
window.addEventListener('resize', render);

// On load: restore autosave OR load from share link (share link wins)
// checkUrlHash returns true if it found and loaded a hash
if (!window.location.hash.startsWith('#plan/')) {
  restoreAutosave();
}
checkUrlHash();
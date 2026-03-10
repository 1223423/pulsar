const STORAGE_SHOW_RR = "pulsar_show_rr_plot";
const STORAGE_DEBUG_MODE = "pulsar_debug_mode";
const STORAGE_FOLLOW_PREFIX = "pulsar_chart_follow_";
const STORAGE_CHART_HEIGHT_PREFIX = "pulsar_chart_height_";
const STORAGE_MARKER_PRESETS = "pulsar_marker_presets_v1";
const STORAGE_SESSIONS_HEIGHT = "pulsar_sessions_height_v1";
const LONG_PRESS_MS = 500;
const DEFAULT_MARKER_PRESETS = [
  { label: "Marker 1", color: "#ff5f5f" },
  { label: "Marker 2", color: "#36c9b4" },
  { label: "Marker 3", color: "#f4be37" },
  { label: "Marker 4", color: "#5aa7ff" },
  { label: "Marker 5", color: "#c083ff" },
];

function safeAddEvent(element, event, handler, options) {
  if (element && typeof element.addEventListener === "function") {
    element.addEventListener(event, handler, options);
  }
}

function closestFromEventTarget(event, selector) {
  const target = event?.target;
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest(selector);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmt(value, unit = "", digits = 0) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return `${value.toFixed(digits)}${unit}`;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function niceTicks(min, max, targetCount = 6, integerOnly = false) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return [];
  }
  const span = max - min;
  let rawStep = span / Math.max(2, targetCount - 1);
  if (integerOnly) {
    rawStep = Math.max(1, rawStep);
  }
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceNormalized = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  let step = niceNormalized * magnitude;
  if (integerOnly) {
    step = Math.max(1, Math.round(step));
  }
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let value = start; value <= max + step * 0.5; value += step) {
    ticks.push(value);
    if (ticks.length > 32) {
      break;
    }
  }
  return ticks;
}

function formatTimeTick(ms, spanMs) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  if (spanMs < 60_000) {
    const s = `${date.getSeconds()}`.padStart(2, "0");
    const msShort = `${Math.floor(date.getMilliseconds() / 100)}`;
    return `${s}.${msShort}s`;
  }

  if (spanMs < 3_600_000) {
    const m = `${date.getMinutes()}`.padStart(2, "0");
    const s = `${date.getSeconds()}`.padStart(2, "0");
    return `${m}:${s}`;
  }

  const h = `${date.getHours()}`.padStart(2, "0");
  const m = `${date.getMinutes()}`.padStart(2, "0");
  const s = `${date.getSeconds()}`.padStart(2, "0");
  return `${h}:${m}:${s}`;
}

class InteractiveSeriesChart {
  constructor(canvas, options) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext("2d") : null;
    this.disabled = !this.canvas || !this.ctx;

    this.options = {
      maxPoints: options.maxPoints ?? 5000,
      color: options.color ?? "#3a8ef6",
      yUnit: options.yUnit ?? "",
      yLabel: options.yLabel ?? "",
      minDefaultY: options.minDefaultY ?? 0,
      maxDefaultY: options.maxDefaultY ?? 1,
      lineWidth: options.lineWidth ?? 2,
      integerTicks: options.integerTicks ?? false,
      historyMs: options.historyMs ?? null,
      followLive: options.followLive ?? true,
      onRender: options.onRender ?? null,
    };

    this.points = [];
    this.dataMinX = 0;
    this.dataMaxX = 1;
    this.dataMinY = this.options.minDefaultY;
    this.dataMaxY = this.options.maxDefaultY;

    this.view = {
      xMin: 0,
      xMax: 1,
      yMin: this.options.minDefaultY,
      yMax: this.options.maxDefaultY,
    };

    this.layout = {
      left: 62,
      right: 16,
      top: 16,
      bottom: 34,
    };

    this.autoFit = true;
    this.followLive = this.options.followLive;
    this.drag = null;

    this.pixelWidth = 0;
    this.pixelHeight = 0;

    if (!this.disabled) {
      this.installEvents();
      this.resize();
      this.render();
    }
  }

  installEvents() {
    safeAddEvent(this.canvas, "mousedown", (event) => this.onMouseDown(event));
    safeAddEvent(window, "mousemove", (event) => this.onMouseMove(event));
    safeAddEvent(window, "mouseup", () => this.onMouseUp());
    safeAddEvent(this.canvas, "mouseleave", () => this.onMouseUp());
    safeAddEvent(this.canvas, "wheel", (event) => this.onWheel(event), { passive: false });
    safeAddEvent(this.canvas, "dblclick", () => this.resetView());
  }

  resize() {
    if (this.disabled) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const clientWidth = Math.max(200, this.canvas.clientWidth || 200);
    const clientHeight = Math.max(140, this.canvas.clientHeight || 140);

    const nextWidth = Math.round(clientWidth * dpr);
    const nextHeight = Math.round(clientHeight * dpr);

    if (nextWidth !== this.pixelWidth || nextHeight !== this.pixelHeight) {
      this.pixelWidth = nextWidth;
      this.pixelHeight = nextHeight;
      this.canvas.width = nextWidth;
      this.canvas.height = nextHeight;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  getClientRect() {
    const width = this.canvas.clientWidth || this.pixelWidth || 200;
    const height = this.canvas.clientHeight || this.pixelHeight || 140;

    const plotX = this.layout.left;
    const plotY = this.layout.top;
    const plotW = Math.max(20, width - this.layout.left - this.layout.right);
    const plotH = Math.max(20, height - this.layout.top - this.layout.bottom);

    return {
      width,
      height,
      plotX,
      plotY,
      plotW,
      plotH,
      plotRight: plotX + plotW,
      plotBottom: plotY + plotH,
    };
  }

  clampXRange() {
    if (!this.points.length) {
      return;
    }

    const dataSpan = Math.max(1, this.dataMaxX - this.dataMinX);
    let span = Math.max(1, this.view.xMax - this.view.xMin);

    if (span > dataSpan) {
      this.view.xMin = this.dataMinX;
      this.view.xMax = this.dataMaxX;
      return;
    }

    if (this.view.xMin < this.dataMinX) {
      this.view.xMax += this.dataMinX - this.view.xMin;
      this.view.xMin = this.dataMinX;
    }

    if (this.view.xMax > this.dataMaxX) {
      this.view.xMin -= this.view.xMax - this.dataMaxX;
      this.view.xMax = this.dataMaxX;
    }

    span = Math.max(1, this.view.xMax - this.view.xMin);
    if (span > dataSpan) {
      this.view.xMin = this.dataMinX;
      this.view.xMax = this.dataMaxX;
    }
  }

  addPoints(rawPoints) {
    if (this.disabled || !Array.isArray(rawPoints) || !rawPoints.length) {
      return;
    }

    for (const point of rawPoints) {
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }

      if (this.points.length > 0 && x <= this.points[this.points.length - 1].x) {
        const bumpX = this.points[this.points.length - 1].x + 1;
        this.points.push({ x: bumpX, y });
      } else {
        this.points.push({ x, y });
      }
    }

    if (!this.points.length) {
      return;
    }

    if (this.points.length > this.options.maxPoints) {
      this.points.splice(0, this.points.length - this.options.maxPoints);
    }

    if (Number.isFinite(this.options.historyMs) && this.options.historyMs > 0) {
      const latestX = this.points[this.points.length - 1].x;
      while (this.points.length > 1 && (latestX - this.points[0].x) > this.options.historyMs) {
        this.points.shift();
      }
    }

    if (!this.points.length) {
      return;
    }

    this.dataMinX = this.points[0].x;
    this.dataMaxX = this.points[this.points.length - 1].x;
    this.dataMinY = Math.min(...this.points.map((p) => p.y));
    this.dataMaxY = Math.max(...this.points.map((p) => p.y));

    if (this.followLive) {
      if (this.autoFit) {
        this.fitToData();
      } else {
        const spanX = Math.max(1, this.view.xMax - this.view.xMin);
        this.view.xMax = this.dataMaxX;
        this.view.xMin = this.dataMaxX - spanX;
        this.clampXRange();
      }
    } else if (this.autoFit) {
      this.fitToData();
    }

    this.render();
  }

  fitToData() {
    if (!this.points.length) {
      this.view.xMin = 0;
      this.view.xMax = 1;
      this.view.yMin = this.options.minDefaultY;
      this.view.yMax = this.options.maxDefaultY;
      return;
    }

    const xMin = this.dataMinX;
    let xMax = this.dataMaxX;
    if (xMax <= xMin) {
      xMax = xMin + 1000;
    }

    let yMin = this.dataMinY;
    let yMax = this.dataMaxY;
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = this.options.minDefaultY;
      yMax = this.options.maxDefaultY;
    }

    if (yMax <= yMin) {
      yMin -= 1;
      yMax += 1;
    }

    const ySpan = yMax - yMin;
    const margin = ySpan * 0.10;

    this.view.xMin = xMin;
    this.view.xMax = xMax;
    this.view.yMin = yMin - margin;
    this.view.yMax = yMax + margin;
  }

  resetView() {
    this.autoFit = true;
    this.fitToData();
    this.render();
  }

  setFollowLive(enabled) {
    this.followLive = Boolean(enabled);
    if (this.followLive) {
      if (this.autoFit) {
        this.fitToData();
      } else if (this.points.length) {
        const spanX = Math.max(1, this.view.xMax - this.view.xMin);
        this.view.xMax = this.dataMaxX;
        this.view.xMin = this.dataMaxX - spanX;
        this.clampXRange();
      }
    }
    this.render();
  }

  clearData() {
    this.points = [];
    this.dataMinX = 0;
    this.dataMaxX = 1;
    this.dataMinY = this.options.minDefaultY;
    this.dataMaxY = this.options.maxDefaultY;
    this.view.xMin = 0;
    this.view.xMax = 1;
    this.view.yMin = this.options.minDefaultY;
    this.view.yMax = this.options.maxDefaultY;
    this.autoFit = true;
    this.render();
  }

  xToPx(x, rect) {
    const span = Math.max(1, this.view.xMax - this.view.xMin);
    return rect.plotX + ((x - this.view.xMin) / span) * rect.plotW;
  }

  yToPx(y, rect) {
    const span = Math.max(1e-9, this.view.yMax - this.view.yMin);
    return rect.plotBottom - ((y - this.view.yMin) / span) * rect.plotH;
  }

  pxToX(px, rect) {
    const span = Math.max(1, this.view.xMax - this.view.xMin);
    return this.view.xMin + ((px - rect.plotX) / rect.plotW) * span;
  }

  pxToY(py, rect) {
    const span = Math.max(1e-9, this.view.yMax - this.view.yMin);
    return this.view.yMax - ((py - rect.plotY) / rect.plotH) * span;
  }

  normalizeWheelFactor(deltaY) {
    return Math.exp(deltaY * 0.0012);
  }

  onMouseDown(event) {
    if (this.disabled) {
      return;
    }

    const rect = this.getClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const x = event.clientX - canvasRect.left;
    const y = event.clientY - canvasRect.top;

    let mode = null;
    if (x >= rect.plotX && x <= rect.plotRight && y >= rect.plotY && y <= rect.plotBottom) {
      mode = "pan";
    } else if (x < rect.plotX && y >= rect.plotY && y <= rect.plotBottom) {
      mode = "axis-y";
    } else if (y > rect.plotBottom && x >= rect.plotX && x <= rect.plotRight) {
      mode = "axis-x";
    }

    if (!mode) {
      return;
    }

    event.preventDefault();
    this.autoFit = false;
    this.drag = {
      mode,
      startX: x,
      startY: y,
      startView: { ...this.view },
    };

    this.canvas.style.cursor = mode === "pan" ? "grabbing" : mode === "axis-x" ? "ew-resize" : "ns-resize";
  }

  onMouseMove(event) {
    if (this.disabled) {
      return;
    }

    const rect = this.getClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const x = event.clientX - canvasRect.left;
    const y = event.clientY - canvasRect.top;

    if (!this.drag) {
      if (x >= rect.plotX && x <= rect.plotRight && y >= rect.plotY && y <= rect.plotBottom) {
        this.canvas.style.cursor = "grab";
      } else if (x < rect.plotX && y >= rect.plotY && y <= rect.plotBottom) {
        this.canvas.style.cursor = "ns-resize";
      } else if (y > rect.plotBottom && x >= rect.plotX && x <= rect.plotRight) {
        this.canvas.style.cursor = "ew-resize";
      } else {
        this.canvas.style.cursor = "default";
      }
      return;
    }

    const dx = x - this.drag.startX;
    const dy = y - this.drag.startY;

    if (this.drag.mode === "pan") {
      const spanX = Math.max(1, this.drag.startView.xMax - this.drag.startView.xMin);
      const spanY = Math.max(1e-9, this.drag.startView.yMax - this.drag.startView.yMin);

      const dataDx = (-dx / rect.plotW) * spanX;
      const dataDy = (dy / rect.plotH) * spanY;

      this.view.xMin = this.drag.startView.xMin + dataDx;
      this.view.xMax = this.drag.startView.xMax + dataDx;
      this.view.yMin = this.drag.startView.yMin + dataDy;
      this.view.yMax = this.drag.startView.yMax + dataDy;

      this.clampXRange();
      this.render();
      return;
    }

    const scaleY = Math.exp(dy * 0.01);
    if (this.drag.mode === "axis-y") {
      const startSpan = Math.max(1e-9, this.drag.startView.yMax - this.drag.startView.yMin);
      const center = (this.drag.startView.yMin + this.drag.startView.yMax) / 2;
      const newSpan = Math.max(1e-6, startSpan * scaleY);
      this.view.yMin = center - newSpan / 2;
      this.view.yMax = center + newSpan / 2;
      this.render();
      return;
    }

    if (this.drag.mode === "axis-x") {
      const scaleX = Math.exp(dx * 0.01);
      const startSpan = Math.max(1, this.drag.startView.xMax - this.drag.startView.xMin);
      const center = (this.drag.startView.xMin + this.drag.startView.xMax) / 2;
      const newSpan = Math.max(100, startSpan * scaleX);
      this.view.xMin = center - newSpan / 2;
      this.view.xMax = center + newSpan / 2;
      this.clampXRange();
      this.render();
    }
  }

  onMouseUp() {
    if (this.disabled) {
      return;
    }

    this.drag = null;
    this.canvas.style.cursor = "default";
  }

  onWheel(event) {
    if (this.disabled) {
      return;
    }

    const rect = this.getClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const x = event.clientX - canvasRect.left;
    const y = event.clientY - canvasRect.top;

    if (x < rect.plotX || x > rect.plotRight || y < rect.plotY || y > rect.plotBottom) {
      return;
    }

    event.preventDefault();
    this.autoFit = false;

    const factor = this.normalizeWheelFactor(event.deltaY);
    const spanX = Math.max(1, this.view.xMax - this.view.xMin);
    const spanY = Math.max(1e-9, this.view.yMax - this.view.yMin);

    const anchorX = this.pxToX(x, rect);
    const anchorY = this.pxToY(y, rect);

    const newSpanX = Math.max(100, spanX * factor);
    const newSpanY = Math.max(1e-6, spanY * factor);

    const relX = (anchorX - this.view.xMin) / spanX;
    const relY = (anchorY - this.view.yMin) / spanY;

    this.view.xMin = anchorX - relX * newSpanX;
    this.view.xMax = this.view.xMin + newSpanX;
    this.view.yMin = anchorY - relY * newSpanY;
    this.view.yMax = this.view.yMin + newSpanY;

    this.clampXRange();
    this.render();
  }

  render() {
    if (this.disabled) {
      return;
    }

    this.resize();

    const ctx = this.ctx;
    const rect = this.getClientRect();
    const width = rect.width;
    const height = rect.height;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0f1722";
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#0b121b";
    ctx.fillRect(rect.plotX, rect.plotY, rect.plotW, rect.plotH);

    const xTicks = niceTicks(this.view.xMin, this.view.xMax, 6);
    const yTicks = niceTicks(this.view.yMin, this.view.yMax, 6, this.options.integerTicks);

    ctx.strokeStyle = "rgba(60, 80, 108, 0.45)";
    ctx.lineWidth = 1;

    for (const xTick of xTicks) {
      const px = this.xToPx(xTick, rect);
      ctx.beginPath();
      ctx.moveTo(px, rect.plotY);
      ctx.lineTo(px, rect.plotBottom);
      ctx.stroke();
    }

    for (const yTick of yTicks) {
      const py = this.yToPx(yTick, rect);
      ctx.beginPath();
      ctx.moveTo(rect.plotX, py);
      ctx.lineTo(rect.plotRight, py);
      ctx.stroke();
    }

    // Plot line
    const points = this.points;
    if (points.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.plotX, rect.plotY, rect.plotW, rect.plotH);
      ctx.clip();

      ctx.strokeStyle = this.options.color;
      ctx.lineWidth = this.options.lineWidth;
      ctx.beginPath();

      let started = false;
      for (const point of points) {
        if (point.x < this.view.xMin || point.x > this.view.xMax) {
          continue;
        }
        const px = this.xToPx(point.x, rect);
        const py = this.yToPx(point.y, rect);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }

      if (started) {
        ctx.stroke();
      }
      ctx.restore();
    }

    // Axes
    ctx.strokeStyle = "#6d809a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rect.plotX, rect.plotY);
    ctx.lineTo(rect.plotX, rect.plotBottom);
    ctx.lineTo(rect.plotRight, rect.plotBottom);
    ctx.stroke();

    ctx.fillStyle = "#9fb1c9";
    ctx.font = "11px JetBrains Mono, monospace";

    for (const yTick of yTicks) {
      const py = this.yToPx(yTick, rect);
      const yValue = this.options.integerTicks
        ? `${Math.round(yTick)}`
        : `${yTick.toFixed(Math.abs(yTick) < 10 ? 2 : 1)}`;
      const label = this.options.yUnit ? `${yValue} ${this.options.yUnit}` : yValue;
      ctx.fillText(label, 6, py + 3);
    }

    const spanMs = Math.max(1, this.view.xMax - this.view.xMin);
    for (const xTick of xTicks) {
      const px = this.xToPx(xTick, rect);
      const label = formatTimeTick(xTick, spanMs);
      const textW = ctx.measureText(label).width;
      ctx.fillText(label, px - textW / 2, height - 10);
    }

    ctx.fillStyle = "#7f93af";
    ctx.fillText(this.options.yLabel, 6, 12);
    ctx.fillText("Time", rect.plotX + rect.plotW - 28, height - 22);

    if (!points.length) {
      ctx.fillStyle = "#7f93af";
      ctx.font = "13px JetBrains Mono, monospace";
      ctx.fillText("Waiting for signal...", rect.plotX + 14, rect.plotY + 26);
    }

    if (typeof this.options.onRender === "function") {
      this.options.onRender(this);
    }
  }
}

let hrChartRef = null;
let state = null;

const dom = {
  pulsarHome: document.getElementById("pulsar-home"),
  connectionChip: document.getElementById("connection-chip"),
  connectionDot: document.getElementById("connection-dot"),
  connectionLabel: document.getElementById("connection-label"),
  openConnectBtn: document.getElementById("open-connect-btn"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  connectionModal: document.getElementById("connection-modal"),
  scanBtn: document.getElementById("scan-btn"),
  activityIndicator: document.getElementById("activity-indicator"),
  activityLabel: document.getElementById("activity-label"),
  deviceStatus: document.getElementById("device-status"),
  deviceList: document.getElementById("device-list"),
  eventLog: document.getElementById("event-log"),
  recordToggleBtn: document.getElementById("record-toggle-btn"),
  mainMenu: document.getElementById("main-menu"),
  newSessionBtn: document.getElementById("new-session-btn"),
  viewRecordingsBtn: document.getElementById("view-recordings-btn"),
  dashboard: document.querySelector(".dashboard"),
  controlRibbon: document.querySelector(".control-ribbon"),
  viewerSessionActions: document.getElementById("viewer-session-actions"),
  viewerSessionNameInput: document.getElementById("viewer-session-name-input"),
  viewerSessionSaveBtn: document.getElementById("viewer-session-save-btn"),
  viewerDeleteSessionBtn: document.getElementById("viewer-delete-session-btn"),
  refreshSessionsBtn: document.getElementById("refresh-sessions-btn"),
  sessionsBody: document.getElementById("sessions-body"),
  sessionsPanel: document.querySelector(".sessions-panel"),
  sessionsTableWrap: document.querySelector(".sessions-panel .table-wrap"),
  sessionsResizer: document.getElementById("sessions-resizer"),
  currentHrStatCard: document.getElementById("current-hr-stat-card"),
  statHr: document.getElementById("stat-hr"),
  statMinHr: document.getElementById("stat-min-hr"),
  statMaxHr: document.getElementById("stat-max-hr"),
  statZone: document.getElementById("stat-zone"),
  zoneStatCard: document.getElementById("zone-stat-card"),
  viewerZoneSummary: document.getElementById("viewer-zone-summary"),
  viewerZoneMaxHr: document.getElementById("viewer-zone-maxhr"),
  viewerZoneBadges: document.getElementById("viewer-zone-badges"),
  hrCanvas: document.getElementById("hr-canvas"),
  hrPanel: document.querySelector('.chart-panel[data-chart="hr"]'),
  hrMarkerOverlay: document.getElementById("hr-marker-overlay"),
  markerPopover: document.getElementById("marker-popover"),
  markerPopoverLabel: document.getElementById("marker-popover-label"),
  markerPopoverColor: document.getElementById("marker-popover-color"),
  markerPopoverOk: document.getElementById("marker-popover-ok"),
  markerPopoverDelete: document.getElementById("marker-popover-delete"),
  markerTestPopover: document.getElementById("marker-test-popover"),
  markerTestHrr60Btn: document.getElementById("marker-test-hrr60-btn"),
  testResultModal: document.getElementById("test-result-modal"),
  testResultTitle: document.getElementById("test-result-title"),
  testResultContent: document.getElementById("test-result-content"),
  testResultCloseBtn: document.getElementById("test-result-close-btn"),
  markerPresetLabels: [
    document.getElementById("marker-preset-label-1"),
    document.getElementById("marker-preset-label-2"),
    document.getElementById("marker-preset-label-3"),
    document.getElementById("marker-preset-label-4"),
    document.getElementById("marker-preset-label-5"),
  ],
  markerPresetColors: [
    document.getElementById("marker-preset-color-1"),
    document.getElementById("marker-preset-color-2"),
    document.getElementById("marker-preset-color-3"),
    document.getElementById("marker-preset-color-4"),
    document.getElementById("marker-preset-color-5"),
  ],
  rrPanel: document.getElementById("rr-panel"),
  ecgPanel: document.getElementById("ecg-panel"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsMenu: document.getElementById("settings-menu"),
  settingsRrRow: document.getElementById("settings-rr-row"),
  settingShowRr: document.getElementById("setting-show-rr"),
  settingDebug: document.getElementById("setting-debug"),
  chartLockButtons: Array.from(document.querySelectorAll(".chart-lock-btn")),
  chartResizers: Array.from(document.querySelectorAll(".chart-resizer")),
};

const charts = {
  hr: new InteractiveSeriesChart(document.getElementById("hr-canvas"), {
    maxPoints: 18_000,
    color: "#2f8cff",
    yUnit: "bpm",
    yLabel: "Heart Rate",
    minDefaultY: 40,
    maxDefaultY: 200,
    integerTicks: true,
    onRender: (chart) => {
      hrChartRef = chart;
      renderHrMarkerOverlay(chart);
    },
  }),
  rr: new InteractiveSeriesChart(document.getElementById("rr-canvas"), {
    maxPoints: 18_000,
    color: "#9f75ff",
    yUnit: "ms",
    yLabel: "RR Interval",
    minDefaultY: 300,
    maxDefaultY: 1600,
  }),
  ecg: new InteractiveSeriesChart(document.getElementById("ecg-canvas"), {
    maxPoints: 4_000,
    color: "#28c77d",
    yUnit: "uV",
    yLabel: "ECG",
    minDefaultY: -1200,
    maxDefaultY: 1200,
    lineWidth: 1.4,
    historyMs: 15_000,
  }),
};
hrChartRef = charts.hr;

state = {
  mode: "main",
  ws: null,
  wsReconnectDelayMs: 500,
  wsConnected: false,
  wsEnabled: false,
  connected: false,
  recording: false,
  activeDeviceId: null,
  activeDeviceName: null,
  sessions: [],
  viewerSessionId: null,
  viewerSessionName: "",
  viewerZoneBreakdown: [],
  viewerHrMax: null,
  latestHrTimeMs: null,
  lastMarkersKey: "",
  markers: [],
  selectedMarkerId: null,
  markerPresets: DEFAULT_MARKER_PRESETS.map((item) => ({ ...item })),
  hrHover: {
    inside: false,
    dataX: null,
    clientX: 0,
    clientY: 0,
  },
  markerPopover: {
    open: false,
    mode: "add",
    markerId: null,
    timeMs: null,
  },
  markerTestPopover: {
    open: false,
    markerId: null,
    timeMs: null,
  },
  markerPointer: null,
  currentDevices: [],
  modalBusy: false,
  hasSignal: false,
  showRr: false,
  debugMode: false,
  recordingBusy: false,
  homeBusy: false,
  chartResize: null,
  sessionsResize: null,
};

(function hydrateSettings() {
  try {
    state.showRr = window.localStorage.getItem(STORAGE_SHOW_RR) === "1";
    state.debugMode = window.localStorage.getItem(STORAGE_DEBUG_MODE) === "1";
  } catch {
    state.showRr = false;
    state.debugMode = false;
  }
})();

function log(message, isError = false) {
  if (!dom.eventLog) {
    return;
  }
  const now = new Date().toLocaleTimeString();
  dom.eventLog.textContent = `[${now}] ${message}`;
  dom.eventLog.style.color = isError ? "#f1a5ae" : "#95a6bc";
}

function setModalBusy(busy, label = "") {
  state.modalBusy = busy;
  if (dom.scanBtn) {
    dom.scanBtn.disabled = busy;
  }
  if (dom.activityIndicator) {
    dom.activityIndicator.classList.toggle("hidden", !busy);
  }
  if (dom.activityLabel && label) {
    dom.activityLabel.textContent = label;
  }
}

function setDeviceStatus(message, isError = false) {
  if (!dom.deviceStatus) {
    log(message, isError);
    return;
  }
  dom.deviceStatus.textContent = message;
  dom.deviceStatus.style.color = isError ? "#f1a5ae" : "#95a6bc";
}

function openConnectModal() {
  if (!dom.connectionModal || state.mode !== "live") {
    return;
  }
  if (state.connected && state.activeDeviceId) {
    const connectedOnly = state.currentDevices.filter((device) => device.address === state.activeDeviceId);
    if (connectedOnly.length) {
      renderDeviceList(connectedOnly);
    } else {
      renderDeviceList([
        {
          name: state.activeDeviceName || state.activeDeviceId,
          address: state.activeDeviceId,
          rssi: null,
        },
      ]);
    }
  } else if (!state.currentDevices.length) {
    renderDeviceList([]);
  }
  setDeviceStatus("");
  dom.connectionModal.classList.remove("hidden");
  dom.connectionModal.setAttribute("aria-hidden", "false");
}

function closeConnectModal() {
  if (!dom.connectionModal || state.modalBusy) {
    return;
  }
  dom.connectionModal.classList.add("hidden");
  dom.connectionModal.setAttribute("aria-hidden", "true");
}

function clearLiveVisualState() {
  charts.hr.clearData();
  charts.rr.clearData();
  charts.ecg.clearData();
  state.markers = [];
  state.selectedMarkerId = null;
  state.lastMarkersKey = "";
  state.hasSignal = false;
  closeMarkerPopover();
  closeMarkerTestPopover();
  closeTestResultModal();
  state.viewerZoneBreakdown = [];
  state.viewerHrMax = null;
  state.viewerSessionName = "";
  state.latestHrTimeMs = null;
  renderStats({}, {});
  renderViewerZoneSummary([], null);
  renderHrMarkerOverlay();
}

function setSessionsTableHeight(heightPx) {
  if (!dom.sessionsTableWrap) {
    return;
  }
  const safeHeight = Math.max(140, Math.min(520, Math.round(heightPx)));
  dom.sessionsTableWrap.style.height = `${safeHeight}px`;
  try {
    window.localStorage.setItem(STORAGE_SESSIONS_HEIGHT, `${safeHeight}`);
  } catch {
    // ignore storage errors
  }
}

function hydrateSessionsTableHeight() {
  if (!dom.sessionsTableWrap) {
    return;
  }
  let stored = null;
  try {
    stored = Number(window.localStorage.getItem(STORAGE_SESSIONS_HEIGHT));
  } catch {
    stored = null;
  }
  if (Number.isFinite(stored)) {
    setSessionsTableHeight(stored);
  }
}

function closeTestResultModal() {
  if (!dom.testResultModal) {
    return;
  }
  dom.testResultModal.classList.add("hidden");
  dom.testResultModal.setAttribute("aria-hidden", "true");
}

function openTestResultModal(title, lines) {
  if (!dom.testResultModal || !dom.testResultTitle || !dom.testResultContent) {
    return;
  }
  dom.testResultTitle.textContent = title;
  dom.testResultContent.textContent = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
  dom.testResultModal.classList.remove("hidden");
  dom.testResultModal.setAttribute("aria-hidden", "false");
}

function renderViewerZoneSummary(zoneBreakdown = [], hrMax = null) {
  const show = state.mode === "viewer" && Array.isArray(zoneBreakdown) && zoneBreakdown.length > 0;
  if (dom.viewerZoneSummary) {
    dom.viewerZoneSummary.classList.toggle("hidden", !show);
  }
  if (!show) {
    if (dom.viewerZoneBadges) {
      dom.viewerZoneBadges.innerHTML = "";
    }
    if (dom.viewerZoneMaxHr) {
      dom.viewerZoneMaxHr.textContent = "";
    }
    return;
  }

  if (dom.viewerZoneMaxHr) {
    const maxHrText = Number.isFinite(Number(hrMax)) ? `${Math.round(Number(hrMax))} bpm` : "—";
    dom.viewerZoneMaxHr.textContent = `Zone model max HR: ${maxHrText}`;
  }
  if (dom.viewerZoneBadges) {
    dom.viewerZoneBadges.innerHTML = "";
    for (const zone of zoneBreakdown) {
      const badge = document.createElement("span");
      badge.className = "zone-badge";
      const color = normalizeMarkerColor(zone.color, "#5a7392");
      badge.style.borderColor = color;
      badge.style.color = color;
      const threshold = Number.isFinite(Number(zone.threshold_bpm)) ? Math.round(Number(zone.threshold_bpm)) : "—";
      const pct = Number.isFinite(Number(zone.pct)) ? `${Math.round(Number(zone.pct))}%` : "0%";
      badge.textContent = `${zone.label || "Zone"} (${threshold}) ${pct}`;
      dom.viewerZoneBadges.appendChild(badge);
    }
  }
}

function applyModeUi() {
  const isMain = state.mode === "main";
  const isLive = state.mode === "live";
  const isViewer = state.mode === "viewer";

  if (dom.mainMenu) {
    dom.mainMenu.classList.toggle("hidden", !isMain);
  }
  if (dom.dashboard) {
    dom.dashboard.classList.toggle("hidden", isMain);
  }
  if (dom.controlRibbon) {
    dom.controlRibbon.classList.toggle("hidden", !isLive);
  }
  if (dom.sessionsPanel) {
    dom.sessionsPanel.classList.toggle("hidden", !isViewer);
  }
  if (dom.viewerSessionActions) {
    dom.viewerSessionActions.classList.toggle("hidden", !isViewer || !state.viewerSessionId);
  }
  if (dom.openConnectBtn) {
    dom.openConnectBtn.classList.toggle("hidden", !isLive || state.connected);
  }
  if (dom.disconnectBtn) {
    dom.disconnectBtn.classList.toggle("hidden", !isLive || !state.connected);
  }
  if (dom.connectionChip) {
    dom.connectionChip.classList.toggle("hidden", !isLive);
  }
  if (dom.settingsRrRow) {
    dom.settingsRrRow.classList.toggle("hidden", !isLive);
  }
  if (dom.viewerZoneSummary) {
    dom.viewerZoneSummary.classList.toggle("hidden", !isViewer || state.viewerZoneBreakdown.length === 0);
  }
  if (dom.currentHrStatCard) {
    dom.currentHrStatCard.classList.toggle("hidden", isViewer);
  }
  if (dom.zoneStatCard) {
    dom.zoneStatCard.classList.toggle("hidden", isViewer);
  }
  if (dom.ecgPanel) {
    dom.ecgPanel.classList.toggle("hidden", isViewer);
  }

  applySettingsUi();
  if (isMain || isViewer) {
    closeConnectModal();
  }
  updateRecordToggleButton();
}

function setMode(nextMode) {
  if (!["main", "live", "viewer"].includes(nextMode)) {
    return;
  }
  state.mode = nextMode;
  applyModeUi();
}

function applySettingsUi() {
  if (dom.settingShowRr) {
    dom.settingShowRr.checked = state.showRr;
    dom.settingShowRr.disabled = state.mode !== "live";
  }
  if (dom.settingDebug) {
    dom.settingDebug.checked = state.debugMode;
  }
  if (dom.rrPanel) {
    const showRr = state.mode === "live" && state.showRr;
    dom.rrPanel.classList.toggle("hidden", !showRr);
  }
  if (dom.eventLog) {
    dom.eventLog.classList.toggle("debug-hidden", !state.debugMode);
    if (!state.debugMode) {
      dom.eventLog.textContent = "";
    }
  }
}

function persistShowRr() {
  try {
    window.localStorage.setItem(STORAGE_SHOW_RR, state.showRr ? "1" : "0");
  } catch {
    // ignore storage errors
  }
}

function persistDebugMode() {
  try {
    window.localStorage.setItem(STORAGE_DEBUG_MODE, state.debugMode ? "1" : "0");
  } catch {
    // ignore storage errors
  }
}

function chartFollowStorageKey(chartKey) {
  return `${STORAGE_FOLLOW_PREFIX}${chartKey}`;
}

function chartHeightStorageKey(chartKey) {
  return `${STORAGE_CHART_HEIGHT_PREFIX}${chartKey}`;
}

function persistChartFollow(chartKey, followLive) {
  try {
    window.localStorage.setItem(chartFollowStorageKey(chartKey), followLive ? "1" : "0");
  } catch {
    // ignore storage errors
  }
}

function persistChartHeight(chartKey, heightPx) {
  try {
    window.localStorage.setItem(chartHeightStorageKey(chartKey), `${Math.round(heightPx)}`);
  } catch {
    // ignore storage errors
  }
}

function setChartLockButtonUi(chartKey, followLive) {
  const button = dom.chartLockButtons.find((entry) => entry.dataset.chart === chartKey);
  if (!button) {
    return;
  }

  button.classList.toggle("unlocked", !followLive);
  button.classList.toggle("locked", followLive);
  button.textContent = followLive ? "🔒" : "🔓";
  button.title = followLive ? "Live follow locked" : "Live follow unlocked";
}

function hydrateChartPreferences() {
  for (const [chartKey, chart] of Object.entries(charts)) {
    let followLive = true;
    let storedHeight = null;

    try {
      const storedFollow = window.localStorage.getItem(chartFollowStorageKey(chartKey));
      if (storedFollow === "0") {
        followLive = false;
      }
      storedHeight = Number(window.localStorage.getItem(chartHeightStorageKey(chartKey)));
    } catch {
      followLive = true;
      storedHeight = null;
    }

    chart.setFollowLive(followLive);
    setChartLockButtonUi(chartKey, followLive);

    if (chart.canvas && Number.isFinite(storedHeight) && storedHeight >= 140 && storedHeight <= 520) {
      chart.canvas.style.height = `${storedHeight}px`;
      chart.render();
    }
  }
}

function updateRecordToggleButton() {
  if (!dom.recordToggleBtn) {
    return;
  }

  dom.recordToggleBtn.textContent = state.recording ? "Stop Record" : "Record";
  dom.recordToggleBtn.classList.toggle("danger", state.recording);
  dom.recordToggleBtn.classList.toggle("success", !state.recording);
  dom.recordToggleBtn.disabled = state.recordingBusy || (!state.connected && !state.recording);
}

function normalizeMarkerColor(value, fallback = "#f4be37") {
  const text = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) {
    return text.toLowerCase();
  }
  return fallback;
}

function parseMarkerTimestampMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function markerIsoFromMs(ms) {
  return new Date(ms).toISOString();
}

function sortMarkersInState() {
  state.markers.sort((a, b) => parseMarkerTimestampMs(a.timestamp) - parseMarkerTimestampMs(b.timestamp));
}

function getMarkerById(markerId) {
  return state.markers.find((marker) => marker.id === markerId) || null;
}

function persistMarkerPresets() {
  try {
    window.localStorage.setItem(STORAGE_MARKER_PRESETS, JSON.stringify(state.markerPresets));
  } catch {
    // ignore storage errors
  }
}

function renderMarkerPresetInputs() {
  for (let idx = 0; idx < 5; idx += 1) {
    const preset = state.markerPresets[idx];
    const labelInput = dom.markerPresetLabels[idx];
    const colorInput = dom.markerPresetColors[idx];
    if (labelInput) {
      labelInput.value = preset.label;
    }
    if (colorInput) {
      colorInput.value = preset.color;
    }
  }
}

function commitMarkerPresetInputs() {
  state.markerPresets = state.markerPresets.map((preset, idx) => {
    const labelInput = dom.markerPresetLabels[idx];
    const colorInput = dom.markerPresetColors[idx];
    const nextLabel = labelInput?.value?.trim() || `Marker ${idx + 1}`;
    const nextColor = normalizeMarkerColor(colorInput?.value, preset.color);
    return {
      label: nextLabel,
      color: nextColor,
    };
  });
  renderMarkerPresetInputs();
  persistMarkerPresets();
}

function hydrateMarkerPresets() {
  try {
    const raw = window.localStorage.getItem(STORAGE_MARKER_PRESETS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.markerPresets = DEFAULT_MARKER_PRESETS.map((fallback, idx) => {
          const incoming = parsed[idx] || {};
          return {
            label: String(incoming.label || fallback.label).slice(0, 40),
            color: normalizeMarkerColor(incoming.color, fallback.color),
          };
        });
      }
    }
  } catch {
    state.markerPresets = DEFAULT_MARKER_PRESETS.map((item) => ({ ...item }));
  }
  renderMarkerPresetInputs();
}

function upsertLocalMarker(marker) {
  if (!marker || !marker.id) {
    return;
  }

  const normalized = {
    id: marker.id,
    label: marker.label || "Marker",
    color: normalizeMarkerColor(marker.color),
    timestamp: marker.timestamp || new Date().toISOString(),
    sample_index: Number.isFinite(Number(marker.sample_index)) ? Number(marker.sample_index) : null,
  };

  const idx = state.markers.findIndex((entry) => entry.id === normalized.id);
  if (idx >= 0) {
    state.markers[idx] = normalized;
  } else {
    state.markers.push(normalized);
  }

  sortMarkersInState();
  state.lastMarkersKey = "";
  renderHrMarkerOverlay();
}

function removeLocalMarker(markerId) {
  state.markers = state.markers.filter((marker) => marker.id !== markerId);
  if (state.selectedMarkerId === markerId) {
    state.selectedMarkerId = null;
    closeMarkerTestPopover();
  }
  state.lastMarkersKey = "";
  renderHrMarkerOverlay();
}

function syncMarkersFromPayload(markers) {
  const key = JSON.stringify(markers || []);
  if (key === state.lastMarkersKey) {
    return;
  }
  state.lastMarkersKey = key;

  state.markers = (markers || []).map((marker) => ({
    id: marker.id,
    label: marker.label || "Marker",
    color: normalizeMarkerColor(marker.color),
    timestamp: marker.timestamp || new Date().toISOString(),
    sample_index: Number.isFinite(Number(marker.sample_index)) ? Number(marker.sample_index) : null,
  }));
  sortMarkersInState();

  if (state.selectedMarkerId && !getMarkerById(state.selectedMarkerId)) {
    state.selectedMarkerId = null;
    closeMarkerTestPopover();
    if (state.markerPopover.open && state.markerPopover.mode === "edit") {
      closeMarkerPopover();
    }
  }

  renderHrMarkerOverlay();
}

function activeMarkerSessionId() {
  if (state.mode === "viewer" && Number.isFinite(Number(state.viewerSessionId))) {
    return Number(state.viewerSessionId);
  }
  return null;
}

async function createMarkerAtTime(label, color, timeMs) {
  const safeTime = Number.isFinite(timeMs) ? timeMs : Date.now();
  const sessionId = activeMarkerSessionId();
  const payload = await api("/api/marker", {
    method: "POST",
    body: {
      label,
      color,
      timestamp: markerIsoFromMs(safeTime),
      ...(sessionId ? { session_id: sessionId } : {}),
    },
  });
  upsertLocalMarker(payload.marker);
  return payload.marker;
}

async function updateMarkerById(markerId, updates) {
  const sessionId = activeMarkerSessionId();
  const payload = await api(`/api/marker/${encodeURIComponent(markerId)}`, {
    method: "PATCH",
    body: {
      ...updates,
      ...(sessionId ? { session_id: sessionId } : {}),
    },
  });
  upsertLocalMarker(payload.marker);
  return payload.marker;
}

async function deleteMarkerById(markerId) {
  const sessionId = activeMarkerSessionId();
  const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
  await api(`/api/marker/${encodeURIComponent(markerId)}${query}`, {
    method: "DELETE",
  });
  removeLocalMarker(markerId);
}

function markerTimeForNow() {
  if (Number.isFinite(charts.hr?.dataMaxX)) {
    return charts.hr.dataMaxX;
  }
  return Date.now();
}

function markerTimeForPreset() {
  if (Number.isFinite(state.latestHrTimeMs)) {
    return state.latestHrTimeMs;
  }
  return markerTimeForNow();
}

function renderHrMarkerOverlay(chartInstance = null) {
  const chart = chartInstance || hrChartRef;
  if (!dom.hrMarkerOverlay || !dom.hrCanvas || !chart || chart.disabled || !state || !Array.isArray(state.markers)) {
    return;
  }

  dom.hrMarkerOverlay.innerHTML = "";

  if (!state.markers.length || !chart.points.length) {
    return;
  }

  const rect = chart.getClientRect();
  const canvasLeft = dom.hrCanvas.offsetLeft;
  const canvasTop = dom.hrCanvas.offsetTop;

  for (const marker of state.markers) {
    const timeMs = parseMarkerTimestampMs(marker.timestamp);
    if (!Number.isFinite(timeMs) || timeMs < chart.view.xMin || timeMs > chart.view.xMax) {
      continue;
    }

    const x = canvasLeft + chart.xToPx(timeMs, rect);
    const yTop = canvasTop + rect.plotY;
    const selected = state.selectedMarkerId === marker.id;
    const markerColor = normalizeMarkerColor(marker.color);

    const line = document.createElement("div");
    line.className = `hr-marker-line${selected ? " selected" : ""}`;
    line.style.left = `${x}px`;
    line.style.top = `${yTop}px`;
    line.style.height = `${rect.plotH}px`;
    line.style.color = markerColor;
    dom.hrMarkerOverlay.appendChild(line);

    const labelButton = document.createElement("button");
    labelButton.type = "button";
    labelButton.className = `hr-marker-label${selected ? " selected" : ""}`;
    labelButton.dataset.markerId = marker.id;
    labelButton.style.left = `${x}px`;
    labelButton.style.top = `${yTop + 4}px`;
    labelButton.style.color = markerColor;
    labelButton.style.borderColor = markerColor;
    labelButton.textContent = marker.label || "Marker";
    dom.hrMarkerOverlay.appendChild(labelButton);
  }

  if (state.markerPopover.open) {
    positionMarkerPopover(state.markerPopover.timeMs);
  }
  if (state.markerTestPopover.open) {
    positionMarkerTestPopover(state.markerTestPopover.timeMs);
  }
}

function setHrHoverFromMouse(event) {
  if (!dom.hrCanvas || charts.hr.disabled) {
    state.hrHover.inside = false;
    state.hrHover.dataX = null;
    return;
  }

  const canvasRect = dom.hrCanvas.getBoundingClientRect();
  const rect = charts.hr.getClientRect();
  const x = event.clientX - canvasRect.left;
  const y = event.clientY - canvasRect.top;
  const inside = x >= rect.plotX && x <= rect.plotRight && y >= rect.plotY && y <= rect.plotBottom;

  state.hrHover.inside = inside;
  state.hrHover.dataX = inside ? charts.hr.pxToX(x, rect) : null;
  state.hrHover.clientX = event.clientX;
  state.hrHover.clientY = event.clientY;
}

function clearHrHover() {
  state.hrHover.inside = false;
  state.hrHover.dataX = null;
}

function closeMarkerPopover() {
  state.markerPopover.open = false;
  state.markerPopover.mode = "add";
  state.markerPopover.markerId = null;
  state.markerPopover.timeMs = null;
  if (dom.markerPopover) {
    dom.markerPopover.classList.add("hidden");
  }
}

function closeMarkerTestPopover() {
  state.markerTestPopover.open = false;
  state.markerTestPopover.markerId = null;
  state.markerTestPopover.timeMs = null;
  if (dom.markerTestPopover) {
    dom.markerTestPopover.classList.add("hidden");
  }
}

function positionMarkerPopover(timeMs) {
  if (!dom.markerPopover || !dom.hrPanel || !dom.hrCanvas || charts.hr.disabled) {
    return;
  }

  const chart = charts.hr;
  const rect = chart.getClientRect();
  const anchorMs = Number.isFinite(timeMs) ? timeMs : markerTimeForNow();
  const x = dom.hrCanvas.offsetLeft + chart.xToPx(anchorMs, rect);
  const popWidth = dom.markerPopover.offsetWidth || 220;
  const minLeft = 8;
  const maxLeft = Math.max(8, dom.hrPanel.clientWidth - popWidth - 8);
  const left = Math.max(minLeft, Math.min(maxLeft, x - popWidth / 2));
  const top = dom.hrCanvas.offsetTop + rect.plotY + 24;

  dom.markerPopover.style.left = `${left}px`;
  dom.markerPopover.style.top = `${top}px`;
}

function positionMarkerTestPopover(timeMs) {
  if (!dom.markerTestPopover || !dom.hrPanel || !dom.hrCanvas || charts.hr.disabled) {
    return;
  }

  const chart = charts.hr;
  const rect = chart.getClientRect();
  const anchorMs = Number.isFinite(timeMs) ? timeMs : markerTimeForNow();
  const x = dom.hrCanvas.offsetLeft + chart.xToPx(anchorMs, rect);
  const popWidth = dom.markerTestPopover.offsetWidth || 46;
  const minLeft = 8;
  const maxLeft = Math.max(8, dom.hrPanel.clientWidth - popWidth - 8);
  const left = Math.max(minLeft, Math.min(maxLeft, x - popWidth / 2));
  const top = dom.hrCanvas.offsetTop + rect.plotY + 28;

  dom.markerTestPopover.style.left = `${left}px`;
  dom.markerTestPopover.style.top = `${top}px`;
}

function openMarkerPopover(mode, options) {
  if (!dom.markerPopover || !dom.markerPopoverLabel || !dom.markerPopoverColor || !dom.markerPopoverDelete) {
    return;
  }

  const nextMode = mode === "edit" ? "edit" : "add";
  const markerId = nextMode === "edit" ? options.markerId : null;
  const timeMs = Number.isFinite(options.timeMs) ? options.timeMs : markerTimeForNow();
  const label = options.label || "Marker";
  const color = normalizeMarkerColor(options.color, "#f4be37");

  closeMarkerTestPopover();
  state.markerPopover.open = true;
  state.markerPopover.mode = nextMode;
  state.markerPopover.markerId = markerId;
  state.markerPopover.timeMs = timeMs;

  dom.markerPopoverLabel.value = label;
  dom.markerPopoverColor.value = color;
  dom.markerPopoverDelete.classList.toggle("hidden", nextMode !== "edit");
  dom.markerPopover.classList.remove("hidden");

  window.requestAnimationFrame(() => {
    positionMarkerPopover(timeMs);
    dom.markerPopoverLabel.focus();
    dom.markerPopoverLabel.select();
  });
}

function openMarkerTestPopover(marker) {
  if (!marker || !dom.markerTestPopover) {
    return;
  }
  closeMarkerPopover();
  state.markerTestPopover.open = true;
  state.markerTestPopover.markerId = marker.id;
  state.markerTestPopover.timeMs = parseMarkerTimestampMs(marker.timestamp);
  dom.markerTestPopover.classList.remove("hidden");
  window.requestAnimationFrame(() => {
    positionMarkerTestPopover(state.markerTestPopover.timeMs);
  });
}

function openMarkerTestMenuFromSelection() {
  if (state.mode !== "viewer" || !state.selectedMarkerId || !activeMarkerSessionId()) {
    return;
  }
  const marker = getMarkerById(state.selectedMarkerId);
  if (!marker) {
    return;
  }
  openMarkerTestPopover(marker);
}

async function runHrr60FromSelectedMarker() {
  if (state.mode !== "viewer") {
    return;
  }
  const sessionId = activeMarkerSessionId();
  const markerId = state.markerTestPopover.markerId || state.selectedMarkerId;
  if (!sessionId || !markerId) {
    return;
  }

  try {
    const payload = await api(`/api/session/${sessionId}/tests/hrr60`, {
      method: "POST",
      body: { marker_id: markerId },
    });
    const result = payload.result || {};
    openTestResultModal(
      "HRR60 Result",
      [
        `HR at marker: ${result.hr_at_marker_bpm ?? "—"} bpm`,
        `HR at +60s: ${result.hr_at_60s_bpm ?? "—"} bpm`,
        `Delta (HRR60): ${result.delta_bpm ?? "—"} bpm`,
      ],
    );
    closeMarkerTestPopover();
  } catch (err) {
    log(`HRR60 test failed: ${err.message}`, true);
  }
}

async function submitMarkerPopover() {
  if (!state.markerPopover.open || !dom.markerPopoverLabel || !dom.markerPopoverColor) {
    return;
  }

  const label = dom.markerPopoverLabel.value.trim() || "Marker";
  const color = normalizeMarkerColor(dom.markerPopoverColor.value, "#f4be37");

  try {
    if (state.markerPopover.mode === "add") {
      await createMarkerAtTime(label, color, state.markerPopover.timeMs);
    } else {
      const markerId = state.markerPopover.markerId;
      if (!markerId) {
        return;
      }
      await updateMarkerById(markerId, { label, color });
    }
    state.selectedMarkerId = null;
    closeMarkerPopover();
    renderHrMarkerOverlay();
  } catch (err) {
    log(`Marker save failed: ${err.message}`, true);
  }
}

async function deleteMarkerFromPopover() {
  if (!state.markerPopover.open || state.markerPopover.mode !== "edit") {
    return;
  }
  const markerId = state.markerPopover.markerId;
  if (!markerId) {
    return;
  }

  try {
    await deleteMarkerById(markerId);
    closeMarkerPopover();
  } catch (err) {
    log(`Marker delete failed: ${err.message}`, true);
  }
}

function openAddMarkerFromHover() {
  if (state.mode !== "live" && state.mode !== "viewer") {
    return;
  }
  if (state.mode === "viewer" && !activeMarkerSessionId()) {
    log("Load a recording before adding markers.", true);
    return;
  }
  if (!state.hrHover.inside || !Number.isFinite(state.hrHover.dataX)) {
    log("Hover the HR plot and press M to add a marker.", true);
    return;
  }

  const preset = state.markerPresets[0] || DEFAULT_MARKER_PRESETS[0];
  openMarkerPopover("add", {
    timeMs: state.hrHover.dataX,
    label: preset.label,
    color: preset.color,
  });
}

function openEditMarkerFromSelection() {
  if (!state.selectedMarkerId) {
    return;
  }
  const marker = getMarkerById(state.selectedMarkerId);
  if (!marker) {
    return;
  }
  openMarkerPopover("edit", {
    markerId: marker.id,
    timeMs: parseMarkerTimestampMs(marker.timestamp),
    label: marker.label,
    color: marker.color,
  });
}

async function addPresetMarker(slot) {
  if (state.mode !== "live" && state.mode !== "viewer") {
    return;
  }
  if (state.mode === "viewer" && !activeMarkerSessionId()) {
    return;
  }
  const preset = state.markerPresets[slot - 1];
  if (!preset) {
    return;
  }

  try {
    await createMarkerAtTime(preset.label, preset.color, markerTimeForPreset());
    state.selectedMarkerId = null;
    renderHrMarkerOverlay();
  } catch (err) {
    log(`Marker add failed: ${err.message}`, true);
  }
}

function toggleSelectedMarker(markerId) {
  if (state.selectedMarkerId === markerId) {
    state.selectedMarkerId = null;
    closeMarkerTestPopover();
    if (state.markerPopover.open && state.markerPopover.mode === "edit") {
      closeMarkerPopover();
    }
  } else {
    state.selectedMarkerId = markerId;
    closeMarkerTestPopover();
  }
  renderHrMarkerOverlay();
}

function beginMarkerPointer(markerId, event) {
  const marker = getMarkerById(markerId);
  if (!marker) {
    return;
  }

  const startTimeMs = parseMarkerTimestampMs(marker.timestamp);
  if (!Number.isFinite(startTimeMs)) {
    return;
  }

  event.preventDefault();
  const pointerState = {
    markerId,
    dragging: false,
    holdTimer: null,
  };

  pointerState.holdTimer = window.setTimeout(() => {
    if (!state.markerPointer || state.markerPointer.markerId !== markerId) {
      return;
    }
    state.markerPointer.dragging = true;
    state.selectedMarkerId = markerId;
    closeMarkerPopover();
    closeMarkerTestPopover();
    document.body.style.cursor = "ew-resize";
    renderHrMarkerOverlay();
  }, LONG_PRESS_MS);

  state.markerPointer = pointerState;
}

function handleMarkerPointerMove(event) {
  if (!state.markerPointer || !state.markerPointer.dragging || !dom.hrCanvas || charts.hr.disabled) {
    return;
  }

  const marker = getMarkerById(state.markerPointer.markerId);
  if (!marker) {
    return;
  }

  const chart = charts.hr;
  const canvasRect = dom.hrCanvas.getBoundingClientRect();
  const rect = chart.getClientRect();
  const localX = Math.max(rect.plotX, Math.min(rect.plotRight, event.clientX - canvasRect.left));
  const nextTimeMs = chart.pxToX(localX, rect);
  marker.timestamp = markerIsoFromMs(nextTimeMs);
  state.lastMarkersKey = "";
  sortMarkersInState();
  renderHrMarkerOverlay();
}

async function endMarkerPointer() {
  if (!state.markerPointer) {
    return;
  }

  const pointer = state.markerPointer;
  if (pointer.holdTimer) {
    window.clearTimeout(pointer.holdTimer);
  }
  state.markerPointer = null;
  document.body.style.cursor = "";

  if (pointer.dragging) {
    const marker = getMarkerById(pointer.markerId);
    if (marker) {
      try {
        await updateMarkerById(marker.id, { timestamp: marker.timestamp });
      } catch (err) {
        log(`Marker move failed: ${err.message}`, true);
        await refreshStatus();
      }
    }
    return;
  }

  toggleSelectedMarker(pointer.markerId);
}

function shouldSkipShortcut(event) {
  const target = event.target;
  if (!target || !(target instanceof Element)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function handleGlobalShortcuts(event) {
  if (state.mode !== "live" && state.mode !== "viewer") {
    return;
  }
  if (shouldSkipShortcut(event)) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }

  const keyMap = {
    Digit1: 1,
    Digit2: 2,
    Digit3: 3,
    Digit4: 4,
    Digit5: 5,
    Numpad1: 1,
    Numpad2: 2,
    Numpad3: 3,
    Numpad4: 4,
    Numpad5: 5,
  };

  const slot = keyMap[event.code];
  if (slot) {
    event.preventDefault();
    addPresetMarker(slot);
    return;
  }

  const key = (event.key || "").toLowerCase();
  if (key === "m") {
    event.preventDefault();
    openAddMarkerFromHover();
    return;
  }
  if (key === "e") {
    event.preventDefault();
    openEditMarkerFromSelection();
    return;
  }
  if (key === "t") {
    event.preventDefault();
    openMarkerTestMenuFromSelection();
    return;
  }
  if (key === "escape") {
    closeMarkerPopover();
    closeMarkerTestPopover();
    closeTestResultModal();
  }
}

function sortDevices(devices) {
  return [...devices].sort((a, b) => {
    const aPolar = /polar/i.test(a.name || "");
    const bPolar = /polar/i.test(b.name || "");
    if (aPolar !== bPolar) {
      return aPolar ? -1 : 1;
    }
    return (a.name || "").localeCompare(b.name || "");
  });
}

function renderDeviceList(devices) {
  if (!dom.deviceList) {
    return;
  }

  const sorted = sortDevices(devices);
  state.currentDevices = sorted;
  dom.deviceList.innerHTML = "";

  if (!sorted.length) {
    const li = document.createElement("li");
    li.className = "device-item";
    li.innerHTML = "<div class='meta'><div class='name'>No devices found</div></div>";
    dom.deviceList.appendChild(li);
    return;
  }

  for (const device of sorted) {
    const li = document.createElement("li");
    const isPolar = /polar/i.test(device.name || "");
    li.className = `device-item${isPolar ? " polar" : ""}`;

    const isActive = state.mode === "live" && state.connected && state.activeDeviceId && state.activeDeviceId === device.address;
    const rssiText = Number.isFinite(device.rssi) ? `RSSI ${device.rssi}` : "RSSI n/a";
    const safeName = escapeHtml(device.name || "Unknown");
    const safeAddress = escapeHtml(device.address || "Unknown");
    const safeRssi = escapeHtml(rssiText);
    const secondaryLine = state.debugMode ? `<div class="address">${safeAddress} · ${safeRssi}</div>` : "";

    li.innerHTML = `
      <div class="meta">
        <div class="name">${safeName}${isPolar ? " · Polar" : ""}</div>
        ${secondaryLine}
      </div>
      ${
        isActive
          ? "<span class='badge'>Connected</span>"
          : `<button class='btn success' data-device-id='${escapeHtml(device.address || "")}'>Connect</button>`
      }
    `;

    dom.deviceList.appendChild(li);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || response.statusText || "Request failed");
  }

  return response.json();
}

function setConnectionState(connection, recording) {
  const wasConnected = state.connected;

  state.connected = Boolean(connection?.connected);
  state.recording = Boolean(recording?.active);
  state.activeDeviceId = connection?.device_id || null;
  state.activeDeviceName = connection?.device_name || null;

  if (!state.connected && wasConnected) {
    clearLiveVisualState();
    state.currentDevices = [];
    renderDeviceList([]);
  }

  if (!state.connected) {
    if (dom.connectionDot) {
      dom.connectionDot.style.background = "#4f5f77";
    }
    if (dom.connectionChip) {
      dom.connectionChip.style.borderColor = "#273446";
    }
    if (dom.connectionLabel) {
      dom.connectionLabel.textContent = "Not connected";
    }
    if (wasConnected && state.mode === "live") {
      openConnectModal();
      setDeviceStatus("Connection lost.", true);
    }
    applyModeUi();
    updateRecordToggleButton();
    return;
  }

  const device = state.activeDeviceName || state.activeDeviceId || "Unknown";
  if (dom.connectionDot) {
    dom.connectionDot.style.background = state.recording ? "#d14453" : "#2fa565";
  }
  if (dom.connectionChip) {
    dom.connectionChip.style.borderColor = state.recording ? "#d14453" : "#2fa565";
  }
  if (dom.connectionLabel) {
    dom.connectionLabel.textContent = state.recording && recording?.session_id
      ? `Connected: ${device} | Recording #${recording.session_id}`
      : `Connected: ${device}`;
  }
  applyModeUi();
  updateRecordToggleButton();
}

function renderStats(stats, zone) {
  if (dom.statHr) {
    dom.statHr.textContent = fmt(stats?.last_hr, " bpm");
  }
  if (dom.statMinHr) {
    dom.statMinHr.textContent = fmt(stats?.min_hr, " bpm");
  }
  if (dom.statMaxHr) {
    dom.statMaxHr.textContent = fmt(stats?.max_hr, " bpm");
  }
  if (dom.statZone) {
    if (state.mode === "viewer" && state.viewerZoneBreakdown.length) {
      dom.statZone.textContent = "See zone badges";
      dom.statZone.style.color = "#dbe4f1";
      return;
    }
    const pct = Number.isFinite(zone?.pct) ? `${zone.pct}%` : "—";
    dom.statZone.textContent = zone?.label ? `${zone.label} (${pct})` : "—";
    dom.statZone.style.color = zone?.color || "#dbe4f1";
  }
}

function parseTime(value) {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return Date.now();
}

function applyLivePayload(payload) {
  if (!payload) {
    return;
  }

  setConnectionState(payload.connection, payload.recording);

  if (state.mode !== "live") {
    return;
  }

  const hrRows = (payload.series?.hr || []).map((point) => ({
    x: parseTime(point.t),
    y: Number(point.hr),
  })).filter((point) => Number.isFinite(point.y));

  const rrRows = (payload.series?.hr || []).map((point) => ({
    x: parseTime(point.t),
    y: Number(point.rr),
  })).filter((point) => Number.isFinite(point.y));

  const ecgRows = (payload.series?.ecg || []).map((point) => ({
    x: parseTime(point.t),
    y: Number(point.v),
  })).filter((point) => Number.isFinite(point.y));

  if (hrRows.length) {
    state.latestHrTimeMs = hrRows[hrRows.length - 1].x;
  }

  if (hrRows.length || ecgRows.length) {
    state.hasSignal = true;
  }

  charts.hr.addPoints(hrRows);
  charts.rr.addPoints(rrRows);
  charts.ecg.addPoints(ecgRows);

  renderStats(payload.stats, payload.zone);
  syncMarkersFromPayload(payload.markers || []);

  if (state.connected) {
    renderDeviceList(state.currentDevices);
  }
}

function scheduleWebSocketReconnect() {
  if (!state.wsEnabled) {
    return;
  }
  window.setTimeout(connectWebSocket, state.wsReconnectDelayMs);
  state.wsReconnectDelayMs = Math.min(5000, state.wsReconnectDelayMs * 1.5);
}

function connectWebSocket() {
  if (!state.wsEnabled) {
    return;
  }
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  state.ws = new WebSocket(`${protocol}://${window.location.host}/ws/live`);

  safeAddEvent(state.ws, "open", () => {
    state.wsConnected = true;
    state.wsReconnectDelayMs = 500;
    log("Live stream connected.");
  });

  safeAddEvent(state.ws, "message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      applyLivePayload(payload);
    } catch (err) {
      log(`Bad live payload: ${err.message}`, true);
    }
  });

  safeAddEvent(state.ws, "close", () => {
    if (state.wsConnected) {
      log("Live stream disconnected. Reconnecting...", true);
    }
    state.wsConnected = false;
    state.ws = null;
    scheduleWebSocketReconnect();
  });

  safeAddEvent(state.ws, "error", () => {
    state.ws.close();
  });
}

function stopWebSocket() {
  state.wsEnabled = false;
  state.wsConnected = false;
  state.wsReconnectDelayMs = 500;
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      // ignore close race
    }
    state.ws = null;
  }
}

async function refreshStatus() {
  const payload = await api("/api/status");
  applyLivePayload({
    series: { hr: [], ecg: [] },
    ...payload,
  });
}

async function waitForFirstSignal(timeoutMs = 12_000, baseline = { samples: 0, ecgSamples: 0 }) {
  const baselineSamples = Number(baseline.samples || 0);
  const baselineEcgSamples = Number(baseline.ecgSamples || 0);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (state.hasSignal) {
      return true;
    }

    try {
      const status = await api("/api/status");
      applyLivePayload({
        series: { hr: [], ecg: [] },
        ...status,
      });
      const samples = Number(status?.stats?.samples || 0);
      const ecgSamples = Number(status?.stats?.ecg_samples || 0);
      if (samples > baselineSamples || ecgSamples > baselineEcgSamples) {
        state.hasSignal = true;
        return true;
      }
    } catch {
      // polling errors ignored during handshake
    }

    await sleep(250);
  }

  return false;
}

async function scanDevices() {
  if (state.modalBusy) {
    return;
  }

  setModalBusy(true, "Scanning...");
  setDeviceStatus("");

  try {
    const payload = await api("/api/scan", { method: "POST" });
    const devices = payload.devices || [];
    renderDeviceList(devices);

    if (devices.length) {
      setDeviceStatus("");
    } else {
      setDeviceStatus("No devices found.", true);
    }
  } catch (err) {
    setDeviceStatus(`Scan failed: ${err.message}`, true);
    log(`Scan failed: ${err.message}`, true);
  } finally {
    setModalBusy(false);
  }
}

async function connectDevice(deviceId) {
  if (state.modalBusy || !deviceId) {
    return;
  }

  setModalBusy(true, "Connecting...");
  setDeviceStatus("");
  clearLiveVisualState();
  state.hasSignal = false;
  let baselineSamples = 0;
  let baselineEcgSamples = 0;

  try {
    const before = await api("/api/status");
    baselineSamples = Number(before?.stats?.samples || 0);
    baselineEcgSamples = Number(before?.stats?.ecg_samples || 0);
  } catch {
    // Baseline is best effort; if unavailable we still continue.
  }

  try {
    const payload = await api("/api/connect", {
      method: "POST",
      body: { device_id: deviceId },
    });

    log(payload.message || "Connected.");
    setModalBusy(true, "Connecting...");
    setDeviceStatus("");

    const hasSignal = await waitForFirstSignal(12_000, {
      samples: baselineSamples,
      ecgSamples: baselineEcgSamples,
    });
    if (!hasSignal) {
      throw new Error("Connected but no signal packets yet. Check sensor contact and try again.");
    }

    await refreshStatus();
    closeConnectModal();
    setDeviceStatus("");
    log("Streaming started.");
    await refreshSessions();
  } catch (err) {
    setDeviceStatus(`Connect failed: ${err.message}`, true);
    log(`Connect failed: ${err.message}`, true);
  } finally {
    setModalBusy(false);
  }
}

async function disconnectDevice(options = {}) {
  const openModal = options.openModal !== false;
  const keepLog = options.keepLog !== false;
  if (dom.disconnectBtn) {
    dom.disconnectBtn.disabled = true;
  }

  if (keepLog) {
    log("Disconnecting...");
  }
  try {
    const payload = await api("/api/disconnect", { method: "POST" });
    clearLiveVisualState();
    state.currentDevices = [];
    renderDeviceList([]);
    await refreshStatus();
    if (openModal && state.mode === "live") {
      openConnectModal();
    }
    setDeviceStatus("");
    if (keepLog) {
      log(payload.message || "Disconnected.");
    }
  } catch (err) {
    log(`Disconnect failed: ${err.message}`, true);
  } finally {
    if (dom.disconnectBtn) {
      dom.disconnectBtn.disabled = false;
    }
  }
}

async function startRecording() {
  state.recordingBusy = true;
  updateRecordToggleButton();

  try {
    const payload = await api("/api/record/start", { method: "POST" });
    log(payload.message || "Recording started.");
    await refreshStatus();
    await refreshSessions();
  } catch (err) {
    log(`Start recording failed: ${err.message}`, true);
  } finally {
    state.recordingBusy = false;
    updateRecordToggleButton();
  }
}

async function stopRecording() {
  state.recordingBusy = true;
  updateRecordToggleButton();

  try {
    const payload = await api("/api/record/stop", { method: "POST" });
    log(payload.message || "Recording stopped.");
    await refreshStatus();
    await refreshSessions();
  } catch (err) {
    log(`Stop recording failed: ${err.message}`, true);
  } finally {
    state.recordingBusy = false;
    updateRecordToggleButton();
  }
}

async function toggleRecording() {
  if (state.mode !== "live") {
    return;
  }
  if (state.recordingBusy) {
    return;
  }
  if (state.recording) {
    await stopRecording();
    return;
  }
  await startRecording();
}

function renderSessions(sessions) {
  if (!dom.sessionsBody) {
    return;
  }

  dom.sessionsBody.innerHTML = "";
  state.sessions = Array.isArray(sessions) ? sessions : [];

  if (!state.sessions.length) {
    state.viewerSessionId = null;
    state.viewerSessionName = "";
    if (dom.viewerSessionActions) {
      dom.viewerSessionActions.classList.add("hidden");
    }
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent = "No sessions yet.";
    tr.appendChild(td);
    dom.sessionsBody.appendChild(tr);
    applyModeUi();
    return;
  }

  const availableIds = state.sessions.map((session) => Number(session.id)).filter((id) => Number.isFinite(id));
  if (!availableIds.includes(Number(state.viewerSessionId))) {
    state.viewerSessionId = availableIds[0] ?? null;
  }

  for (const session of state.sessions) {
    const sessionId = Number(session.id);
    const tr = document.createElement("tr");
    tr.dataset.sessionId = Number.isFinite(sessionId) ? `${sessionId}` : "";
    tr.classList.add("session-row-clickable");
    if (Number.isFinite(sessionId) && sessionId === Number(state.viewerSessionId)) {
      tr.classList.add("session-row-selected");
    }
    const started = session.started_at ? session.started_at.replace("T", " ").slice(0, 19) : "";
    const duration = Number.isFinite(Number(session.duration_minutes))
      ? Number(session.duration_minutes).toFixed(1)
      : "—";
    const sessionName = session.session_name || session.notes || `Session #${session.id}`;
    const deviceName = session.device_name || session.device_id || "Unknown";

    tr.innerHTML = `
      <td>${escapeHtml(sessionName)}</td>
      <td>${escapeHtml(started)}</td>
      <td>${escapeHtml(duration)}</td>
      <td>${escapeHtml(deviceName)}</td>
    `;
    dom.sessionsBody.appendChild(tr);
  }

  const selected = state.sessions.find((session) => Number(session.id) === Number(state.viewerSessionId)) || null;
  state.viewerSessionName = selected ? (selected.session_name || selected.notes || `Session #${selected.id}`) : "";
  if (dom.viewerSessionActions) {
    dom.viewerSessionActions.classList.toggle("hidden", !selected || state.mode !== "viewer");
  }
  if (dom.viewerSessionNameInput) {
    dom.viewerSessionNameInput.value = selected ? state.viewerSessionName : "";
  }
  applyModeUi();
}

async function refreshSessions() {
  if (dom.refreshSessionsBtn) {
    dom.refreshSessionsBtn.disabled = true;
  }

  try {
    const payload = await api("/api/sessions?limit=20");
    renderSessions(payload.sessions || []);
    return state.sessions;
  } catch (err) {
    log(`Session refresh failed: ${err.message}`, true);
    return [];
  } finally {
    if (dom.refreshSessionsBtn) {
      dom.refreshSessionsBtn.disabled = false;
    }
  }
}

async function loadViewerSession(sessionId) {
  const numericId = Number(sessionId);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return;
  }

  state.viewerSessionId = numericId;
  renderSessions(state.sessions);
  const selected = state.sessions.find((session) => Number(session.id) === numericId) || null;
  state.viewerSessionName = selected ? (selected.session_name || selected.notes || `Session #${numericId}`) : `Session #${numericId}`;
  closeMarkerPopover();
  closeMarkerTestPopover();

  try {
    const payload = await api(`/api/session/${numericId}`);
    clearLiveVisualState();

    const hrRows = (payload.series?.hr || [])
      .map((point) => ({
        x: parseTime(point.t),
        y: Number(point.hr),
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

    const rrRows = (payload.series?.hr || [])
      .map((point) => ({
        x: parseTime(point.t),
        y: Number(point.rr),
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

    state.latestHrTimeMs = hrRows.length ? hrRows[hrRows.length - 1].x : null;

    charts.hr.addPoints(hrRows);
    charts.rr.addPoints(rrRows);
    charts.ecg.clearData();
    charts.hr.setFollowLive(false);
    charts.rr.setFollowLive(false);
    charts.ecg.setFollowLive(false);
    setChartLockButtonUi("hr", false);
    setChartLockButtonUi("rr", false);
    setChartLockButtonUi("ecg", false);

    state.viewerZoneBreakdown = Array.isArray(payload.zone_breakdown) ? payload.zone_breakdown : [];
    state.viewerHrMax = Number(payload?.stats?.hr_max);
    state.viewerSessionName = payload?.session?.session_name || state.viewerSessionName;

    renderStats(payload.stats || {}, payload.zone || {});
    renderViewerZoneSummary(state.viewerZoneBreakdown, state.viewerHrMax);
    syncMarkersFromPayload(payload.markers || []);
    renderSessions(state.sessions);
  } catch (err) {
    clearLiveVisualState();
    log(`Failed to load session #${numericId}: ${err.message}`, true);
  }
}

async function enterLiveMode() {
  stopWebSocket();
  setMode("live");
  clearLiveVisualState();
  charts.hr.setFollowLive(true);
  charts.rr.setFollowLive(true);
  charts.ecg.setFollowLive(true);
  setChartLockButtonUi("hr", true);
  setChartLockButtonUi("rr", true);
  setChartLockButtonUi("ecg", true);

  try {
    await refreshStatus();
  } catch (err) {
    log(`Status refresh failed: ${err.message}`, true);
  }

  state.wsEnabled = true;
  connectWebSocket();
  await refreshSessions();

  if (!state.connected) {
    openConnectModal();
  }
}

async function enterViewerMode() {
  stopWebSocket();
  setMode("viewer");
  clearLiveVisualState();
  await refreshSessions();
  if (state.viewerSessionId != null) {
    await loadViewerSession(state.viewerSessionId);
  }
}

async function saveViewerSessionName() {
  if (state.mode !== "viewer") {
    return;
  }
  const sessionId = Number(state.viewerSessionId);
  const input = dom.viewerSessionNameInput;
  if (!Number.isFinite(sessionId) || !input) {
    return;
  }
  const nextName = input.value.trim();
  if (!nextName) {
    input.value = state.viewerSessionName || `Session #${sessionId}`;
    return;
  }

  try {
    const payload = await api(`/api/session/${sessionId}`, {
      method: "PATCH",
      body: { name: nextName },
    });
    const updatedSession = payload.session || null;
    if (updatedSession) {
      const idx = state.sessions.findIndex((session) => Number(session.id) === sessionId);
      if (idx >= 0) {
        state.sessions[idx] = updatedSession;
      }
      state.viewerSessionName = updatedSession.session_name || nextName;
    } else {
      state.viewerSessionName = nextName;
    }
    renderSessions(state.sessions);
  } catch (err) {
    log(`Failed to rename session: ${err.message}`, true);
    input.value = state.viewerSessionName || `Session #${sessionId}`;
  }
}

async function deleteViewerSession() {
  if (state.mode !== "viewer") {
    return;
  }
  const sessionId = Number(state.viewerSessionId);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    return;
  }
  const displayName = state.viewerSessionName || `Session #${sessionId}`;
  const confirmed = window.confirm(
    `Are you sure you want to delete "${displayName}"? Deleting this session will permanently remove its samples and markers.`,
  );
  if (!confirmed) {
    return;
  }

  try {
    await api(`/api/session/${sessionId}`, { method: "DELETE" });
    clearLiveVisualState();
    await refreshSessions();
    if (state.viewerSessionId != null) {
      await loadViewerSession(state.viewerSessionId);
    } else {
      log("Session deleted.");
    }
  } catch (err) {
    log(`Failed to delete session: ${err.message}`, true);
  }
}

async function goHome() {
  if (state.homeBusy) {
    return;
  }
  state.homeBusy = true;

  if (state.mode === "live") {
    try {
      let recordingActive = state.recording;
      if (!recordingActive) {
        try {
          const status = await api("/api/status");
          setConnectionState(status?.connection, status?.recording);
          recordingActive = Boolean(status?.recording?.active);
        } catch {
          recordingActive = state.recording;
        }
      }

      if (recordingActive) {
        const confirmed = window.confirm(
          "Are you sure? Leaving the session will stop and save the current session and return to the main menu.",
        );
        if (!confirmed) {
          return;
        }
      }

      if (state.connected || recordingActive) {
        await disconnectDevice({ openModal: false, keepLog: false });
      }
      stopWebSocket();
    } finally {
      state.homeBusy = false;
    }
  } else {
    state.homeBusy = false;
  }

  if (state.mode === "viewer") {
    closeMarkerPopover();
  }

  clearLiveVisualState();
  setMode("main");
}

function closeSettingsMenu() {
  if (dom.settingsMenu) {
    dom.settingsMenu.classList.add("hidden");
  }
}

function beginChartResize(chartKey, event) {
  const chart = charts[chartKey];
  if (!chart || !chart.canvas) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const startHeight = chart.canvas.clientHeight || 220;
  state.chartResize = {
    chartKey,
    startY: event.clientY,
    startHeight,
  };
  document.body.style.cursor = "nwse-resize";
}

function handleChartResizeMove(event) {
  if (!state.chartResize) {
    return;
  }

  const { chartKey, startY, startHeight } = state.chartResize;
  const chart = charts[chartKey];
  if (!chart || !chart.canvas) {
    return;
  }

  const dy = event.clientY - startY;
  const nextHeight = Math.max(140, Math.min(520, startHeight + dy));
  chart.canvas.style.height = `${nextHeight}px`;
  chart.render();
}

function endChartResize() {
  if (!state.chartResize) {
    return;
  }

  const { chartKey } = state.chartResize;
  const chart = charts[chartKey];
  if (chart && chart.canvas) {
    persistChartHeight(chartKey, chart.canvas.clientHeight || 220);
  }
  state.chartResize = null;
  document.body.style.cursor = "";
}

function wireEvents() {
  safeAddEvent(dom.pulsarHome, "click", async () => {
    await goHome();
  });
  safeAddEvent(dom.pulsarHome, "keydown", async (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      await goHome();
    }
  });

  safeAddEvent(dom.newSessionBtn, "click", () => {
    enterLiveMode();
  });

  safeAddEvent(dom.viewRecordingsBtn, "click", () => {
    enterViewerMode();
  });

  safeAddEvent(dom.openConnectBtn, "click", () => {
    openConnectModal();
  });

  safeAddEvent(dom.connectionModal, "click", (event) => {
    if (event.target === dom.connectionModal) {
      closeConnectModal();
    }
  });

  safeAddEvent(dom.scanBtn, "click", () => {
    scanDevices();
  });

  safeAddEvent(dom.deviceList, "click", (event) => {
    const connectButton = closestFromEventTarget(event, "button[data-device-id]");
    if (!connectButton) {
      return;
    }
    const deviceId = connectButton.getAttribute("data-device-id");
    if (deviceId) {
      connectDevice(deviceId);
    }
  });

  safeAddEvent(dom.disconnectBtn, "click", disconnectDevice);
  safeAddEvent(dom.recordToggleBtn, "click", toggleRecording);
  safeAddEvent(dom.refreshSessionsBtn, "click", refreshSessions);
  safeAddEvent(dom.viewerSessionSaveBtn, "click", saveViewerSessionName);
  safeAddEvent(dom.viewerDeleteSessionBtn, "click", deleteViewerSession);
  safeAddEvent(dom.viewerSessionNameInput, "keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveViewerSessionName();
    }
  });
  safeAddEvent(dom.viewerSessionNameInput, "blur", () => {
    if (state.mode === "viewer") {
      saveViewerSessionName();
    }
  });
  safeAddEvent(dom.sessionsBody, "click", (event) => {
    const row = closestFromEventTarget(event, "tr[data-session-id]");
    if (!row) {
      return;
    }
    const sessionId = Number(row.dataset.sessionId);
    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      return;
    }
    state.viewerSessionId = sessionId;
    renderSessions(state.sessions);
    if (state.mode === "viewer") {
      loadViewerSession(sessionId);
    }
  });

  for (const input of dom.markerPresetLabels) {
    safeAddEvent(input, "change", commitMarkerPresetInputs);
  }
  for (const input of dom.markerPresetColors) {
    safeAddEvent(input, "change", commitMarkerPresetInputs);
  }

  safeAddEvent(dom.hrCanvas, "mousedown", () => {
    if (state.selectedMarkerId) {
      state.selectedMarkerId = null;
      closeMarkerPopover();
      closeMarkerTestPopover();
      renderHrMarkerOverlay();
    }
  });
  safeAddEvent(dom.hrCanvas, "mousemove", setHrHoverFromMouse);
  safeAddEvent(dom.hrCanvas, "mouseleave", clearHrHover);

  safeAddEvent(dom.hrMarkerOverlay, "mousedown", (event) => {
    const label = closestFromEventTarget(event, ".hr-marker-label");
    if (!label) {
      return;
    }
    const markerId = label.getAttribute("data-marker-id");
    if (markerId) {
      beginMarkerPointer(markerId, event);
    }
  });

  safeAddEvent(dom.markerPopoverOk, "click", submitMarkerPopover);
  safeAddEvent(dom.markerPopoverDelete, "click", deleteMarkerFromPopover);
  safeAddEvent(dom.markerTestHrr60Btn, "click", runHrr60FromSelectedMarker);
  safeAddEvent(dom.markerPopoverLabel, "keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitMarkerPopover();
    }
  });
  safeAddEvent(dom.testResultCloseBtn, "click", closeTestResultModal);
  safeAddEvent(dom.testResultModal, "click", (event) => {
    if (event.target === dom.testResultModal) {
      closeTestResultModal();
    }
  });

  for (const lockButton of dom.chartLockButtons) {
    safeAddEvent(lockButton, "click", () => {
      const chartKey = lockButton.dataset.chart;
      if (!chartKey || !charts[chartKey]) {
        return;
      }
      const nextFollow = !charts[chartKey].followLive;
      charts[chartKey].setFollowLive(nextFollow);
      persistChartFollow(chartKey, nextFollow);
      setChartLockButtonUi(chartKey, nextFollow);
    });
  }

  for (const resizeHandle of dom.chartResizers) {
    safeAddEvent(resizeHandle, "mousedown", (event) => {
      const chartKey = resizeHandle.dataset.chart;
      if (chartKey) {
        beginChartResize(chartKey, event);
      }
    });
  }
  safeAddEvent(dom.sessionsResizer, "mousedown", (event) => {
    if (!dom.sessionsTableWrap) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    state.sessionsResize = {
      startY: event.clientY,
      startHeight: dom.sessionsTableWrap.clientHeight || 230,
    };
    document.body.style.cursor = "ns-resize";
  });

  safeAddEvent(dom.settingsBtn, "click", (event) => {
    event.stopPropagation();
    if (dom.settingsMenu) {
      dom.settingsMenu.classList.toggle("hidden");
    }
  });

  safeAddEvent(dom.settingShowRr, "change", (event) => {
    state.showRr = Boolean(event.target.checked);
    persistShowRr();
    applySettingsUi();
    charts.rr.render();
  });
  safeAddEvent(dom.settingDebug, "change", (event) => {
    state.debugMode = Boolean(event.target.checked);
    persistDebugMode();
    applySettingsUi();
    renderDeviceList(state.currentDevices || []);
  });

  safeAddEvent(document, "click", (event) => {
    if (dom.settingsMenu && dom.settingsBtn && !dom.settingsMenu.classList.contains("hidden")) {
      const target = event.target;
      if (target instanceof Node && !dom.settingsMenu.contains(target) && !dom.settingsBtn.contains(target)) {
        closeSettingsMenu();
      }
    }

    if (state.markerPopover.open) {
      const target = event.target;
      const inPopover = Boolean(target instanceof Node && dom.markerPopover?.contains(target));
      const onMarkerLabel = Boolean(closestFromEventTarget(event, ".hr-marker-label"));
      if (!inPopover && !onMarkerLabel) {
        closeMarkerPopover();
      }
    }

    if (state.markerTestPopover.open) {
      const target = event.target;
      const inTestPopover = Boolean(target instanceof Node && dom.markerTestPopover?.contains(target));
      const onMarkerLabel = Boolean(closestFromEventTarget(event, ".hr-marker-label"));
      if (!inTestPopover && !onMarkerLabel) {
        closeMarkerTestPopover();
      }
    }
  });

  safeAddEvent(window, "keydown", handleGlobalShortcuts);
  safeAddEvent(window, "mousemove", handleMarkerPointerMove);
  safeAddEvent(window, "mouseup", () => {
    endMarkerPointer();
  });
  safeAddEvent(window, "mousemove", handleChartResizeMove);
  safeAddEvent(window, "mouseup", endChartResize);
  safeAddEvent(window, "mousemove", (event) => {
    if (!state.sessionsResize || !dom.sessionsTableWrap) {
      return;
    }
    const dy = event.clientY - state.sessionsResize.startY;
    const nextHeight = state.sessionsResize.startHeight + dy;
    dom.sessionsTableWrap.style.height = `${Math.max(140, Math.min(520, nextHeight))}px`;
  });
  safeAddEvent(window, "mouseup", () => {
    if (!state.sessionsResize || !dom.sessionsTableWrap) {
      return;
    }
    setSessionsTableHeight(dom.sessionsTableWrap.clientHeight || 230);
    state.sessionsResize = null;
    document.body.style.cursor = "";
  });

  let resizeDebounce = null;
  safeAddEvent(window, "resize", () => {
    window.clearTimeout(resizeDebounce);
    resizeDebounce = window.setTimeout(() => {
      charts.hr.render();
      charts.rr.render();
      charts.ecg.render();
    }, 120);
  });
}

async function init() {
  wireEvents();
  hydrateChartPreferences();
  hydrateSessionsTableHeight();
  hydrateMarkerPresets();
  applySettingsUi();
  updateRecordToggleButton();
  clearLiveVisualState();
  setMode("main");

  try {
    await refreshStatus();
  } catch (err) {
    log(`Status refresh failed: ${err.message}`, true);
  }

  await refreshSessions();
  setDeviceStatus("");

  window.setInterval(() => {
    if (state.mode === "viewer") {
      refreshSessions();
    }
  }, 30_000);
}

init().catch((err) => {
  log(`Bootstrap failed: ${err.message}`, true);
});

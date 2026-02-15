(function () {
  "use strict";

  const HISTORY_STORAGE_KEY = "veritylens_dashboard_history_v1";
  const MAX_HISTORY_ITEMS = 12;

  const state = {
    combinedMode: false,
    activeSessionId: null,
    baselinePayload: null,
    history: [],
  };

  function asNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDate(isoValue) {
    const date = new Date(isoValue);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function decodeBase64Url(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + "=".repeat(padLength);
    const binary = atob(padded);
    let escaped = "";
    for (let i = 0; i < binary.length; i += 1) {
      escaped += `%${binary.charCodeAt(i).toString(16).padStart(2, "0")}`;
    }
    return decodeURIComponent(escaped);
  }

  function normalizeIssueTypes(issueTypes) {
    if (!Array.isArray(issueTypes)) return [];
    const allowed = new Set(["misinformation", "fallacy", "bias"]);
    return issueTypes
      .map((item) => String(item).toLowerCase().trim())
      .filter((item) => allowed.has(item));
  }

  function emptyPayload() {
    return {
      generatedAt: new Date().toISOString(),
      source: {
        title: "No page scanned yet",
        url: "",
        scanMessage: "Run a scan in the extension to populate this dashboard.",
      },
      summary: {
        totalFindings: 0,
        misinformationCount: 0,
        fallacyCount: 0,
        biasCount: 0,
        averageConfidence: 0,
        averageSeverity: 0,
      },
      biasSubtypes: [],
      findings: [],
    };
  }

  function coercePayload(raw) {
    if (!raw || typeof raw !== "object") {
      return emptyPayload();
    }

    const source = raw.source && typeof raw.source === "object" ? raw.source : {};
    const summary = raw.summary && typeof raw.summary === "object" ? raw.summary : {};
    const biasSubtypesRaw = Array.isArray(raw.biasSubtypes) ? raw.biasSubtypes : [];
    const findingsRaw = Array.isArray(raw.findings) ? raw.findings : [];

    return {
      generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : new Date().toISOString(),
      source: {
        title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : "Untitled page",
        url: typeof source.url === "string" ? source.url.trim() : "",
        scanMessage:
          typeof source.scanMessage === "string" && source.scanMessage.trim()
            ? source.scanMessage.trim()
            : "Scan completed.",
      },
      summary: {
        totalFindings: clamp(asNumber(summary.totalFindings, 0), 0, 999),
        misinformationCount: clamp(asNumber(summary.misinformationCount, 0), 0, 999),
        fallacyCount: clamp(asNumber(summary.fallacyCount, 0), 0, 999),
        biasCount: clamp(asNumber(summary.biasCount, 0), 0, 999),
        averageConfidence: clamp(asNumber(summary.averageConfidence, 0), 0, 1),
        averageSeverity: clamp(asNumber(summary.averageSeverity, 0), 0, 5),
      },
      biasSubtypes: biasSubtypesRaw
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const subtype = typeof item.subtype === "string" ? item.subtype.trim() : "";
          const count = clamp(asNumber(item.count, 0), 0, 999);
          if (!subtype || count <= 0) return null;
          return { subtype, count };
        })
        .filter(Boolean)
        .slice(0, 10),
      findings: findingsRaw
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const quote = typeof item.quote === "string" ? item.quote.trim() : "";
          const rationale = typeof item.rationale === "string" ? item.rationale.trim() : "";
          if (!quote) return null;
          return {
            quote,
            issueTypes: normalizeIssueTypes(item.issueTypes),
            subtype: typeof item.subtype === "string" ? item.subtype.trim() : "",
            confidence: clamp(asNumber(item.confidence, 0), 0, 1),
            severity: clamp(asNumber(item.severity, 0), 1, 5),
            rationale,
          };
        })
        .filter(Boolean)
        .slice(0, 24),
    };
  }

  function sessionIdFromPayload(payload) {
    const keyPart = `${payload.source.url || payload.source.title || "unknown"}`.slice(0, 180);
    return `${payload.generatedAt}::${keyPart}`;
  }

  function entryFromPayload(payload) {
    const coerced = coercePayload(payload);
    return {
      id: sessionIdFromPayload(coerced),
      generatedAt: coerced.generatedAt,
      title: coerced.source.title,
      url: coerced.source.url,
      totalFindings: coerced.summary.totalFindings,
      biasCount: coerced.summary.biasCount,
      payload: coerced,
    };
  }

  function legacyPayloadFromEntry(entry) {
    const generatedAt =
      typeof entry.generatedAt === "string" ? entry.generatedAt : new Date().toISOString();
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : "Untitled page";
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    const total = clamp(asNumber(entry.totalFindings, 0), 0, 999);
    const bias = clamp(asNumber(entry.biasCount, 0), 0, 999);
    return coercePayload({
      generatedAt,
      source: {
        title,
        url,
        scanMessage: "Loaded from local history snapshot.",
      },
      summary: {
        totalFindings: total,
        misinformationCount: 0,
        fallacyCount: Math.max(0, total - bias),
        biasCount: bias,
        averageConfidence: 0,
        averageSeverity: 0,
      },
      biasSubtypes: [],
      findings: [],
    });
  }

  function normalizeHistoryEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    const payload = raw.payload ? coercePayload(raw.payload) : legacyPayloadFromEntry(raw);
    const id =
      typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : sessionIdFromPayload(payload);

    return {
      id,
      generatedAt: payload.generatedAt,
      title: payload.source.title,
      url: payload.source.url,
      totalFindings: payload.summary.totalFindings,
      biasCount: payload.summary.biasCount,
      payload,
    };
  }

  function getPayloadFromUrl() {
    const searchParams = new URLSearchParams(window.location.search);
    const encoded = searchParams.get("data");
    if (!encoded) {
      return { payload: emptyPayload(), hadData: false };
    }

    try {
      const decoded = decodeBase64Url(encoded);
      const parsed = JSON.parse(decoded);
      return { payload: coercePayload(parsed), hadData: true };
    } catch {
      return { payload: emptyPayload(), hadData: false };
    }
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeHistoryEntry).filter(Boolean).slice(0, MAX_HISTORY_ITEMS);
    } catch {
      return [];
    }
  }

  function saveHistory(items) {
    try {
      const serialized = items.slice(0, MAX_HISTORY_ITEMS).map((item) => ({
        id: item.id,
        generatedAt: item.generatedAt,
        title: item.title,
        url: item.url,
        totalFindings: item.totalFindings,
        biasCount: item.biasCount,
        payload: item.payload,
      }));
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(serialized));
    } catch {
      // Ignore storage failures.
    }
  }

  function rememberSession(payload) {
    const history = loadHistory();
    const entry = entryFromPayload(payload);

    const deduped = history.filter((item) => item.id !== entry.id);
    deduped.unshift(entry);
    saveHistory(deduped);
    return deduped;
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = text;
    }
  }

  function renderBarRows(containerId, rows, className) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!rows.length) {
      container.innerHTML = '<p class="empty">No data yet for this section.</p>';
      return;
    }

    const max = Math.max(...rows.map((row) => row.value), 1);
    container.innerHTML = rows
      .map((row) => {
        const width = Math.round((row.value / max) * 100);
        return [
          '<div class="bar-row">',
          '  <div class="bar-head">',
          `    <span class="bar-label">${escapeHtml(row.label)}</span>`,
          `    <span class="bar-value">${escapeHtml(String(row.value))}</span>`,
          "  </div>",
          '  <div class="bar-track">',
          `    <div class="bar-fill ${className}" style="--target-width:${width}%;"></div>`,
          "  </div>",
          "</div>",
        ].join("\n");
      })
      .join("\n");
  }

  function dominantIssue(summary) {
    const entries = [
      ["Misinformation", summary.misinformationCount],
      ["Fallacy", summary.fallacyCount],
      ["Bias", summary.biasCount],
    ];
    const best = entries.sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] <= 0) return "No dominant issue yet";
    return `${best[0]} leads (${best[1]})`;
  }

  function buildCombinedPayload(entries) {
    const validEntries = entries.filter((entry) => entry && entry.payload);
    if (!validEntries.length) {
      return emptyPayload();
    }

    let misinformationCount = 0;
    let fallacyCount = 0;
    let biasCount = 0;
    let totalFindings = 0;
    let confidenceSum = 0;
    let severitySum = 0;

    const allFindings = [];
    const biasSubtypeMap = new Map();

    for (const entry of validEntries) {
      const payload = entry.payload;
      totalFindings += payload.summary.totalFindings;
      misinformationCount += payload.summary.misinformationCount;
      fallacyCount += payload.summary.fallacyCount;
      biasCount += payload.summary.biasCount;

      for (const finding of payload.findings) {
        allFindings.push(finding);
        confidenceSum += finding.confidence;
        severitySum += finding.severity;

        if (finding.issueTypes.includes("bias")) {
          const subtype = (finding.subtype || "unspecified").toLowerCase().trim();
          biasSubtypeMap.set(subtype, (biasSubtypeMap.get(subtype) || 0) + 1);
        }
      }
    }

    if (biasSubtypeMap.size === 0) {
      for (const entry of validEntries) {
        for (const subtype of entry.payload.biasSubtypes || []) {
          const key = subtype.subtype.toLowerCase().trim();
          biasSubtypeMap.set(key, (biasSubtypeMap.get(key) || 0) + asNumber(subtype.count, 0));
        }
      }
    }

    const uniqueFindings = [];
    const findingMap = new Map();
    for (const finding of allFindings) {
      const key = `${finding.quote.toLowerCase().trim()}::${finding.subtype || ""}`;
      const existing = findingMap.get(key);
      if (!existing) {
        findingMap.set(key, finding);
        continue;
      }
      if (
        finding.severity > existing.severity ||
        (finding.severity === existing.severity && finding.confidence > existing.confidence)
      ) {
        findingMap.set(key, finding);
      }
    }
    for (const finding of findingMap.values()) {
      uniqueFindings.push(finding);
    }
    uniqueFindings.sort((left, right) => {
      if (left.severity !== right.severity) return right.severity - left.severity;
      return right.confidence - left.confidence;
    });

    const averageConfidence = allFindings.length ? confidenceSum / allFindings.length : 0;
    const averageSeverity = allFindings.length ? severitySum / allFindings.length : 0;

    const latestTimestamp = validEntries
      .map((entry) => Date.parse(entry.generatedAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];

    return {
      generatedAt:
        latestTimestamp != null ? new Date(latestTimestamp).toISOString() : new Date().toISOString(),
      source: {
        title: `Combined Metrics Across ${validEntries.length} Sessions`,
        url: "",
        scanMessage:
          "This view aggregates findings across your recent saved sessions.",
      },
      summary: {
        totalFindings: clamp(totalFindings, 0, 999),
        misinformationCount: clamp(misinformationCount, 0, 999),
        fallacyCount: clamp(fallacyCount, 0, 999),
        biasCount: clamp(biasCount, 0, 999),
        averageConfidence: clamp(averageConfidence, 0, 1),
        averageSeverity: clamp(averageSeverity, 0, 5),
      },
      biasSubtypes: [...biasSubtypeMap.entries()]
        .map(([subtype, count]) => ({ subtype, count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 12),
      findings: uniqueFindings.slice(0, 24),
    };
  }

  function getActivePayload() {
    if (state.combinedMode) {
      return buildCombinedPayload(state.history);
    }

    if (state.activeSessionId) {
      const entry = state.history.find((item) => item.id === state.activeSessionId);
      if (entry && entry.payload) {
        return entry.payload;
      }
    }

    return state.baselinePayload || emptyPayload();
  }

  function renderFindings(findings) {
    const list = document.getElementById("findings-list");
    if (!list) return;

    if (!findings.length) {
      list.innerHTML = '<p class="empty">No findings yet. Run a scan from the extension popup.</p>';
      return;
    }

    list.innerHTML = findings
      .map((finding) => {
        const tags = finding.issueTypes
          .map((issue) => {
            const css =
              issue === "misinformation"
                ? "tag tag--misinfo"
                : issue === "fallacy"
                  ? "tag tag--fallacy"
                  : "tag tag--bias";
            return `<span class="${css}">${escapeHtml(issue)}</span>`;
          })
          .join("");

        const confidenceLabel = `${Math.round(finding.confidence * 100)}%`;
        const subtypeLabel = finding.subtype ? ` | ${finding.subtype}` : "";

        return [
          '<article class="finding-item">',
          `  <p class="finding-quote">"${escapeHtml(finding.quote)}"</p>`,
          `  <div class="finding-meta">${tags}<span class="tag tag--bias">conf ${escapeHtml(confidenceLabel)}</span><span class="tag tag--fallacy">sev ${escapeHtml(String(finding.severity))}/5${escapeHtml(subtypeLabel)}</span></div>`,
          `  <p class="finding-rationale">${escapeHtml(finding.rationale || "No rationale provided.")}</p>`,
          "</article>",
        ].join("\n");
      })
      .join("\n");
  }

  function renderHistory(items) {
    const list = document.getElementById("history-list");
    if (!list) return;

    if (!items.length) {
      list.innerHTML = '<p class="empty">No local dashboard history yet.</p>';
      return;
    }

    list.innerHTML = items
      .slice(0, 8)
      .map((entry) => {
        const title = entry.title || "Untitled page";
        const total = asNumber(entry.totalFindings, 0);
        const bias = asNumber(entry.biasCount, 0);
        const timestamp = formatDate(entry.generatedAt);
        const activeClass =
          !state.combinedMode && entry.id === state.activeSessionId ? "history-item is-active" : "history-item";

        return [
          `<article class="${activeClass}" data-session-id="${escapeHtml(entry.id)}" role="button" tabindex="0" aria-label="Open session ${escapeHtml(title)}">`,
          '  <div class="history-item-main">',
          `    <h4 class="history-item-title">${escapeHtml(title)}</h4>`,
          `    <p class="history-meta">${escapeHtml(timestamp)}</p>`,
          "  </div>",
          `  <div class="history-meta">${total} findings | ${bias} bias</div>`,
          "</article>",
        ].join("\n");
      })
      .join("\n");
  }

  function render() {
    const payload = getActivePayload();

    setText("view-mode", state.combinedMode ? "Combined Snapshot" : "Session Snapshot");
    setText("source-title", payload.source.title);
    setText("scan-message", payload.source.scanMessage);
    setText("generated-at", `Updated ${formatDate(payload.generatedAt)}`);
    setText("kpi-total", String(payload.summary.totalFindings));
    setText("kpi-misinfo", String(payload.summary.misinformationCount));
    setText("kpi-fallacy", String(payload.summary.fallacyCount));
    setText("kpi-bias", String(payload.summary.biasCount));
    setText("dominant-issue", dominantIssue(payload.summary));

    const sourceLink = document.getElementById("source-url");
    if (sourceLink) {
      if (payload.source.url && !state.combinedMode) {
        sourceLink.classList.remove("hidden");
        sourceLink.href = payload.source.url;
        sourceLink.textContent = payload.source.url;
      } else {
        sourceLink.classList.add("hidden");
      }
    }

    const issueBars = [
      { label: "Misinformation", value: payload.summary.misinformationCount },
      { label: "Fallacy", value: payload.summary.fallacyCount },
      { label: "Bias", value: payload.summary.biasCount },
    ];
    renderBarRows("issue-bars", issueBars, "bar-fill--brand");

    const subtypeRows = payload.biasSubtypes.map((item) => ({
      label: item.subtype,
      value: item.count,
    }));
    renderBarRows("bias-subtypes", subtypeRows, "bar-fill--blue");

    const confidencePct = Math.round(payload.summary.averageConfidence * 100);
    const severityPct = Math.round((payload.summary.averageSeverity / 5) * 100);
    const confidenceFill = document.getElementById("confidence-fill");
    const severityFill = document.getElementById("severity-fill");
    if (confidenceFill) confidenceFill.style.setProperty("--target-width", `${confidencePct}%`);
    if (severityFill) severityFill.style.setProperty("--target-width", `${severityPct}%`);
    setText("confidence-value", `${confidencePct}%`);
    setText("severity-value", `${payload.summary.averageSeverity.toFixed(1)} / 5`);

    renderFindings(payload.findings);
    renderHistory(state.history);

    const toggleButton = document.getElementById("toggle-combined");
    if (toggleButton) {
      toggleButton.textContent = state.combinedMode ? "Combined Metrics: On" : "Combined Metrics: Off";
      toggleButton.setAttribute("aria-pressed", state.combinedMode ? "true" : "false");
      toggleButton.classList.toggle("is-on", state.combinedMode);
    }
  }

  function attachInteractions() {
    const historyList = document.getElementById("history-list");
    if (historyList) {
      const activateSession = (target) => {
        const card = target.closest("[data-session-id]");
        if (!card) return;
        const sessionId = card.getAttribute("data-session-id");
        if (!sessionId) return;
        state.activeSessionId = sessionId;
        state.combinedMode = false;
        render();
      };

      historyList.addEventListener("click", (event) => {
        activateSession(event.target);
      });

      historyList.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activateSession(event.target);
      });
    }

    const toggleButton = document.getElementById("toggle-combined");
    if (toggleButton) {
      toggleButton.addEventListener("click", () => {
        state.combinedMode = !state.combinedMode;
        render();
      });
    }
  }

  const { payload, hadData } = getPayloadFromUrl();
  state.baselinePayload = coercePayload(payload);
  state.history = hadData ? rememberSession(state.baselinePayload) : loadHistory();
  state.activeSessionId =
    state.history[0]?.id || sessionIdFromPayload(state.baselinePayload);

  attachInteractions();
  render();
})();

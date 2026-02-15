import type { EmbeddedPanelUpdate, IssueType, ScanReport, ScanStatus, TranscriptSegment } from '@/lib/types';

const PANEL_ID = 'cred-youtube-panel-root';
const STYLE_ID = 'cred-youtube-panel-style';
const URL_CHECK_INTERVAL_MS = 900;
const POLL_INTERVAL_MS = 1600;

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

type FilterKey = 'all' | IssueType;

interface EmbeddedStateResponse {
  tabId: number | null;
  status: ScanStatus;
  report: ScanReport | null;
}

const runningStates = new Set<ScanStatus['state']>(['extracting', 'analyzing', 'highlighting']);

function isWatchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const allowedHosts = new Set([
      'www.youtube.com',
      'youtube.com',
      'm.youtube.com',
      'music.youtube.com',
    ]);
    return allowedHosts.has(hostname) && parsed.pathname === '/watch' && parsed.searchParams.has('v');
  } catch {
    return false;
  }
}

function getVideoIdFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('v');
  } catch {
    return null;
  }
}

function issueLabel(issue: IssueType): string {
  if (issue === 'misinformation') return 'Misinfo';
  if (issue === 'fallacy') return 'Fallacy';
  return 'Bias';
}

function formatQuoteForDisplay(input: string): string {
  const cleaned = input
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'`“”‘’]+/, '')
    .replace(/[\s"'`“”‘’]+$/, '')
    .trim();
  return cleaned ? `"${cleaned}"` : '""';
}

function nearTimestamp(a?: number, b?: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs((a as number) - (b as number)) <= 1.2;
}

function seekVideo(seconds: number) {
  const video = document.querySelector<HTMLVideoElement>('video');
  if (!video || !Number.isFinite(seconds) || seconds < 0) return;
  video.currentTime = seconds;
}

function createButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function sortFindingsForDisplay(findings: Array<ScanReport['findings'][number]>, timelineMode: boolean) {
  if (!timelineMode) return findings;

  const withTimestamp = findings
    .filter((finding) => Number.isFinite(finding.timestampSec))
    .sort((left, right) => {
      const leftSec = left.timestampSec as number;
      const rightSec = right.timestampSec as number;
      if (leftSec !== rightSec) return leftSec - rightSec;
      if (left.severity !== right.severity) return right.severity - left.severity;
      return right.confidence - left.confidence;
    });

  const withoutTimestamp = findings
    .filter((finding) => !Number.isFinite(finding.timestampSec))
    .sort((left, right) => {
      if (left.severity !== right.severity) return right.severity - left.severity;
      return right.confidence - left.confidence;
    });

  return [...withTimestamp, ...withoutTimestamp];
}

async function sendRuntimeMessageWithRetry<TRequest, TResponse>(
  message: TRequest,
  attempts = 6,
): Promise<TResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return (await ext.runtime.sendMessage(message)) as TResponse;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => window.setTimeout(resolve, 120 + attempt * 120));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Runtime message failed after retries.');
}

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PANEL_ID} {
      --cred-bg: #faf6f0;
      --cred-card: #fffcf8;
      --cred-foreground: #2d2520;
      --cred-muted: #8f7f71;
      --cred-primary: #af6d3a;
      --cred-primary-foreground: #fff7ef;
      --cred-border: #e8dbcf;
      --cred-accent: #f8efe6;
      --cred-ring: #ba855e;
      --cred-danger: #b84a3b;
      position: sticky;
      top: 12px;
      z-index: 20;
      order: -999;
      display: block;
      width: 100%;
      border: 1px solid var(--cred-border);
      border-radius: 12px;
      background: var(--cred-bg);
      box-shadow: 0 10px 20px rgba(61, 47, 36, 0.1);
      overflow: hidden;
      color: var(--cred-foreground);
      font-family: "DM Sans", sans-serif;
      margin-bottom: 12px;
    }
    #${PANEL_ID} * {
      box-sizing: border-box;
      font-family: inherit;
    }
    #${PANEL_ID} .cred-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--cred-border);
      background: var(--cred-card);
    }
    #${PANEL_ID} .cred-title {
      margin: 0;
      font-size: 10px;
      letter-spacing: 0;
      text-transform: none;
      font-weight: 700;
      color: var(--cred-muted);
    }
    #${PANEL_ID} .cred-status {
      margin: 2px 0 0;
      font-size: 11px;
      color: var(--cred-foreground);
      line-height: 1.35;
    }
    #${PANEL_ID} .cred-loading-inline {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      font-size: 10px;
      color: var(--cred-muted);
      font-weight: 600;
    }
    #${PANEL_ID} .cred-spinner {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid rgba(175, 109, 58, 0.24);
      border-top-color: var(--cred-primary);
      animation: cred-spin .75s linear infinite;
      flex: 0 0 auto;
    }
    #${PANEL_ID} .cred-scan-btn {
      border: 1px solid var(--cred-primary);
      border-radius: 8px;
      background: var(--cred-primary);
      color: var(--cred-primary-foreground);
      padding: 6px 11px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.02em;
      line-height: 1.2;
      cursor: pointer;
      transition: filter .15s ease, transform .15s ease;
    }
    #${PANEL_ID} .cred-scan-btn:hover {
      filter: brightness(1.04);
      transform: translateY(-1px);
    }
    #${PANEL_ID} .cred-scan-btn:disabled { opacity: .58; cursor: default; transform: none; }
    #${PANEL_ID} .cred-panel-body {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      padding: 10px 12px 12px;
      max-height: min(70vh, 760px);
      overflow: auto;
    }
    #${PANEL_ID} .cred-panel-body::-webkit-scrollbar,
    #${PANEL_ID} .cred-transcript::-webkit-scrollbar {
      width: 4px;
      height: 4px;
    }
    #${PANEL_ID} .cred-panel-body::-webkit-scrollbar-thumb,
    #${PANEL_ID} .cred-transcript::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: #ccb8a5;
    }
    #${PANEL_ID} .cred-filter-row {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    #${PANEL_ID} .cred-chip {
      border: 1px solid var(--cred-border);
      border-radius: 999px;
      background: transparent;
      color: var(--cred-muted);
      padding: 4px 9px;
      font-size: 10px;
      font-weight: 600;
      line-height: 1.2;
      cursor: pointer;
    }
    #${PANEL_ID} .cred-chip[data-active="true"] {
      background: var(--cred-primary);
      color: var(--cred-primary-foreground);
      border-color: transparent;
    }
    #${PANEL_ID} .cred-chip:focus-visible,
    #${PANEL_ID} .cred-scan-btn:focus-visible,
    #${PANEL_ID} .cred-ts-btn:focus-visible,
    #${PANEL_ID} .cred-row-time:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--cred-ring) 60%, transparent);
      outline-offset: 2px;
    }
    #${PANEL_ID} .cred-section-label {
      font-size: 8.5px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--cred-muted);
      margin: 0 0 4px;
      font-weight: 700;
    }
    #${PANEL_ID} .cred-findings {
      display: grid;
      gap: 8px;
    }
    #${PANEL_ID} .cred-finding {
      border: 1px solid var(--cred-border);
      border-radius: 10px;
      padding: 9px;
      background: var(--cred-card);
      display: grid;
      gap: 6px;
    }
    #${PANEL_ID} .cred-finding-tags {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
      align-items: center;
    }
    #${PANEL_ID} .cred-tag {
      border: 1px solid;
      border-radius: 6px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 2px 7px;
      white-space: nowrap;
      line-height: 1;
    }
    #${PANEL_ID} .cred-tag--misinformation {
      background: rgba(186, 60, 47, 0.08);
      border-color: rgba(186, 60, 47, 0.24);
      color: #ba3c2f;
    }
    #${PANEL_ID} .cred-tag--fallacy {
      background: rgba(182, 119, 33, 0.08);
      border-color: rgba(182, 119, 33, 0.24);
      color: #b67721;
    }
    #${PANEL_ID} .cred-tag--bias {
      background: rgba(53, 108, 158, 0.08);
      border-color: rgba(53, 108, 158, 0.24);
      color: #356c9e;
    }
    #${PANEL_ID} .cred-tag--meta {
      background: transparent;
      border-color: var(--cred-border);
      color: var(--cred-muted);
      letter-spacing: 0;
      text-transform: none;
      font-weight: 600;
    }
    #${PANEL_ID} .cred-quote {
      margin: 0;
      font-size: 12.5px;
      color: rgba(45, 37, 32, 0.85);
      line-height: 1.45;
    }
    #${PANEL_ID} .cred-rationale {
      margin: 0;
      font-size: 11px;
      color: rgba(45, 37, 32, 0.72);
      line-height: 1.45;
    }
    #${PANEL_ID} .cred-ts-btn {
      justify-self: start;
      border: 1px solid var(--cred-primary);
      border-radius: 6px;
      background: transparent;
      color: var(--cred-primary);
      font-size: 10px;
      font-weight: 600;
      padding: 5px 10px;
      cursor: pointer;
    }
    #${PANEL_ID} .cred-ts-btn:hover {
      filter: brightness(0.92);
    }
    #${PANEL_ID} .cred-transcript {
      display: grid;
      gap: 6px;
      border: 1px solid var(--cred-border);
      border-radius: 10px;
      padding: 8px;
      background: #f7f0e7;
      max-height: 320px;
      overflow: auto;
    }
    #${PANEL_ID} .cred-row {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 8px;
      border-radius: 8px;
      padding: 5px 6px;
      align-items: start;
      border: 1px solid transparent;
      transition: background .12s ease;
    }
    #${PANEL_ID} .cred-row[data-flagged="true"] {
      background: rgba(175, 109, 58, 0.08);
    }
    #${PANEL_ID} .cred-row[data-current="true"] {
      background: rgba(175, 109, 58, 0.16);
      border-color: rgba(175, 109, 58, 0.34);
    }
    #${PANEL_ID} .cred-row[data-current="true"] .cred-row-time {
      background: #8f5730;
    }
    #${PANEL_ID} .cred-row .cred-row-time {
      border: 0;
      border-radius: 999px;
      background: var(--cred-primary);
      color: var(--cred-primary-foreground);
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      cursor: pointer;
      line-height: 1.2;
    }
    #${PANEL_ID} .cred-row .cred-row-time:hover {
      filter: brightness(1.04);
    }
    #${PANEL_ID} .cred-row-text {
      margin: 0;
      font-size: 11px;
      line-height: 1.35;
      color: rgba(45, 37, 32, 0.84);
      cursor: pointer;
      border-radius: 6px;
      padding: 2px 4px;
      transition: background .12s ease;
    }
    #${PANEL_ID} .cred-row-text:hover {
      background: rgba(175, 109, 58, 0.1);
    }
    #${PANEL_ID} .cred-empty {
      font-size: 11.5px;
      color: var(--cred-muted);
      margin: 0;
    }
    #${PANEL_ID} .cred-error {
      border: 1px solid rgba(184, 74, 59, 0.34);
      background: rgba(255, 249, 247, 0.9);
      color: var(--cred-danger);
      border-radius: 8px;
      padding: 8px;
      font-size: 11px;
    }
    @keyframes cred-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.documentElement.appendChild(style);
}

function findPanelHost(): HTMLElement | null {
  const rightRailTargets = [
    '#secondary-inner',
    '#secondary #related',
    '#related',
    '#secondary',
    'ytd-watch-next-secondary-results-renderer',
    'ytd-watch-flexy #columns',
  ];

  for (const selector of rightRailTargets) {
    const match = document.querySelector<HTMLElement>(selector);
    if (match) {
      return match;
    }
  }

  const below = document.querySelector<HTMLElement>('#below');
  return below;
}

function createPanelRoot(): HTMLElement {
  const root = document.createElement('section');
  root.id = PANEL_ID;
  root.setAttribute('data-testid', 'yt-bias-panel');
  return root;
}

export default defineContentScript({
  matches: [
    '*://www.youtube.com/*',
    '*://youtube.com/*',
    '*://m.youtube.com/*',
    '*://music.youtube.com/*',
  ],
  main() {
    installStyles();

    let currentUrl = location.href;
    let panelRoot: HTMLElement | null = null;
    let report: ScanReport | null = null;
    let status: ScanStatus = {
      state: 'idle',
      progress: 0,
      message: 'Ready to scan this video.',
      updatedAt: Date.now(),
    };
    let tabId: number | null = null;
    let filter: FilterKey = 'all';
    let hasStartedScan = false;
    let transcriptSegments: TranscriptSegment[] = [];
    let transcriptSource: 'youtube_api' | null = null;
    let transcriptError: string | null = null;
    let transcriptLoading = false;
    let transcriptResolved = false;
    let transcriptVersion = 0;
    let activeTranscriptSegmentId: string | null = null;
    let watchedVideo: HTMLVideoElement | null = null;

    const getCurrentVideoId = (): string | null => getVideoIdFromUrl(location.href);

    const reportMatchesCurrentVideo = (candidate: ScanReport | null): boolean => {
      if (!candidate) return false;
      const currentVideoId = getCurrentVideoId();
      if (!currentVideoId) return false;

      if (candidate.scanKind === 'youtube_video' && candidate.videoId) {
        return candidate.videoId === currentVideoId;
      }

      try {
        const reportUrlVideoId = getVideoIdFromUrl(candidate.url);
        return reportUrlVideoId === currentVideoId;
      } catch {
        return false;
      }
    };

    const sanitizeReportForCurrentVideo = (candidate: ScanReport | null): ScanReport | null =>
      reportMatchesCurrentVideo(candidate) ? candidate : null;

    const getDisplayTranscriptSegments = (): TranscriptSegment[] => {
      const reportedSegments = report?.transcript?.segments ?? [];
      return reportedSegments.length > 0 ? reportedSegments : transcriptSegments;
    };

    const resolveActiveSegmentId = (segments: TranscriptSegment[], currentTimeSec: number): string | null => {
      if (segments.length === 0 || !Number.isFinite(currentTimeSec)) return null;
      let active = segments[0];
      for (const segment of segments) {
        if (segment.startSec <= currentTimeSec + 0.1) {
          active = segment;
        } else {
          break;
        }
      }
      return active.id;
    };

    const updateCurrentTranscriptHighlight = () => {
      if (!panelRoot) return;
      const transcriptWrap = panelRoot.querySelector<HTMLElement>('[data-testid="yt-transcript-list"]');
      if (!transcriptWrap) return;

      const video = document.querySelector<HTMLVideoElement>('video');
      if (!video) return;

      const segments = getDisplayTranscriptSegments();
      if (segments.length === 0) {
        activeTranscriptSegmentId = null;
        return;
      }

      const nextActiveId = resolveActiveSegmentId(segments, video.currentTime);
      if (nextActiveId === activeTranscriptSegmentId) return;
      activeTranscriptSegmentId = nextActiveId;

      const rows = Array.from(transcriptWrap.querySelectorAll<HTMLElement>('[data-testid="yt-transcript-row"]'));
      for (const row of rows) {
        row.dataset.current = String(row.dataset.segmentId === nextActiveId);
      }
    };

    const onVideoTimelineUpdate = () => {
      updateCurrentTranscriptHighlight();
    };

    const syncVideoListener = () => {
      const video = document.querySelector<HTMLVideoElement>('video');
      if (video === watchedVideo) return;
      if (watchedVideo) {
        watchedVideo.removeEventListener('timeupdate', onVideoTimelineUpdate);
        watchedVideo.removeEventListener('seeking', onVideoTimelineUpdate);
        watchedVideo.removeEventListener('seeked', onVideoTimelineUpdate);
      }
      watchedVideo = video;
      if (watchedVideo) {
        watchedVideo.addEventListener('timeupdate', onVideoTimelineUpdate);
        watchedVideo.addEventListener('seeking', onVideoTimelineUpdate);
        watchedVideo.addEventListener('seeked', onVideoTimelineUpdate);
      }
    };

    const ensurePanelMounted = () => {
      if (!isWatchUrl(location.href)) {
        panelRoot?.remove();
        panelRoot = null;
        return;
      }
      const host = findPanelHost();
      if (!host) return;
      if (!panelRoot || !panelRoot.isConnected) {
        panelRoot = createPanelRoot();
      }
      if (!panelRoot.isConnected || panelRoot.parentElement !== host || host.firstElementChild !== panelRoot) {
        host.prepend(panelRoot);
      }
    };

    const filteredFindings = () => {
      const findings = report?.findings ?? [];
      const filtered =
        filter === 'all'
          ? findings
          : findings.filter((finding) => finding.issueTypes.includes(filter as IssueType));
      return sortFindingsForDisplay(filtered, report?.scanKind === 'youtube_video');
    };

    const loadTranscript = async (force = false) => {
      if (!isWatchUrl(location.href)) return;
      if (transcriptLoading && !force) return;
      if (!force && (transcriptResolved || transcriptSegments.length > 0)) return;

      const videoId = getVideoIdFromUrl(location.href);
      if (!videoId) {
        transcriptError = 'Missing YouTube video id.';
        transcriptResolved = true;
        render();
        return;
      }

      transcriptLoading = true;
      transcriptError = null;
      const version = ++transcriptVersion;
      render();

      try {
        const response = await sendRuntimeMessageWithRetry<
          { type: 'GET_TRANSCRIPT'; videoId: string; tabId?: number },
          { ok: boolean; source?: 'youtube_api'; segments?: TranscriptSegment[]; reason?: string }
        >({ type: 'GET_TRANSCRIPT', videoId, ...(tabId ? { tabId } : {}) });

        if (version !== transcriptVersion) return;

        if (response.ok && Array.isArray(response.segments) && response.segments.length > 0) {
          transcriptSegments = response.segments;
          transcriptSource = response.source ?? 'youtube_api';
          transcriptError = null;
        } else {
          transcriptSegments = [];
          transcriptSource = 'youtube_api';
          transcriptError = response.reason ?? 'Transcript unavailable for this video.';
        }
      } catch {
        if (version !== transcriptVersion) return;
        transcriptSegments = [];
        transcriptSource = 'youtube_api';
        transcriptError = 'Transcript request failed. Try again in a moment.';
      } finally {
        if (version !== transcriptVersion) return;
        transcriptLoading = false;
        transcriptResolved = true;
        render();
      }
    };

    const startScan = async () => {
      hasStartedScan = true;
      render();
      try {
        await sendRuntimeMessageWithRetry<{ type: 'START_SCAN' }, unknown>({ type: 'START_SCAN' });
      } catch {
        status = {
          ...status,
          state: 'error',
          message: 'Failed to start scan from page.',
          updatedAt: Date.now(),
        };
        render();
      }
    };

    const render = () => {
      if (!panelRoot) return;

      const previousTranscriptWrap = panelRoot.querySelector<HTMLElement>('[data-testid="yt-transcript-list"]');
      const previousTranscriptScrollTop = previousTranscriptWrap?.scrollTop ?? 0;
      const transcriptPending = !transcriptResolved && getDisplayTranscriptSegments().length === 0;
      const showLoadingIndicator = transcriptLoading || transcriptPending;

      panelRoot.style.display = 'block';
      panelRoot.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'cred-panel-header';

      const titleWrap = document.createElement('div');
      const title = document.createElement('p');
      title.className = 'cred-title';
      title.textContent = 'Clarity';
      const statusLine = document.createElement('p');
      statusLine.className = 'cred-status';
      statusLine.setAttribute('data-testid', 'yt-panel-status');
      const shouldShowStatusLine =
        !(status.state === 'idle' && status.message.toLowerCase().includes('ready'));
      if (shouldShowStatusLine) {
        statusLine.textContent = status.message;
        titleWrap.append(title, statusLine);
      } else {
        titleWrap.append(title);
      }

      if (showLoadingIndicator) {
        const loadingInline = document.createElement('span');
        loadingInline.className = 'cred-loading-inline';
        loadingInline.setAttribute('data-testid', 'yt-transcript-loading-inline');
        const spinner = document.createElement('span');
        spinner.className = 'cred-spinner';
        const label = document.createElement('span');
        label.textContent = 'Loading transcript...';
        loadingInline.append(spinner, label);
        titleWrap.appendChild(loadingInline);
      }

      const scanButton = createButton(
        runningStates.has(status.state) ? 'Scanning...' : 'Scan Video',
        'cred-scan-btn',
        () => {
          void startScan();
        },
      );
      scanButton.setAttribute('data-testid', 'yt-scan-button');
      scanButton.disabled = runningStates.has(status.state);

      header.append(titleWrap, scanButton);
      panelRoot.appendChild(header);

      const body = document.createElement('div');
      body.className = 'cred-panel-body';

      const filterRow = document.createElement('div');
      filterRow.className = 'cred-filter-row';
      const filters: FilterKey[] = ['all', 'misinformation', 'fallacy', 'bias'];
      for (const item of filters) {
        const label = item === 'all' ? 'All' : issueLabel(item as IssueType);
        const button = createButton(label, 'cred-chip', () => {
          filter = item;
          render();
        });
        button.dataset.active = String(filter === item);
        filterRow.appendChild(button);
      }
      body.appendChild(filterRow);

      const findingsLabel = document.createElement('p');
      findingsLabel.className = 'cred-section-label';
      findingsLabel.textContent = 'Flagged Findings';
      body.appendChild(findingsLabel);

      const findingsWrap = document.createElement('div');
      findingsWrap.className = 'cred-findings';
      findingsWrap.setAttribute('data-testid', 'yt-findings-list');
      const findings = filteredFindings();
      if (findings.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'cred-empty';
        if (!report) {
          empty.textContent = 'Run scan to detect bias, fallacy, and misinformation.';
        } else {
          empty.textContent =
            report.findings.length === 0
              ? 'No high-confidence issues found.'
              : 'No findings for this filter.';
        }
        findingsWrap.appendChild(empty);
      } else {
        for (const finding of findings) {
          const card = document.createElement('article');
          card.className = 'cred-finding';
          card.setAttribute('data-testid', 'yt-finding-item');
          card.dataset.issueTypes = finding.issueTypes.join(' ');

          const tags = document.createElement('div');
          tags.className = 'cred-finding-tags';
          for (const issue of finding.issueTypes) {
            const tag = document.createElement('span');
            tag.className = `cred-tag cred-tag--${issue}`;
            tag.textContent = issueLabel(issue);
            tags.appendChild(tag);
          }
          if (finding.timestampLabel) {
            const tsTag = document.createElement('span');
            tsTag.className = 'cred-tag cred-tag--meta';
            tsTag.textContent = finding.timestampLabel;
            tags.appendChild(tsTag);
          }

          const quote = document.createElement('p');
          quote.className = 'cred-quote';
          quote.textContent = formatQuoteForDisplay(finding.quote);

          const rationale = document.createElement('p');
          rationale.className = 'cred-rationale';
          rationale.textContent = finding.rationale;

          card.append(tags, quote, rationale);

          if (Number.isFinite(finding.timestampSec) && finding.timestampLabel) {
            const timestampButton = createButton(
              `Jump ${finding.timestampLabel}`,
              'cred-ts-btn',
              () => seekVideo(finding.timestampSec as number),
            );
            timestampButton.setAttribute('data-testid', 'yt-timestamp-button');
            card.appendChild(timestampButton);
          }

          findingsWrap.appendChild(card);
        }
      }
      body.appendChild(findingsWrap);

      const transcriptLabel = document.createElement('p');
      transcriptLabel.className = 'cred-section-label';
      transcriptLabel.textContent = 'Transcript';
      body.appendChild(transcriptLabel);

      if (showLoadingIndicator) {
        const loadingInline = document.createElement('div');
        loadingInline.className = 'cred-loading-inline';
        loadingInline.setAttribute('data-testid', 'yt-transcript-loading');
        const spinner = document.createElement('span');
        spinner.className = 'cred-spinner';
        const label = document.createElement('span');
        label.textContent = 'Fetching transcript from YouTube...';
        loadingInline.append(spinner, label);
        body.appendChild(loadingInline);
      }

      const segments = getDisplayTranscriptSegments();
      const unavailable =
        segments.length === 0
          ? report?.transcript?.unavailableReason ?? transcriptError
          : null;

      if (unavailable) {
        const error = document.createElement('div');
        error.className = 'cred-error';
        error.setAttribute('data-testid', 'yt-transcript-error');
        error.textContent = unavailable;
        body.appendChild(error);
      }

      const transcriptWrap = document.createElement('div');
      transcriptWrap.className = 'cred-transcript';
      transcriptWrap.setAttribute('data-testid', 'yt-transcript-list');

      if (segments.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'cred-empty';
        empty.textContent = showLoadingIndicator
          ? 'Loading transcript...'
          : 'Transcript unavailable for this video.';
        transcriptWrap.appendChild(empty);
      } else {
        for (const segment of segments) {
          const row = document.createElement('article');
          row.className = 'cred-row';
          row.setAttribute('data-testid', 'yt-transcript-row');
          row.dataset.segmentId = segment.id;
          const isFlagged = (report?.findings ?? []).some((finding) =>
            nearTimestamp(finding.timestampSec, segment.startSec),
          );
          row.dataset.flagged = String(isFlagged);
          row.dataset.current = String(segment.id === activeTranscriptSegmentId);

          const tsButton = createButton(segment.startLabel, 'cred-row-time', () => {
            seekVideo(segment.startSec);
          });
          tsButton.setAttribute('data-testid', 'yt-timestamp-button');
          const text = document.createElement('p');
          text.className = 'cred-row-text';
          text.setAttribute('data-testid', 'yt-transcript-text');
          text.textContent = segment.text;
          text.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            seekVideo(segment.startSec);
          });
          row.append(tsButton, text);
          transcriptWrap.appendChild(row);
        }
      }

      body.appendChild(transcriptWrap);
      transcriptWrap.scrollTop = previousTranscriptScrollTop;
      panelRoot.appendChild(body);
      updateCurrentTranscriptHighlight();
    };

    const loadEmbeddedState = async () => {
      try {
        const response = await sendRuntimeMessageWithRetry<
          { type: 'GET_EMBEDDED_PANEL_STATE' },
          EmbeddedStateResponse | undefined
        >({ type: 'GET_EMBEDDED_PANEL_STATE' }, 8);

        if (!response) return;
        tabId = response.tabId ?? tabId;
        status = response.status ?? status;
        report = sanitizeReportForCurrentVideo(response.report ?? report);
        if (report || response.status?.state !== 'idle') {
          hasStartedScan = true;
        }
        if (report?.transcript?.segments?.length) {
          transcriptSegments = report.transcript.segments;
          transcriptSource = report.transcript.source;
          transcriptError = report.transcript.unavailableReason ?? null;
          transcriptResolved = true;
        } else if (report?.transcript?.unavailableReason) {
          transcriptSource = report.transcript.source;
          transcriptError = report.transcript.unavailableReason;
          transcriptResolved = true;
        }
        render();
      } catch {
        // Ignore transient startup issues.
      }
    };

    let pollingTimer: number | null = null;
    const statusFingerprint = (value: ScanStatus) =>
      [value.state, value.progress, value.message, value.updatedAt, value.errorCode ?? ''].join('|');
    const reportFingerprint = (value: ScanReport | null) =>
      value
        ? [
          value.scannedAt,
          value.summary.totalFindings,
          value.findings.length,
          value.transcript?.segments.length ?? 0,
          value.transcript?.unavailableReason ?? '',
        ].join('|')
        : 'null';

    const startPolling = () => {
      if (pollingTimer != null) return;
      pollingTimer = window.setInterval(async () => {
        if (!hasStartedScan) return;
        try {
          const prevStatusKey = statusFingerprint(status);
          const prevReportKey = reportFingerprint(report);

          const latestStatus = await sendRuntimeMessageWithRetry<
            { type: 'GET_SCAN_STATUS' },
            ScanStatus | undefined
          >({ type: 'GET_SCAN_STATUS' }, 4);
          if (latestStatus) {
            status = latestStatus;
          }

          if (tabId != null) {
            const reportResponse = await sendRuntimeMessageWithRetry<
              { type: 'GET_REPORT'; tabId: number },
              { report: ScanReport | null } | undefined
            >({
              type: 'GET_REPORT',
              tabId,
            }, 4);
            if (reportResponse) {
              report = sanitizeReportForCurrentVideo(reportResponse.report);
              if (report?.transcript?.segments?.length) {
                transcriptSegments = report.transcript.segments;
                transcriptSource = report.transcript.source;
                transcriptError = report.transcript.unavailableReason ?? null;
                transcriptResolved = true;
              } else if (!report && transcriptSegments.length === 0) {
                transcriptResolved = false;
              }
            }
          }

          const nextStatusKey = statusFingerprint(status);
          const nextReportKey = reportFingerprint(report);
          if (prevStatusKey !== nextStatusKey || prevReportKey !== nextReportKey) {
            render();
          } else {
            updateCurrentTranscriptHighlight();
          }
        } catch {
          // Keep polling through transient runtime wakeups.
        }
      }, POLL_INTERVAL_MS);
    };

    const onMessage = (message: EmbeddedPanelUpdate) => {
      if (!message || message.type !== 'EMBEDDED_PANEL_UPDATE') return;
      tabId = message.tabId;
      status = message.status;
      report = sanitizeReportForCurrentVideo(message.report);
      hasStartedScan = true;
      if (report?.transcript?.segments?.length) {
        transcriptSegments = report.transcript.segments;
        transcriptSource = report.transcript.source;
        transcriptError = report.transcript.unavailableReason ?? null;
        transcriptResolved = true;
      } else if (report?.transcript?.unavailableReason) {
        transcriptSource = report.transcript.source;
        transcriptError = report.transcript.unavailableReason;
        transcriptResolved = true;
      }
      render();
    };

    ext.runtime.onMessage.addListener(onMessage as any);

    ensurePanelMounted();
    syncVideoListener();
    render();
    void loadEmbeddedState();
    void loadTranscript();
    startPolling();

    window.setInterval(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        if (!isWatchUrl(currentUrl)) {
          if (watchedVideo) {
            watchedVideo.removeEventListener('timeupdate', onVideoTimelineUpdate);
            watchedVideo.removeEventListener('seeking', onVideoTimelineUpdate);
            watchedVideo.removeEventListener('seeked', onVideoTimelineUpdate);
            watchedVideo = null;
          }
          panelRoot?.remove();
          panelRoot = null;
          return;
        }

        report = null;
        status = {
          state: 'idle',
          progress: 0,
          message: 'Ready to scan this video.',
          updatedAt: Date.now(),
        };
        hasStartedScan = false;
        tabId = null;
        filter = 'all';
        transcriptSegments = [];
        transcriptSource = null;
        transcriptError = null;
        transcriptLoading = true;
        transcriptResolved = false;
        activeTranscriptSegmentId = null;
        ensurePanelMounted();
        syncVideoListener();
        render();
        void loadEmbeddedState();
        void loadTranscript(true);
      } else {
        ensurePanelMounted();
        syncVideoListener();
        if (!transcriptResolved && transcriptSegments.length === 0 && !transcriptLoading) {
          void loadTranscript();
        }
        updateCurrentTranscriptHighlight();
      }
    }, URL_CHECK_INTERVAL_MS);
  },
});

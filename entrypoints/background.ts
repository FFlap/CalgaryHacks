import { analyzeClaims } from '@/lib/analysis';
import { getApiKey, getReport, hasApiKey, saveApiKey, saveReport } from '@/lib/storage';
import type {
  EmbeddedPanelUpdate,
  ExtractionResult,
  Finding,
  RuntimeRequest,
  ScanReport,
  ScanState,
  ScanStatus,
  TranscriptSegment,
  YouTubeTranscriptExtractionResult,
} from '@/lib/types';
import { fetchTranscript } from 'youtube-transcript-plus';
import { formatTimeLabel, normalizeTranscriptSegments, validateTranscriptSegments } from '@/lib/youtube-transcript';

const MAX_ANALYSIS_CHARS = 60_000;

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

const statusByTab = new Map<number, ScanStatus>();
const reportByTab = new Map<number, ScanReport>();
const focusedFindingByTab = new Map<number, string>();
const inFlightScans = new Map<number, Promise<void>>();

function parseYouTubeVideoId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const allowedHosts = new Set([
      'www.youtube.com',
      'youtube.com',
      'm.youtube.com',
      'music.youtube.com',
    ]);
    if (!allowedHosts.has(hostname)) return undefined;
    return parsed.searchParams.get('v') ?? undefined;
  } catch {
    return undefined;
  }
}

function isYouTubeWatchUrl(url: string): boolean {
  return parseYouTubeVideoId(url) !== undefined;
}

async function getReportForTab(tabId: number): Promise<ScanReport | null> {
  return reportByTab.get(tabId) ?? (await getReport(tabId));
}

function notifyEmbeddedPanel(tabId: number) {
  const status = statusByTab.get(tabId);
  if (!status) return;

  const payload: EmbeddedPanelUpdate = {
    type: 'EMBEDDED_PANEL_UPDATE',
    tabId,
    status,
    report: reportByTab.get(tabId) ?? null,
  };

  void Promise.resolve(ext.tabs.sendMessage(tabId, payload)).catch(() => {
    // Ignore when no content script is attached.
  });
}

function setStatus(tabId: number, state: ScanState, message: string, progress: number, errorCode?: string) {
  statusByTab.set(tabId, {
    tabId,
    state,
    message,
    progress,
    updatedAt: Date.now(),
    errorCode,
  });
  notifyEmbeddedPanel(tabId);
}

async function getActiveTabId(): Promise<number> {
  const [activeTab] = await ext.tabs.query({ active: true, currentWindow: true });
  const activeUrl = activeTab?.url ?? '';
  if (activeTab?.id && /^https?:\/\//i.test(activeUrl)) {
    return activeTab.id;
  }

  const candidates = await ext.tabs.query({ currentWindow: true });
  const scannable = candidates
    .filter((tab) => tab.id && typeof tab.url === 'string' && /^https?:\/\//i.test(tab.url))
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));

  if (!scannable[0]?.id) {
    throw new Error('No scannable HTTP(S) tab found. Open a website tab and try again.');
  }
  return scannable[0].id;
}

async function resolveScannableTabId(preferredTabId?: number): Promise<number> {
  if (preferredTabId) {
    try {
      const tab = await ext.tabs.get(preferredTabId);
      if (tab?.id && typeof tab.url === 'string' && /^https?:\/\//i.test(tab.url)) {
        return tab.id;
      }
    } catch {
      // Ignore and fall back.
    }
  }
  return getActiveTabId();
}

function clearHighlightsInPage() {
  const marks = Array.from(document.querySelectorAll('mark[data-cred-id]'));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
    parent.normalize();
  }
}

function applyHighlightsInPage(findings: Array<Pick<Finding, 'id' | 'quote' | 'issueTypes' | 'severity'>>) {
  const styleId = 'cred-highlight-style';
  const clearHighlights = () => {
    const marks = Array.from(document.querySelectorAll('mark[data-cred-id]'));
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
      parent.normalize();
    }
  };

  clearHighlights();

  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      mark[data-cred-id] {
        background: linear-gradient(90deg, rgba(228,72,42,0.26), rgba(248,188,34,0.28));
        border-bottom: 2px solid rgba(130,39,24,0.55);
        color: inherit;
        padding: 0 .1em;
        border-radius: .2em;
        cursor: pointer;
        transition: box-shadow .2s ease;
      }
      mark[data-cred-id]:hover {
        box-shadow: 0 0 0 2px rgba(228,72,42,0.2);
      }
      mark[data-cred-id][data-cred-tags~='misinformation'] {
        background: linear-gradient(90deg, rgba(213,52,52,.27), rgba(254,202,202,.45));
      }
      mark[data-cred-id][data-cred-tags~='fallacy'] {
        background: linear-gradient(90deg, rgba(214,108,15,.25), rgba(253,224,71,.35));
      }
      mark[data-cred-id][data-cred-tags~='bias'] {
        background: linear-gradient(90deg, rgba(49,103,174,.25), rgba(125,211,252,.32));
      }
    `;
    document.documentElement.appendChild(style);
  }

  const blockedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE']);
  const runtimeChrome = (globalThis as any).chrome;
  const clickBridgeKey = '__credHighlightClickBridgeInstalled';

  if (!(window as any)[clickBridgeKey]) {
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target as HTMLElement | null;
        const mark = target?.closest?.('mark[data-cred-id]') as HTMLElement | null;
        const findingId = mark?.dataset?.credId;
        if (!findingId || !runtimeChrome?.runtime?.sendMessage) return;
        runtimeChrome.runtime.sendMessage({
          type: 'OPEN_POPUP_FOR_FINDING',
          findingId,
        });
      },
      true,
    );
    (window as any)[clickBridgeKey] = true;
  }

  const findTextMatch = (needle: string) => {
    const wanted = needle.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (blockedTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('mark[data-cred-id]')) return NodeFilter.FILTER_REJECT;
        const text = node.textContent?.trim() ?? '';
        return text.length < 15 ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });

    let current: Text | null = walker.nextNode() as Text | null;
    while (current) {
      const haystack = (current.textContent ?? '').toLowerCase();
      const start = haystack.indexOf(wanted);
      if (start !== -1) {
        return { node: current, start, end: start + needle.length };
      }
      current = walker.nextNode() as Text | null;
    }
    return null;
  };

  const appliedIds: string[] = [];

  for (const finding of findings) {
    const quote = finding.quote.trim();
    if (quote.length < 22) continue;

    const shortNeedle = quote.length > 220 ? quote.slice(0, 220) : quote;
    const match = findTextMatch(shortNeedle) ?? findTextMatch(shortNeedle.replace(/[“”"'`]+/g, ''));
    if (!match) continue;

    const { node, start, end } = match;
    const middle = node.splitText(start);
    const tail = middle.splitText(end - start);

    const mark = document.createElement('mark');
    mark.dataset.credId = finding.id;
    mark.dataset.credTags = finding.issueTypes.join(' ');
    mark.dataset.credSeverity = String(finding.severity);
    mark.title = `${finding.issueTypes.join(', ')} (severity ${finding.severity})`;
    mark.textContent = middle.textContent;

    middle.parentNode?.replaceChild(mark, middle);
    appliedIds.push(finding.id);

    if (!tail.textContent) {
      tail.remove();
    }
  }

  return { appliedIds, appliedCount: appliedIds.length };
}

function scrollToHighlightInPage(findingId: string) {
  const target = document.querySelector<HTMLElement>(`mark[data-cred-id="${CSS.escape(findingId)}"]`);
  if (!target) return false;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('cred-pulse');
  target.style.outline = '2px solid rgba(228,72,42,.65)';
  setTimeout(() => {
    target.style.outline = '';
    target.classList.remove('cred-pulse');
  }, 1800);
  return true;
}

function extractVisibleTextInPage(): ExtractionResult {
  const blockedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (blockedTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return NodeFilter.FILTER_REJECT;
      }
      const normalized = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (normalized.length < 20) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const blocks: string[] = [];
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length >= 20) {
      blocks.push(text);
    }
    node = walker.nextNode();
  }

  const text = blocks.join('\n');
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || navigator.language || 'unknown',
    text,
    charCount: text.length,
  };
}

async function executeOnTab<T>(
  tabId: number,
  func: (...args: any[]) => T | Promise<T>,
  args: any[] = [],
  world: 'ISOLATED' | 'MAIN' = 'ISOLATED',
): Promise<T> {
  const [result] = await ext.scripting.executeScript({
    target: { tabId },
    func,
    args,
    world: world as any,
  });

  if (!result || typeof result.result === 'undefined') {
    throw new Error('Failed to execute script on the active page.');
  }

  return result.result as T;
}

async function fetchTranscriptByVideoId(
  videoId: string,
  tabId?: number,
): Promise<YouTubeTranscriptExtractionResult> {
  const preferredLang = (globalThis.navigator?.language ?? 'en').split('-')[0];
  const languageAttempts = Array.from(new Set([preferredLang, 'en'])).filter(Boolean);

  const runTabFetch = async (params: {
    url: string;
    method: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
    lang?: string;
  }): Promise<Response> => {
    if (!tabId) {
      throw new Error('No YouTube tab context available for transcript fetch.');
    }

    const result = await executeOnTab<{
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
      body: string;
    }>(
      tabId,
      async (request) => {
        const safeHeaders = new Headers(request.headers ?? {});
        safeHeaders.delete('User-Agent');
        if (request.lang && !safeHeaders.has('Accept-Language')) {
          safeHeaders.set('Accept-Language', request.lang);
        }
        const response = await fetch(request.url, {
          method: request.method ?? 'GET',
          headers: safeHeaders,
          body: request.method === 'POST' ? request.body : undefined,
          credentials: 'include',
          cache: 'no-store',
        });
        return {
          status: response.status,
          statusText: response.statusText,
          headers: Array.from(response.headers.entries()),
          body: await response.text(),
        };
      },
      [params],
      'MAIN',
    );

    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  };

  const extensionFetch = async (params: {
    url: string;
    lang?: string;
    userAgent?: string;
    method?: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
  }): Promise<Response> => {
    const safeHeaders = new Headers(params.headers ?? {});
    safeHeaders.delete('User-Agent');
    if (params.lang && !safeHeaders.has('Accept-Language')) {
      safeHeaders.set('Accept-Language', params.lang);
    }

    return fetch(params.url, {
      method: params.method ?? 'GET',
      headers: safeHeaders,
      body: params.method === 'POST' ? params.body : undefined,
      credentials: 'include',
      cache: 'no-store',
    });
  };

  const transcriptFetchHook = async (params: {
    url: string;
    lang?: string;
    userAgent?: string;
    method?: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
  }): Promise<Response> => {
    const normalized = {
      ...params,
      method: params.method ?? 'GET',
    };
    if (tabId) {
      return runTabFetch(normalized);
    }
    return extensionFetch(normalized);
  };

  let lastError: string | undefined;
  for (const lang of [...languageAttempts, undefined]) {
    try {
      const rawSegments = await fetchTranscript(videoId, {
        ...(lang ? { lang } : {}),
        videoFetch: transcriptFetchHook,
        playerFetch: transcriptFetchHook,
        transcriptFetch: transcriptFetchHook,
      });
      const segments = normalizeTranscriptSegments(
        rawSegments.map((segment) => ({
          startSec: Number(segment.offset),
          startLabel: formatTimeLabel(Number(segment.offset)),
          text: segment.text,
        })),
      );
      const validation = validateTranscriptSegments(segments);
      if (!validation.ok) {
        lastError = `Transcript validation failed (${validation.reason ?? 'invalid_segments'}).`;
        continue;
      }
      return {
        ok: true,
        source: 'youtube_api',
        segments,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown transcript error.';
    }
  }

  return {
    ok: false,
    reason: lastError ?? 'Transcript unavailable for this video.',
  };
}

async function runScan(tabId: number): Promise<void> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    setStatus(tabId, 'error', 'OpenRouter API key is required.', 1, 'missing_api_key');
    return;
  }

  try {
    setStatus(tabId, 'extracting', 'Collecting visible text from the page...', 0.15);

    const extraction = await executeOnTab<ExtractionResult>(tabId, extractVisibleTextInPage);
    if (!extraction.text || extraction.text.length < 50) {
      throw new Error('The page did not provide enough visible text to analyze.');
    }

    const youtubeMode = isYouTubeWatchUrl(extraction.url);
    const videoId = parseYouTubeVideoId(extraction.url);
    let transcriptSegments: TranscriptSegment[] = [];
    let transcriptSource: 'youtube_api' | undefined;
    let analysisText = extraction.text;

    if (youtubeMode) {
      setStatus(tabId, 'extracting', 'Collecting YouTube transcript...', 0.2);
      if (!videoId) {
        setStatus(tabId, 'error', 'Missing YouTube video id.', 1, 'invalid_video_id');
        return;
      }

      const transcript = await fetchTranscriptByVideoId(videoId, tabId);
      if (!transcript.ok || !transcript.segments || transcript.segments.length === 0) {
        const report: ScanReport = {
          tabId,
          url: extraction.url,
          title: extraction.title,
          scanKind: 'youtube_video',
          videoId,
          transcript: {
            source: 'youtube_api',
            segments: [],
            unavailableReason: transcript.reason ?? 'Transcript unavailable.',
          },
          scannedAt: new Date().toISOString(),
          summary: {
            totalFindings: 0,
            misinformationCount: 0,
            fallacyCount: 0,
            biasCount: 0,
          },
          findings: [],
          truncated: false,
          analyzedChars: 0,
        };
        reportByTab.set(tabId, report);
        await saveReport(tabId, report);
        notifyEmbeddedPanel(tabId);
        setStatus(
          tabId,
          'error',
          transcript.reason ?? 'Transcript unavailable from youtube-transcript-plus.',
          1,
          'transcript_unavailable',
        );
        return;
      }

      transcriptSegments = transcript.segments;
      transcriptSource = transcript.source;
      analysisText = transcriptSegments.map((segment) => `[${segment.startLabel}] ${segment.text}`).join('\n');
    }

    const truncatedText = analysisText.slice(0, MAX_ANALYSIS_CHARS);
    const truncated = analysisText.length > MAX_ANALYSIS_CHARS;

    setStatus(tabId, 'analyzing', 'Analyzing claims with OpenRouter Trinity...', 0.55);
    let report = await analyzeClaims({
      apiKey,
      tabId,
      url: extraction.url,
      title: extraction.title,
      text: truncatedText,
      transcriptSegments,
      truncated,
      analyzedChars: truncatedText.length,
    });

    if (youtubeMode) {
      report = {
        ...report,
        scanKind: 'youtube_video',
        videoId,
        transcript: {
          source: transcriptSource ?? 'youtube_api',
          segments: transcriptSegments,
        },
      };
    } else {
      setStatus(tabId, 'highlighting', 'Placing inline evidence highlights...', 0.82);
      const highlightResult = await executeOnTab<{ appliedIds: string[]; appliedCount: number }>(
        tabId,
        applyHighlightsInPage,
        [report.findings.map(({ id, quote, issueTypes, severity }) => ({ id, quote, issueTypes, severity }))],
      );

      const appliedIdSet = new Set(highlightResult.appliedIds);
      report.findings = report.findings.map((finding) => ({
        ...finding,
        highlightApplied: appliedIdSet.has(finding.id),
      }));
    }

    reportByTab.set(tabId, report);
    await saveReport(tabId, report);
    notifyEmbeddedPanel(tabId);

    const suffix = report.summary.totalFindings === 0 ? 'No high-confidence issues found.' : `${report.summary.totalFindings} high-confidence findings.`;
    setStatus(tabId, 'done', suffix, 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown scan error.';
    setStatus(tabId, 'error', message, 1, 'scan_failed');
  }
}

async function startScan(tabId: number) {
  const active = inFlightScans.get(tabId);
  if (active) {
    return;
  }

  const job = runScan(tabId).finally(() => {
    inFlightScans.delete(tabId);
  });

  inFlightScans.set(tabId, job);
}

async function resolveStatusTabId(preferred?: number, senderTabId?: number): Promise<number | undefined> {
  if (preferred) return preferred;
  if (senderTabId) return senderTabId;
  try {
    return await getActiveTabId();
  } catch {
    return undefined;
  }
}

export default defineBackground(() => {
  ext.tabs.onRemoved.addListener((tabId) => {
    statusByTab.delete(tabId);
    reportByTab.delete(tabId);
    focusedFindingByTab.delete(tabId);
    inFlightScans.delete(tabId);
  });

  ext.runtime.onMessage.addListener((message: RuntimeRequest, sender, sendResponse) => {
    void (async () => {
      switch (message.type) {
        case 'SAVE_API_KEY': {
          const apiKey = message.apiKey.trim();
          if (!apiKey) {
            throw new Error('API key cannot be empty.');
          }
          await saveApiKey(apiKey);
          sendResponse({ ok: true, hasApiKey: true });
          return;
        }

        case 'GET_SETTINGS': {
          sendResponse({ hasApiKey: await hasApiKey() });
          return;
        }

        case 'GET_EMBEDDED_PANEL_STATE': {
          const senderTabId = typeof sender.tab?.id === 'number' ? sender.tab.id : undefined;
          const tabId = await resolveStatusTabId(undefined, senderTabId);
          if (!tabId) {
            sendResponse({
              tabId: null,
              status: { state: 'idle', progress: 0, message: 'No active tab.', updatedAt: Date.now() },
              report: null,
            });
            return;
          }

          const status = statusByTab.get(tabId) ?? {
            tabId,
            state: 'idle',
            progress: 0,
            message: 'Idle.',
            updatedAt: Date.now(),
          };
          const report = await getReportForTab(tabId);
          if (report) {
            reportByTab.set(tabId, report);
          }
          sendResponse({
            tabId,
            status,
            report: report ?? null,
          });
          return;
        }

        case 'START_SCAN': {
          const senderTabId = typeof sender.tab?.id === 'number' ? sender.tab.id : undefined;
          const tabId = await resolveScannableTabId(message.tabId ?? senderTabId);
          setStatus(tabId, 'extracting', 'Preparing scan...', 0.05);
          void startScan(tabId);
          sendResponse({ ok: true, tabId });
          return;
        }

        case 'GET_SCAN_STATUS': {
          const senderTabId = typeof sender.tab?.id === 'number' ? sender.tab.id : undefined;
          const tabId = await resolveStatusTabId(message.tabId, senderTabId);
          if (!tabId) {
            sendResponse({ state: 'idle', progress: 0, message: 'No active tab.' });
            return;
          }
          const status = statusByTab.get(tabId);
          if (!status) {
            sendResponse({ tabId, state: 'idle', progress: 0, message: 'Idle.' });
            return;
          }
          sendResponse(status);
          return;
        }

        case 'GET_REPORT': {
          const report = await getReportForTab(message.tabId);
          if (report) {
            reportByTab.set(message.tabId, report);
          }
          sendResponse({ report: report ?? null });
          return;
        }

        case 'GET_FOCUS_FINDING': {
          const findingId = focusedFindingByTab.get(message.tabId) ?? null;
          if (findingId) {
            focusedFindingByTab.delete(message.tabId);
          }
          sendResponse({ findingId });
          return;
        }

        case 'OPEN_POPUP_FOR_FINDING': {
          const tabId =
            message.tabId ??
            (typeof sender.tab?.id === 'number' ? sender.tab.id : undefined);
          if (!tabId) {
            sendResponse({ ok: false, opened: false });
            return;
          }

          focusedFindingByTab.set(tabId, message.findingId);

          let opened = false;
          try {
            await ext.action.openPopup();
            opened = true;
          } catch {
            // openPopup can fail depending on context/browser policy.
          }

          sendResponse({ ok: true, opened, tabId });
          return;
        }

        case 'CLEAR_HIGHLIGHTS': {
          await executeOnTab(message.tabId, clearHighlightsInPage);
          sendResponse({ ok: true });
          return;
        }

        case 'JUMP_TO_FINDING': {
          const found = await executeOnTab<boolean>(
            message.tabId,
            scrollToHighlightInPage,
            [message.findingId],
          );
          sendResponse({ ok: found });
          return;
        }

        case 'GET_TRANSCRIPT': {
          const senderTabId = typeof sender.tab?.id === 'number' ? sender.tab.id : undefined;
          let targetTabId = message.tabId;
          if (!targetTabId && senderTabId) {
            try {
              const senderTab = await ext.tabs.get(senderTabId);
              if (typeof senderTab.url === 'string' && /^https?:\/\//i.test(senderTab.url)) {
                targetTabId = senderTabId;
              }
            } catch {
              // Ignore and fall back.
            }
          }
          if (!targetTabId) {
            try {
              targetTabId = await resolveScannableTabId();
            } catch {
              targetTabId = undefined;
            }
          }
          const result = await fetchTranscriptByVideoId(message.videoId, targetTabId);
          sendResponse(result);
          return;
        }

        default: {
          sendResponse({ ok: false, message: 'Unsupported request.' });
          return;
        }
      }
    })().catch((error) => {
      const messageText = error instanceof Error ? error.message : 'Unknown background error.';
      sendResponse({ ok: false, error: messageText });
    });

    return true;
  });
});

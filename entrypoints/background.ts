import { analyzeClaims } from '@/lib/analysis';
import {
  clearFindingEvidenceForTab,
  getApiKey,
  getGoogleFactCheckApiKey,
  getFindingEvidence,
  getReport,
  hasApiKey,
  hasGoogleFactCheckApiKey,
  saveApiKey,
  saveGoogleFactCheckApiKey,
  saveFindingEvidence,
  saveReport,
} from '@/lib/storage';
import { buildFindingEvidence } from '@/lib/verification';
import type {
  EmbeddedPanelUpdate,
  ExtractionResult,
  Finding,
  FindingEvidence,
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
const inFlightEvidence = new Map<string, Promise<FindingEvidence>>();

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
  const entityMap: Record<string, string> = {
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&lt;': '<',
    '&gt;': '>',
  };

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

  const decodeHtmlEntities = (input: string) => {
    let value = input;
    for (let i = 0; i < 3; i += 1) {
      const next = value
        .replace(/&(amp|quot|#39|apos|lt|gt);/gi, (entity) => entityMap[entity.toLowerCase()] ?? entity)
        .replace(/&#(\d+);/g, (_, codePointText) => {
          const codePoint = Number(codePointText);
          if (!Number.isFinite(codePoint)) return _;
          try {
            return String.fromCodePoint(codePoint);
          } catch {
            return _;
          }
        });
      if (next === value) break;
      value = next;
    }
    return value;
  };

  const normalizeForMatch = (input: string): { normalized: string; map: number[] } => {
    let normalized = '';
    const map: number[] = [];
    let previousWasSpace = true;

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (/\w/.test(char)) {
        normalized += char.toLowerCase();
        map.push(index);
        previousWasSpace = false;
        continue;
      }

      if (!previousWasSpace) {
        normalized += ' ';
        map.push(index);
        previousWasSpace = true;
      }
    }

    while (normalized.startsWith(' ')) {
      normalized = normalized.slice(1);
      map.shift();
    }
    while (normalized.endsWith(' ')) {
      normalized = normalized.slice(0, -1);
      map.pop();
    }

    return { normalized, map };
  };

  const buildNeedleVariants = (quote: string): string[] => {
    const decoded = decodeHtmlEntities(quote).replace(/\s+/g, ' ').trim();
    if (!decoded) return [];

    const variants = new Set<string>();
    variants.add(decoded);
    variants.add(decoded.replace(/[“”"'`]+/g, '').trim());

    const words = normalizeForMatch(decoded).normalized.split(' ').filter(Boolean);
    if (words.length >= 6) {
      variants.add(words.slice(0, Math.min(12, words.length)).join(' '));
      variants.add(words.slice(0, Math.min(8, words.length)).join(' '));
      variants.add(words.slice(0, Math.min(6, words.length)).join(' '));
    }

    return Array.from(variants).filter((variant) => variant.length >= 6);
  };

  const findTextMatch = (needle: string) => {
    const wantedRaw = decodeHtmlEntities(needle).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!wantedRaw) return null;
    const wantedNormalized = normalizeForMatch(wantedRaw).normalized;
    if (!wantedNormalized) return null;

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
      const haystack = current.textContent ?? '';
      const haystackLower = haystack.toLowerCase();

      const exactStart = haystackLower.indexOf(wantedRaw);
      if (exactStart !== -1) {
        return {
          node: current,
          start: exactStart,
          end: exactStart + wantedRaw.length,
        };
      }

      const normalizedHaystack = normalizeForMatch(haystack);
      const normalizedStart = normalizedHaystack.normalized.indexOf(wantedNormalized);
      if (normalizedStart !== -1) {
        const normalizedEnd = normalizedStart + wantedNormalized.length - 1;
        const start = normalizedHaystack.map[normalizedStart];
        const endAnchor = normalizedHaystack.map[normalizedEnd];
        if (Number.isFinite(start) && Number.isFinite(endAnchor)) {
          return {
            node: current,
            start,
            end: Math.min(haystack.length, endAnchor + 1),
          };
        }
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
    const variants = buildNeedleVariants(shortNeedle);
    let match: { node: Text; start: number; end: number } | null = null;
    for (const variant of variants) {
      match = findTextMatch(variant);
      if (match) break;
    }
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
  const blockedTags = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEXTAREA',
    'SVG',
    'CANVAS',
    'IFRAME',
  ]);
  const blockedContainers = new Set(['NAV', 'FOOTER', 'ASIDE', 'FORM']);
  const containerNoisePattern =
    /\b(ad|ads|advert|sponsor|promo|outbrain|taboola|recirc|related|recommend|newsletter|subscribe|cookie|consent|banner|sidebar|comments?|footer|header|nav|menu)\b/i;
  const lineNoisePattern =
    /^(advertisement|sponsored|related|recommended|read more|sign up|subscribe|cookie settings|privacy policy|terms of use|terms of service)$/i;
  const minBlockLength = 20;

  const markerCache = new WeakMap<Element, boolean>();
  const linkDensityCache = new WeakMap<Element, boolean>();

  const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim();

  const isVisible = (element: Element | null): boolean => {
    if (!element) return false;
    if ((element as HTMLElement).hidden) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  };

  const hasNoiseMarker = (element: Element): boolean => {
    const cached = markerCache.get(element);
    if (typeof cached === 'boolean') {
      return cached;
    }

    const markerText = [
      element.id,
      typeof element.className === 'string' ? element.className : '',
      element.getAttribute('role') ?? '',
      element.getAttribute('aria-label') ?? '',
      element.getAttribute('data-testid') ?? '',
      element.getAttribute('data-component') ?? '',
      element.getAttribute('data-module') ?? '',
    ]
      .join(' ')
      .toLowerCase();

    const flagged =
      blockedContainers.has(element.tagName) ||
      markerText.includes('sponsored') ||
      markerText.includes('advertisement') ||
      containerNoisePattern.test(markerText);

    markerCache.set(element, flagged);
    return flagged;
  };

  const isLinkDense = (container: Element): boolean => {
    const cached = linkDensityCache.get(container);
    if (typeof cached === 'boolean') {
      return cached;
    }

    const totalText = normalizeText(container.textContent ?? '');
    if (totalText.length < 120) {
      linkDensityCache.set(container, false);
      return false;
    }

    const linkText = normalizeText(
      Array.from(container.querySelectorAll('a'))
        .map((anchor) => anchor.textContent ?? '')
        .join(' '),
    );

    const dense = linkText.length / Math.max(1, totalText.length) > 0.62;
    linkDensityCache.set(container, dense);
    return dense;
  };

  const shouldSkipNode = (node: Node): boolean => {
    const parent = (node as Text).parentElement;
    if (!parent) return true;
    if (blockedTags.has(parent.tagName)) return true;
    if (!isVisible(parent)) return true;

    let cursor: Element | null = parent;
    for (let depth = 0; cursor && depth < 7; depth += 1) {
      if (blockedTags.has(cursor.tagName)) return true;
      if (!isVisible(cursor)) return true;
      if (hasNoiseMarker(cursor)) return true;
      cursor = cursor.parentElement;
    }

    const normalized = normalizeText(node.textContent ?? '');
    if (normalized.length < minBlockLength) return true;
    if (normalized.length < 120 && lineNoisePattern.test(normalized.toLowerCase())) return true;

    const container =
      parent.closest('article,section,div,p,li,main') ??
      parent;
    if (isLinkDense(container)) return true;

    return false;
  };

  const collectBlocks = (root: Element, maxBlocks = 1200): string[] => {
    const seen = new Set<string>();
    const blocks: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return shouldSkipNode(node)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });

    let node: Node | null = walker.nextNode();
    while (node) {
      const text = normalizeText(node.textContent ?? '');
      const normalizedKey = text.toLowerCase();
      if (!seen.has(normalizedKey)) {
        blocks.push(text);
        seen.add(normalizedKey);
      }
      if (blocks.length >= maxBlocks) {
        break;
      }
      node = walker.nextNode();
    }

    return blocks;
  };

  const scoreBlocks = (blocks: string[]): number => {
    if (blocks.length === 0) return 0;
    const joined = blocks.join(' ');
    const charCount = joined.length;
    const punctuationCount = (joined.match(/[.!?]/g) ?? []).length;
    return charCount + punctuationCount * 12 + blocks.length * 18;
  };

  const collectRootCandidates = (): Element[] => {
    const selectors = [
      '[itemprop="articleBody"]',
      'main article',
      '[role="main"] article',
      'article',
      '.article-body',
      '.article-content',
      '.story-body',
      '.post-content',
      '.entry-content',
      'main',
      '[role="main"]',
      '#main-content',
      '#content',
      '.main-content',
    ];

    const seen = new Set<Element>();
    const candidates: Element[] = [];

    const addCandidate = (element: Element | null) => {
      if (!element) return;
      if (!isVisible(element)) return;
      if (seen.has(element)) return;
      if (hasNoiseMarker(element)) return;
      seen.add(element);
      candidates.push(element);
    };

    for (const selector of selectors) {
      const rows = document.querySelectorAll(selector);
      for (const element of rows) {
        addCandidate(element as Element);
      }
    }

    addCandidate(document.querySelector('body'));
    return candidates;
  };

  const candidates = collectRootCandidates();
  let chosenRoot: Element = document.body;
  let chosenBlocks: string[] = [];
  let bestScore = 0;

  for (const candidate of candidates) {
    const blocks = collectBlocks(candidate, 320);
    const score = scoreBlocks(blocks);
    if (score > bestScore) {
      bestScore = score;
      chosenRoot = candidate;
      chosenBlocks = blocks;
    }
  }

  let finalBlocks = collectBlocks(chosenRoot, 1600);
  const finalChars = finalBlocks.join('\n').length;

  if (finalChars < 650 && chosenRoot !== document.body) {
    finalBlocks = collectBlocks(document.body, 1600);
  } else if (finalBlocks.length === 0 && chosenBlocks.length > 0) {
    finalBlocks = chosenBlocks;
  }

  const text = finalBlocks.join('\n');
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
    await clearFindingEvidenceForTab(tabId);
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
    await clearFindingEvidenceForTab(tabId);
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

function evidenceJobKey(tabId: number, findingId: string): string {
  return `${tabId}:${findingId}`;
}

const EVIDENCE_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

function shouldSuppressGdeltError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('gdelt api failed (429)') ||
    normalized.includes('gdelt api returned invalid json')
  );
}

async function sanitizeCachedEvidence(
  tabId: number,
  findingId: string,
  evidence: FindingEvidence,
): Promise<FindingEvidence> {
  const gdeltError = evidence.errors.gdelt;
  if (!gdeltError || !shouldSuppressGdeltError(gdeltError)) {
    return evidence;
  }

  const sanitized: FindingEvidence = {
    ...evidence,
    errors: {
      ...evidence.errors,
      gdelt: undefined,
    },
  };
  await saveFindingEvidence(tabId, findingId, sanitized);
  return sanitized;
}

function isEvidenceStale(evidence: FindingEvidence): boolean {
  const generatedAt = Date.parse(evidence.generatedAt);
  if (!Number.isFinite(generatedAt)) {
    return true;
  }
  return Date.now() - generatedAt > EVIDENCE_CACHE_MAX_AGE_MS;
}

async function resolveFindingEvidence(options: {
  tabId: number;
  findingId: string;
  forceRefresh?: boolean;
}): Promise<FindingEvidence> {
  const { tabId, findingId, forceRefresh = false } = options;
  const report = await getReportForTab(tabId);

  if (!report) {
    throw new Error('Scan report is unavailable for this tab. Run a scan first.');
  }

  const finding = report.findings.find((item) => item.id === findingId);
  if (!finding) {
    throw new Error('Finding not found in the current scan report.');
  }

  if (!forceRefresh) {
    const cached = await getFindingEvidence(tabId, findingId);
    if (cached) {
      if (!isEvidenceStale(cached)) {
        return sanitizeCachedEvidence(tabId, findingId, cached);
      }
    }
  }

  const key = evidenceJobKey(tabId, findingId);
  const existingJob = inFlightEvidence.get(key);
  if (existingJob) {
    return existingJob;
  }

  const job = buildFindingEvidence({
    tabId,
    finding: {
      id: finding.id,
      quote: finding.quote,
      correction: finding.correction,
      rationale: finding.rationale,
      issueTypes: finding.issueTypes,
    },
    pageContext: report.pageContext,
    googleFactCheckApiKey: await getGoogleFactCheckApiKey(),
    openRouterApiKey: await getApiKey(),
  })
    .then(async (evidence) => {
      await saveFindingEvidence(tabId, findingId, evidence);
      return evidence;
    })
    .finally(() => {
      inFlightEvidence.delete(key);
    });

  inFlightEvidence.set(key, job);
  return job;
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

        case 'SAVE_GOOGLE_FACT_CHECK_API_KEY': {
          const apiKey = message.apiKey.trim();
          if (!apiKey) {
            throw new Error('Google Fact Check API key cannot be empty.');
          }
          await saveGoogleFactCheckApiKey(apiKey);
          sendResponse({ ok: true, hasGoogleFactCheckApiKey: true });
          return;
        }

        case 'GET_SETTINGS': {
          sendResponse({
            hasApiKey: await hasApiKey(),
            hasGoogleFactCheckApiKey: await hasGoogleFactCheckApiKey(),
          });
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
          await clearFindingEvidenceForTab(tabId);
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

        case 'GET_FINDING_EVIDENCE': {
          const evidence = await resolveFindingEvidence({
            tabId: message.tabId,
            findingId: message.findingId,
            forceRefresh: message.forceRefresh,
          });
          sendResponse({ ok: true, evidence });
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

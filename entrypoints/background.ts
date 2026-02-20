import { analyzeClaims } from '@/lib/analysis';
import { simplifySelectionText } from '@/lib/simplify';
import { summarizeSelectionText } from '@/lib/summarize';
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

/**
 * Background runtime orchestrator.
 *
 * Responsibilities:
 * - Own scan lifecycle state for each tab.
 * - Execute DOM operations via `scripting.executeScript`.
 * - Bridge popup/content requests to analysis, transcript, and evidence services.
 * - Persist tab-scoped artifacts (status/report/evidence) through storage helpers.
 */
const MAX_ANALYSIS_CHARS = 60_000;

// Browser API compatibility shim for Chromium (`chrome`) and Firefox (`browser`) style globals.
const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

// In-memory hot caches keyed by tab id.
// These keep popup interactions responsive without needing storage round-trips on every request.
const statusByTab = new Map<number, ScanStatus>();
const reportByTab = new Map<number, ScanReport>();
// One-time "focus this finding when popup opens" handoff.
const focusedFindingByTab = new Map<number, string>();
// Deduplicate concurrent scans/evidence generation per scope.
const inFlightScans = new Map<number, Promise<void>>();
const inFlightEvidence = new Map<string, Promise<FindingEvidence>>();

// Parses strict YouTube watch URLs and returns the `v` id when present.
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

// Returns from memory cache first, then storage fallback.
async function getReportForTab(tabId: number): Promise<ScanReport | null> {
  return reportByTab.get(tabId) ?? (await getReport(tabId));
}

// Pushes status/report deltas to the embedded content-panel if it exists on this tab.
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

// Resolve a "real" scannable tab from the current window.
// Prefers active tab, falls back to most recently accessed HTTP(S) tab.
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

// Prefer an explicitly requested tab id when valid; otherwise defer to active-tab heuristics.
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

// Removes injected highlight marks and restores plain text nodes.
function clearHighlightsInPage() {
  const marks = Array.from(document.querySelectorAll('mark[data-cred-id]'));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
    parent.normalize();
  }
}

/**
 * Injects highlight marks for findings in the page DOM.
 *
 * Matching strategy:
 * - Try exact quote match first.
 * - Fall back to normalized quote variants to survive punctuation/whitespace drift.
 * - Skip tiny/blocked text nodes to avoid low-signal matches.
 */
function applyHighlightsInPage(findings: Array<Pick<Finding, 'id' | 'quote' | 'issueTypes' | 'severity'>>) {
  const styleId = 'cred-highlight-style';
  // Defensive reset so repeated scans do not nest/duplicate mark tags.
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
  // Guard to ensure click bridge is installed once per page lifetime.
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
    // Capture-phase listener ensures clicks are seen even inside complex site handlers.
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
    // Re-run a few times to handle nested-encoded entities without risking unbounded loops.
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
      // Keep alphanumerics, collapse other runs into a single space.
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

    // Build shorter prefixes for resilient matching when quotes are long or lightly transformed by page HTML.
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

    // Walk text nodes only; this avoids markup-level false positives.
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

      // Fast path for direct substring match in raw node text.
      const exactStart = haystackLower.indexOf(wantedRaw);
      if (exactStart !== -1) {
        return {
          node: current,
          start: exactStart,
          end: exactStart + wantedRaw.length,
        };
      }

      // Fallback path for punctuation/whitespace tolerant matching.
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
    // Very short snippets are often too ambiguous for reliable inline placement.
    if (quote.length < 22) continue;

    const shortNeedle = quote.length > 220 ? quote.slice(0, 220) : quote;
    const variants = buildNeedleVariants(shortNeedle);
    let match: { node: Text; start: number; end: number } | null = null;
    // Try progressively weaker variants until one lands.
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

// Scrolls to an injected highlight and briefly accents it.
function scrollToHighlightInPage(findingId: string) {
  const marks = Array.from(document.querySelectorAll<HTMLElement>('mark[data-cred-id]'));
  const target = marks.find((mark) => mark.dataset.credId === findingId);
  if (!target) return false;
  target.scrollIntoView({ behavior: 'auto', block: 'center' });
  target.classList.add('cred-pulse');
  target.style.outline = '2px solid rgba(228,72,42,.65)';
  setTimeout(() => {
    target.style.outline = '';
    target.classList.remove('cred-pulse');
  }, 1800);
  return true;
}

// Video equivalent of "jump to finding" for transcript-based reports.
function seekVideoToTimestampInPage(timestampSec: number) {
  if (!Number.isFinite(timestampSec) || timestampSec < 0) return false;
  const video = document.querySelector<HTMLVideoElement>('video');
  if (!video) return false;

  video.currentTime = Math.max(0, timestampSec);
  video.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

/**
 * Collects high-signal visible text from the current page.
 *
 * Heuristics prioritize article-like content while suppressing:
 * - navigation/chrome sections
 * - sponsored/advertisement fragments
 * - short/noisy/link-dense blocks
 */
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

  // Shared text normalization for dedupe and scoring.
  const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim();

  const isVisible = (element: Element | null): boolean => {
    if (!element) return false;
    if ((element as HTMLElement).hidden) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  };

  // Detect ad/sidebar/footer style containers by semantic markers and class/id hints.
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

  // Link-heavy containers are usually nav/related-story modules rather than body content.
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

  // Node-level gate used by the text walker.
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

  // Collect unique normalized lines from a candidate root.
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

  // Favors roots with more natural language density.
  const scoreBlocks = (blocks: string[]): number => {
    if (blocks.length === 0) return 0;
    const joined = blocks.join(' ');
    const charCount = joined.length;
    const punctuationCount = (joined.match(/[.!?]/g) ?? []).length;
    return charCount + punctuationCount * 12 + blocks.length * 18;
  };

  // Candidate roots ordered from specific article selectors to generic main/body fallbacks.
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

  // Select best root by heuristic score, then expand extraction window from that root.
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
  // Centralized wrapper for script injection so all call sites share the same error semantics.
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

/**
 * Retrieves and normalizes YouTube transcript segments.
 *
 * Two fetch modes:
 * - Tab context (`runTabFetch`): preserves page session/cookies when needed.
 * - Extension context (`extensionFetch`): fallback when tab context is unavailable.
 */
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
    // Some transcript endpoints need first-party page context to succeed consistently.
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
        // Explicitly avoid overriding restricted headers like User-Agent.
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
    // Same header hygiene as tab fetch, but from extension background context.
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
    // Library hook contract: choose tab-bound fetch when tab id exists.
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
  // Retry across preferred language, english fallback, then provider default.
  for (const lang of [...languageAttempts, undefined]) {
    try {
      const rawSegments = await fetchTranscript(videoId, {
        ...(lang ? { lang } : {}),
        videoFetch: transcriptFetchHook,
        playerFetch: transcriptFetchHook,
        transcriptFetch: transcriptFetchHook,
      });
      const segments = normalizeTranscriptSegments(
        rawSegments.map((segment: { offset: number | string; text: string }) => ({
          startSec: Number(segment.offset),
          startLabel: formatTimeLabel(Number(segment.offset)),
          text: segment.text,
        })),
      );
      // Reject malformed segments to keep downstream timestamp logic safe.
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
    // Phase 1: collect page-visible text context.
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
      // Phase 2a (YouTube): transcript-first analysis path.
      setStatus(tabId, 'extracting', 'Collecting YouTube transcript...', 0.2);
      if (!videoId) {
        setStatus(tabId, 'error', 'Missing YouTube video id.', 1, 'invalid_video_id');
        return;
      }

      const transcript = await fetchTranscriptByVideoId(videoId, tabId);
      if (!transcript.ok || !transcript.segments || transcript.segments.length === 0) {
        // Persist an explicit empty-report envelope so UI can render graceful "unavailable" state.
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

    // Keep model input bounded for predictable latency and token cost.
    const truncatedText = analysisText.slice(0, MAX_ANALYSIS_CHARS);
    const truncated = analysisText.length > MAX_ANALYSIS_CHARS;

    setStatus(tabId, 'analyzing', 'Analyzing claims with OpenRouter Trinity...', 0.55);
    // Phase 3: LLM analysis.
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
      // Keep transcript metadata on final report for timestamp jumping and transcript rendering.
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
      // Phase 2b (web articles): map findings back to page text via inline marks.
      setStatus(tabId, 'highlighting', 'Placing inline evidence highlights...', 0.82);
      const highlightResult = await executeOnTab<{ appliedIds: string[]; appliedCount: number }>(
        tabId,
        applyHighlightsInPage,
        [report.findings.map(({ id, quote, issueTypes, severity }) => ({ id, quote, issueTypes, severity }))],
      );

      const appliedIdSet = new Set(highlightResult.appliedIds);
      // Mark which findings were successfully anchored in-page.
      report.findings = report.findings.map((finding) => ({
        ...finding,
        highlightApplied: appliedIdSet.has(finding.id),
      }));
    }

    // Phase 4: persist and publish final state to popup/content.
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
  // Prevent duplicate scan runs on the same tab.
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
  // Status requests may come from popup or content script with different tab visibility contexts.
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

// GDELT frequently rate-limits; these known transient failures should not dominate the UI state.
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
  // Normalize stale/expected transient provider errors inside cached payloads.
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
  // Missing/bad timestamps are treated as stale to force safe refresh behavior.
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
    // Fast-path cached evidence when still fresh.
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
    // Share a single in-flight promise across duplicate requests.
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
  // Keep tab-scoped memory clean when a tab is closed.
  ext.tabs.onRemoved.addListener((tabId) => {
    statusByTab.delete(tabId);
    reportByTab.delete(tabId);
    focusedFindingByTab.delete(tabId);
    inFlightScans.delete(tabId);
  });

  ext.runtime.onMessage.addListener((message: RuntimeRequest, sender, sendResponse) => {
    // Async router pattern: return true below to keep message channel alive for async replies.
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

        case 'SIMPLIFY_TEXT': {
          const apiKey = await getApiKey();
          if (!apiKey) {
            sendResponse({ ok: false, error: 'OpenRouter API key is required.' });
            return;
          }
          const level = message.level === 1 || message.level === 2 || message.level === 3 ? message.level : 2;
          const simplified = await simplifySelectionText({
            apiKey,
            text: message.text,
            level,
          });
          sendResponse({ ok: true, simplified });
          return;
        }

        case 'SUMMARIZE_TEXT': {
          const apiKey = await getApiKey();
          if (!apiKey) {
            sendResponse({ ok: false, error: 'OpenRouter API key is required.' });
            return;
          }
          const level = message.level === 1 || message.level === 2 || message.level === 3 ? message.level : 2;
          const summary = await summarizeSelectionText({
            apiKey,
            text: message.text,
            level,
          });
          sendResponse({ ok: true, summary });
          return;
        }

        case 'GET_EMBEDDED_PANEL_STATE': {
          // Embedded panel can request state without knowing target tab upfront.
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
          // Start is fire-and-forget for scan body; immediate ACK keeps popup responsive.
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
          // Evidence resolution handles freshness, dedupe, and provider fanout internally.
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
          // Called from content-page highlight clicks to route focus back into popup.
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
          // Two jump modes:
          // - YouTube finding with timestamp => seek video.
          // - Standard finding => scroll to injected mark.
          const report = await getReportForTab(message.tabId);
          const finding = report?.findings.find((item) => item.id === message.findingId);
          const canSeekVideo =
            report?.scanKind === 'youtube_video' &&
            typeof finding?.timestampSec === 'number' &&
            Number.isFinite(finding.timestampSec);

          if (canSeekVideo) {
            const jumped = await executeOnTab<boolean>(
              message.tabId,
              seekVideoToTimestampInPage,
              [finding.timestampSec as number],
            );
            sendResponse({ ok: jumped });
            return;
          }

          const found = await executeOnTab<boolean>(
            message.tabId,
            scrollToHighlightInPage,
            [message.findingId],
          );
          sendResponse({ ok: found });
          return;
        }

        case 'GET_TRANSCRIPT': {
          // Utility endpoint used by popup/content for transcript-only fetches.
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
      // Convert uncaught background errors into structured runtime responses.
      const messageText = error instanceof Error ? error.message : 'Unknown background error.';
      sendResponse({ ok: false, error: messageText });
    });

    // Explicitly keep message channel open for async `sendResponse` usage.
    return true;
  });
});

import { analyzeClaims } from '@/lib/analysis';
import { getApiKey, getReport, hasApiKey, saveApiKey, saveReport } from '@/lib/storage';
import type { ExtractionResult, Finding, RuntimeRequest, ScanReport, ScanState, ScanStatus } from '@/lib/types';
import { isYouTubeUrl, fetchYouTubeTranscript } from '@/lib/youtube';

const MAX_ANALYSIS_CHARS = 60_000;

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

const statusByTab = new Map<number, ScanStatus>();
const reportByTab = new Map<number, ScanReport>();
const focusedFindingByTab = new Map<number, string>();
const inFlightScans = new Map<number, Promise<void>>();

function setStatus(tabId: number, state: ScanState, message: string, progress: number, errorCode?: string) {
  statusByTab.set(tabId, {
    tabId,
    state,
    message,
    progress,
    updatedAt: Date.now(),
    errorCode,
  });
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
  func: (...args: any[]) => T,
  args: any[] = [],
): Promise<T> {
  const [result] = await ext.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });

  if (!result || typeof result.result === 'undefined') {
    throw new Error('Failed to execute script on the active page.');
  }

  return result.result as T;
}

async function runScan(tabId: number): Promise<void> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    setStatus(tabId, 'error', 'Gemini API key is required.', 1, 'missing_api_key');
    return;
  }

  try {
    // Get the tab URL to check if it's a YouTube page
    const tab = await ext.tabs.get(tabId);
    const tabUrl = tab?.url ?? '';
    const tabTitle = tab?.title ?? '';

    let extraction: ExtractionResult;
    let isTranscript = false;

    if (isYouTubeUrl(tabUrl)) {
      // YouTube page — fetch the transcript instead of visible text
      setStatus(tabId, 'extracting', 'Fetching YouTube transcript…', 0.15);

      const { text, videoId } = await fetchYouTubeTranscript(tabUrl);
      if (!text || text.length < 50) {
        throw new Error('The YouTube transcript is too short to analyze.');
      }

      extraction = {
        url: tabUrl,
        title: tabTitle,
        lang: 'en',
        text,
        charCount: text.length,
      };
      isTranscript = true;
    } else {
      // Regular page — extract visible text
      setStatus(tabId, 'extracting', 'Collecting visible text from the page…', 0.15);
      extraction = await executeOnTab<ExtractionResult>(tabId, extractVisibleTextInPage);
      if (!extraction.text || extraction.text.length < 50) {
        throw new Error('The page did not provide enough visible text to analyze.');
      }
    }

    const truncatedText = extraction.text.slice(0, MAX_ANALYSIS_CHARS);
    const truncated = extraction.text.length > MAX_ANALYSIS_CHARS;

    setStatus(tabId, 'analyzing', 'Analyzing claims with Gemini 2.5 Flash…', 0.55);
    const report = await analyzeClaims({
      apiKey,
      tabId,
      url: extraction.url,
      title: extraction.title,
      text: truncatedText,
      truncated,
      analyzedChars: truncatedText.length,
      isTranscript,
    });

    if (!isTranscript) {
      setStatus(tabId, 'highlighting', 'Placing inline evidence highlights…', 0.82);

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

async function resolveStatusTabId(preferred?: number): Promise<number | undefined> {
  if (preferred) return preferred;
  try {
    return await getActiveTabId();
  } catch {
    return undefined;
  }
}

export default defineBackground(() => {
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

        case 'START_SCAN': {
          const tabId = await resolveScannableTabId(message.tabId);
          setStatus(tabId, 'extracting', 'Preparing scan…', 0.05);
          void startScan(tabId);
          sendResponse({ ok: true, tabId });
          return;
        }

        case 'GET_SCAN_STATUS': {
          const tabId = await resolveStatusTabId(message.tabId);
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
          const report = reportByTab.get(message.tabId) ?? (await getReport(message.tabId));
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

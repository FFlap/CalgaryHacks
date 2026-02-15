import { chromium, type BrowserContext, type Page, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const FOX_NEWS_URL =
  'https://www.foxnews.com/media/trump-tears-jerk-bill-maher-truth-social-says-hosting-him-white-house-total-waste-time';

export type IssueType = 'misinformation' | 'fallacy' | 'bias';

export interface Finding {
  id: string;
  issueTypes: IssueType[];
  quote: string;
  subtype?: string;
  confidence: number;
  severity: number;
  rationale: string;
  correction?: string;
  timestampSec?: number;
  timestampLabel?: string;
}

export interface TranscriptSegment {
  id: string;
  startSec: number;
  startLabel: string;
  text: string;
}

export interface ScanReport {
  url: string;
  title?: string;
  scanKind?: 'webpage' | 'youtube_video';
  videoId?: string;
  transcript?: {
    source: 'youtube_api';
    segments: TranscriptSegment[];
    unavailableReason?: string;
  };
  findings: Finding[];
  summary?: {
    totalFindings?: number;
  };
}

export interface LaunchResult {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}

const FALLACY_SUBTYPES = new Set([
  'straw man',
  'ad hominem',
  'false dilemma',
  'hasty generalization',
  'slippery slope',
  'appeal to fear',
]);

const BIAS_SUBTYPES = new Set([
  'loaded language',
  'cherry picking',
  'framing bias',
  'confirmation framed rhetoric',
]);

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Expected "${field}" to be a non-empty string.`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Expected "${field}" to be a number.`);
  }
  return value;
}

export async function launchExtensionContext(): Promise<LaunchResult> {
  const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
  await fs.access(extensionPath);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calgaryhacks-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', {
      timeout: 30_000,
    });
  }
  const extensionId = new URL(serviceWorker.url()).host;
  return { context, extensionId, userDataDir };
}

export async function closeExtensionContext({
  context,
  userDataDir,
}: Pick<LaunchResult, 'context' | 'userDataDir'>): Promise<void> {
  await context.close();
  await fs.rm(userDataDir, { recursive: true, force: true });
}

export async function openPopupPage(
  context: BrowserContext,
  extensionId: string,
  tabId?: number,
): Promise<Page> {
  const popup = await context.newPage();
  const tabParam = typeof tabId === 'number' ? `?tabId=${tabId}` : '';
  await popup.goto(`chrome-extension://${extensionId}/popup.html${tabParam}`, {
    waitUntil: 'domcontentloaded',
  });
  return popup;
}

export async function sendRuntimeMessage<TRequest, TResponse>(
  page: Page,
  message: TRequest,
): Promise<TResponse> {
  return page.evaluate(
    async (payload) =>
      new Promise((resolve, reject) => {
        const runtime = (globalThis as { chrome?: { runtime?: any } }).chrome
          ?.runtime;
        if (!runtime) {
          reject(new Error('chrome.runtime is unavailable in the popup context.'));
          return;
        }
        runtime.sendMessage(payload, (response: unknown) => {
          const runtimeError = runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(response as TResponse);
        });
      }),
    message,
  ) as Promise<TResponse>;
}

export async function sendRuntimeMessageWithRetry<TRequest, TResponse>(
  page: Page,
  message: TRequest,
  attempts = 8,
): Promise<TResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await sendRuntimeMessage<TRequest, TResponse>(page, message);
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(120 + attempt * 80);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Runtime message failed after retries.');
}

export async function waitForBackgroundReady(popupPage: Page): Promise<void> {
  await sendRuntimeMessageWithRetry<{ type: string }, { hasApiKey?: boolean }>(
    popupPage,
    { type: 'GET_SETTINGS' },
    10,
  );
}

export async function dismissFoxNewsOverlays(page: Page): Promise<void> {
  const labels = [
    /accept/i,
    /agree/i,
    /continue/i,
    /got it/i,
    /close/i,
    /dismiss/i,
  ];

  for (const label of labels) {
    const button = page.getByRole('button', { name: label }).first();
    try {
      if (await button.isVisible({ timeout: 800 })) {
        await button.click({ timeout: 1_500 });
        await page.waitForTimeout(400);
      }
    } catch {
      // Overlay handling is best-effort and non-fatal.
    }
  }
}

export async function ensureApiKey(
  popupPage: Page,
  apiKey: string,
): Promise<void> {
  await waitForBackgroundReady(popupPage);
  const keyInput = popupPage.getByTestId('api-key-input');
  const saveButton = popupPage.getByTestId('save-api-key');
  await keyInput.fill(apiKey);
  await saveButton.click();

  await popupPage.waitForTimeout(250);
  const stored = await popupPage.evaluate(async () => {
    const runtimeChrome = (globalThis as any).chrome;
    const value = await runtimeChrome.storage.local.get([
      'openrouter_api_key',
      'gemini_api_key',
    ]);
    return value.openrouter_api_key ?? value.gemini_api_key ?? null;
  });
  if (stored !== apiKey) {
    throw new Error('API key was not persisted in chrome.storage.local after Save.');
  }
}

export async function startScan(
  popupPage: Page,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await sendRuntimeMessage<
      { type: string; tabId?: number },
      Record<string, unknown>
    >(popupPage, {
      type: 'START_SCAN',
    });
  } catch {
    // Fall back to popup UI controls when runtime API is unavailable.
  }

  const startButton = popupPage.getByTestId('start-scan');
  await startButton.click();
  return undefined;
}

export async function clickFirstHighlightAndGetId(page: Page): Promise<string | null> {
  const firstHighlight = page.locator('mark[data-cred-id]').first();
  if ((await firstHighlight.count()) === 0) {
    return null;
  }
  const findingId = await firstHighlight.getAttribute('data-cred-id');
  await firstHighlight.click({ force: true });
  return findingId;
}

export async function waitForScanCompletion(
  popupPage: Page,
  tabId?: number,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: Record<string, unknown> = {};

  while (Date.now() < deadline) {
    try {
      const message = tabId == null ? { type: 'GET_SCAN_STATUS' } : { type: 'GET_SCAN_STATUS', tabId };
      const status = await sendRuntimeMessage<typeof message, Record<string, unknown>>(
        popupPage,
        message,
      );
      lastStatus = status ?? {};

      const state = String(
        (isRecord(status) && (status.state ?? status.status)) ?? '',
      ).toLowerCase();

      if (state === 'done' || state === 'completed') {
        return status;
      }
      if (state === 'error' || state === 'failed') {
        throw new Error(`Scan reported failure state: ${JSON.stringify(status)}`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Scan reported failure state:')
      ) {
        throw error;
      }
      // Runtime status polling can race extension startup; continue polling.
    }

    await popupPage.waitForTimeout(1_500);
  }

  throw new Error(
    `Timed out waiting for scan completion after ${timeoutMs}ms. Last status: ${JSON.stringify(lastStatus)}`,
  );
}

export function coerceReport(payload: unknown): ScanReport {
  const report = isRecord(payload) && isRecord(payload.report) ? payload.report : payload;
  if (!isRecord(report)) {
    throw new Error('Expected scan report payload to be an object.');
  }
  const url = asString(report.url, 'url');

  const findingsRaw = report.findings;
  if (!Array.isArray(findingsRaw)) {
    throw new Error('Expected "findings" to be an array.');
  }

  const findings = findingsRaw.map((findingRaw, idx) => {
    if (!isRecord(findingRaw)) {
      throw new Error(`Expected findings[${idx}] to be an object.`);
    }
    const issueTypesRaw = findingRaw.issueTypes;
    if (!Array.isArray(issueTypesRaw) || issueTypesRaw.length === 0) {
      throw new Error(`Expected findings[${idx}].issueTypes to be a non-empty array.`);
    }
    const issueTypes = issueTypesRaw.map((issueType, typeIdx) => {
      const value = asString(issueType, `findings[${idx}].issueTypes[${typeIdx}]`);
      if (value !== 'misinformation' && value !== 'fallacy' && value !== 'bias') {
        throw new Error(`Unsupported issue type "${value}" in findings[${idx}].issueTypes.`);
      }
      return value;
    });

    const confidence = asNumber(findingRaw.confidence, `findings[${idx}].confidence`);
    if (confidence < 0 || confidence > 1) {
      throw new Error(`findings[${idx}].confidence must be between 0 and 1.`);
    }

    const severity = asNumber(findingRaw.severity, `findings[${idx}].severity`);
    if (severity < 1 || severity > 5) {
      throw new Error(`findings[${idx}].severity must be between 1 and 5.`);
    }

    const finding: Finding = {
      id: asString(findingRaw.id, `findings[${idx}].id`),
      issueTypes: issueTypes as IssueType[],
      quote: asString(findingRaw.quote, `findings[${idx}].quote`),
      confidence,
      severity,
      rationale: asString(findingRaw.rationale, `findings[${idx}].rationale`),
      subtype:
        typeof findingRaw.subtype === 'string' ? findingRaw.subtype : undefined,
      correction:
        typeof findingRaw.correction === 'string'
          ? findingRaw.correction
          : undefined,
      timestampSec:
        typeof findingRaw.timestampSec === 'number' ? findingRaw.timestampSec : undefined,
      timestampLabel:
        typeof findingRaw.timestampLabel === 'string'
          ? findingRaw.timestampLabel
          : undefined,
    };

    return finding;
  });

  const totalFindings =
    isRecord(report.summary) && typeof report.summary.totalFindings === 'number'
      ? report.summary.totalFindings
      : undefined;

  const transcript = isRecord(report.transcript)
    ? {
        source: 'youtube_api' as const,
        unavailableReason:
          typeof report.transcript.unavailableReason === 'string'
            ? report.transcript.unavailableReason
            : undefined,
        segments: Array.isArray(report.transcript.segments)
          ? report.transcript.segments
              .filter(isRecord)
              .map((segment, segIdx) => ({
                id: asString(segment.id, `transcript.segments[${segIdx}].id`),
                startSec: asNumber(segment.startSec, `transcript.segments[${segIdx}].startSec`),
                startLabel: asString(
                  segment.startLabel,
                  `transcript.segments[${segIdx}].startLabel`,
                ),
                text: asString(segment.text, `transcript.segments[${segIdx}].text`),
              }))
          : [],
      }
    : undefined;

  return {
    url,
    title: typeof report.title === 'string' ? report.title : undefined,
    scanKind:
      report.scanKind === 'webpage' || report.scanKind === 'youtube_video'
        ? report.scanKind
        : undefined,
    videoId: typeof report.videoId === 'string' ? report.videoId : undefined,
    transcript,
    findings,
    summary: totalFindings == null ? undefined : { totalFindings },
  };
}

export function assertStructuralRules(report: ScanReport): void {
  for (const [idx, finding] of report.findings.entries()) {
    expect(finding.issueTypes.length, `Finding ${idx} must have at least one issue type.`).toBeGreaterThan(0);
    expect(finding.quote.length, `Finding ${idx} quote should be non-empty.`).toBeGreaterThan(0);
    expect(finding.rationale.length, `Finding ${idx} rationale should be non-empty.`).toBeGreaterThan(0);

    if (finding.issueTypes.includes('misinformation')) {
      expect(
        (finding.correction ?? '').trim().length,
        `Finding ${idx} marked misinformation must include correction.`,
      ).toBeGreaterThan(0);
    }

    if (finding.issueTypes.includes('fallacy')) {
      const subtype = normalizeLabel(finding.subtype ?? '');
      expect(
        FALLACY_SUBTYPES.has(subtype),
        `Finding ${idx} fallacy subtype "${finding.subtype ?? ''}" is outside approved core taxonomy.`,
      ).toBeTruthy();
    }

    if (finding.issueTypes.includes('bias')) {
      const subtype = normalizeLabel(finding.subtype ?? '');
      expect(
        BIAS_SUBTYPES.has(subtype),
        `Finding ${idx} bias subtype "${finding.subtype ?? ''}" is outside approved core taxonomy.`,
      ).toBeTruthy();
    }
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  closeExtensionContext,
  coerceReport,
  ensureApiKey,
  launchExtensionContext,
  openPopupPage,
  sendRuntimeMessageWithRetry,
  waitForScanCompletion,
} from './extension-fixture';

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=wbRa7WFtNqs';
const ARTIFACT_DIR = path.resolve(process.cwd(), 'test-results/youtube-live');

test('YouTube live smoke: transcript panel + timestamp seeking', async () => {
  test.setTimeout(360_000);
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.GEMINI_API_KEY;
  expect(
    apiKey,
    'Missing OPENROUTER_API_KEY (GEMINI_API_KEY fallback is accepted for local smoke).',
  ).toBeTruthy();

  await fs.mkdir(ARTIFACT_DIR, { recursive: true });

  const launch = await launchExtensionContext();
  const { context, extensionId, userDataDir } = launch;

  let reportPayload: unknown;
  let page: Page | null = null;
  let popup: Page | null = null;

  try {
    page = await context.newPage();
    await page.goto(YOUTUBE_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    popup = await openPopupPage(context, extensionId);
    await ensureApiKey(popup, apiKey!);
    await expect(
      popup.getByText('Background is waking up. Try again in a moment.'),
    ).toHaveCount(0);

    const tabId = await popup.evaluate(async (url) => {
      const runtimeChrome = (globalThis as any).chrome;
      const tabs = await runtimeChrome.tabs.query({ currentWindow: true, url });
      return tabs[0]?.id ?? null;
    }, YOUTUBE_URL);
    expect(tabId, 'Unable to locate YouTube watch tab for live smoke test.').not.toBeNull();

    const startResponse = await sendRuntimeMessageWithRetry<
      { type: 'START_SCAN'; tabId?: number },
      Record<string, unknown>
    >(popup, { type: 'START_SCAN', tabId: tabId! });

    const startedTabId = typeof startResponse.tabId === 'number' ? startResponse.tabId : tabId!;
    const status = await waitForScanCompletion(popup, startedTabId, 300_000);
    const state = String((status.state ?? status.status ?? '')).toLowerCase();
    expect(['done', 'completed']).toContain(state);

    reportPayload = await sendRuntimeMessageWithRetry<
      { type: 'GET_REPORT'; tabId: number },
      unknown
    >(popup, { type: 'GET_REPORT', tabId: startedTabId });

    const report = coerceReport(reportPayload);

    await page.bringToFront();
    await expect(page.getByTestId('yt-bias-panel')).toBeVisible({ timeout: 40_000 });
    await expect(
      page.getByText('Background is waking up. Try again in a moment.'),
    ).toHaveCount(0);

    if (report.transcript?.unavailableReason) {
      await expect(page.getByTestId('yt-transcript-error')).toBeVisible();
    } else {
      await expect(page.getByTestId('yt-transcript-row').first()).toBeVisible();
    }

    const findingWithTimestamp = report.findings.find((finding) => typeof finding.timestampSec === 'number');
    if (findingWithTimestamp) {
      await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video) {
          video.currentTime = 0;
        }
      });
      await page.getByTestId('yt-findings-list').getByTestId('yt-timestamp-button').first().click();
      await page.waitForTimeout(1000);
      const current = await page.evaluate(() => {
        const video = document.querySelector('video');
        return video ? video.currentTime : -1;
      });
      expect(current).toBeGreaterThanOrEqual((findingWithTimestamp.timestampSec ?? 0) - 3);
    }
  } finally {
    if (popup) {
      await popup.screenshot({ path: path.join(ARTIFACT_DIR, 'popup.png') });
    }
    if (page) {
      await page.screenshot({ path: path.join(ARTIFACT_DIR, 'page.png'), fullPage: true });
    }
    if (reportPayload !== undefined) {
      await fs.writeFile(
        path.join(ARTIFACT_DIR, 'report.json'),
        JSON.stringify(reportPayload, null, 2),
        'utf8',
      );
    }
    await popup?.close().catch(() => {});
    await closeExtensionContext({ context, userDataDir });
  }
});

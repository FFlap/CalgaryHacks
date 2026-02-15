import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  closeExtensionContext,
  launchExtensionContext,
  openPopupPage,
} from './extension-fixture';

const YOUTUBE_URL = 'https://youtube.com/watch?v=wbRa7WFtNqs';
const ARTIFACT_DIR = path.resolve(process.cwd(), 'test-results/youtube');

test('YouTube embedded panel renders transcript and seeks on timestamp/text click', async () => {
  test.setTimeout(180_000);
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });

  const launch = await launchExtensionContext();
  const { context, extensionId, userDataDir } = launch;

  let page: Page | null = null;
  let popup: Page | null = null;

  try {
    page = await context.newPage();
    await page.goto(YOUTUBE_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});

    popup = await openPopupPage(context, extensionId);
    const currentPageUrl = page.url();
    const tabId = await popup.evaluate(async (videoId) => {
      const runtimeChrome = (globalThis as any).chrome;
      const tabs = await runtimeChrome.tabs.query({ currentWindow: true });
      const match = tabs.find(
        (tab: { id?: number; url?: string }) =>
          typeof tab.url === 'string' &&
          tab.url.includes('youtube.com/watch') &&
          tab.url.includes(`v=${videoId}`),
      );
      return match?.id ?? null;
    }, 'wbRa7WFtNqs');
    expect(tabId, 'Failed to resolve YouTube tab for seeded embedded-panel test.').not.toBeNull();

    await popup.evaluate(async ({ targetTabId, targetUrl }) => {
      const runtimeChrome = (globalThis as any).chrome;
      await runtimeChrome.storage.local.set({
        [`scan_report_${targetTabId}`]: {
          tabId: targetTabId,
          url: targetUrl,
          title: 'Seeded YouTube Report',
          scanKind: 'youtube_video',
          videoId: 'wbRa7WFtNqs',
          transcript: {
            source: 'youtube_api',
            segments: [
              { id: 'seg-1', startSec: 0, startLabel: '0:00', text: 'Intro line.' },
              { id: 'seg-2', startSec: 20, startLabel: '0:20', text: 'Flagged narrative line.' },
              { id: 'seg-3', startSec: 52, startLabel: '0:52', text: 'Another line in transcript.' },
            ],
          },
          scannedAt: new Date().toISOString(),
          summary: {
            totalFindings: 2,
            misinformationCount: 1,
            fallacyCount: 1,
            biasCount: 1,
          },
          findings: [
            {
              id: 'yt-finding-1',
              quote: 'Flagged narrative line.',
              issueTypes: ['bias', 'fallacy'],
              subtype: 'loaded language',
              confidence: 0.92,
              severity: 4,
              rationale: 'Loaded framing language around the topic.',
              timestampSec: 20,
              timestampLabel: '0:20',
            },
            {
              id: 'yt-finding-2',
              quote: 'Another line in transcript.',
              issueTypes: ['misinformation'],
              confidence: 0.9,
              severity: 3,
              rationale: 'Claim conflicts with known public chronology.',
              correction: 'Sequence differs from official timeline.',
              timestampSec: 52,
              timestampLabel: '0:52',
            },
          ],
          truncated: false,
          analyzedChars: 360,
        },
      });
    }, { targetTabId: tabId, targetUrl: currentPageUrl });

    await popup.close();
    popup = null;

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('yt-bias-panel')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('yt-findings-list')).toBeVisible();
    await expect(page.getByTestId('yt-transcript-row').first()).toBeVisible();
    const mountMeta = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="yt-bias-panel"]');
      return {
        hasPanel: Boolean(panel),
        insideSecondary: Boolean(panel?.closest('#secondary')),
        firstChildInParent: Boolean(panel?.parentElement && panel.parentElement.firstElementChild === panel),
      };
    });
    expect(mountMeta.hasPanel).toBe(true);
    expect(mountMeta.insideSecondary).toBe(true);
    expect(mountMeta.firstChildInParent).toBe(true);

    const beforeTime = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video) return -1;
      video.currentTime = 0;
      return video.currentTime;
    });
    expect(beforeTime).toBeGreaterThanOrEqual(0);

    await page
      .getByTestId('yt-findings-list')
      .getByTestId('yt-timestamp-button')
      .first()
      .click();
    await page.waitForTimeout(900);

    const afterTime = await page.evaluate(() => {
      const video = document.querySelector('video');
      return video ? video.currentTime : -1;
    });
    expect(afterTime).toBeGreaterThanOrEqual(14);

    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        video.currentTime = 0;
      }
    });

    await page
      .getByTestId('yt-transcript-row')
      .nth(1)
      .getByTestId('yt-transcript-text')
      .click();
    await page.waitForTimeout(900);

    const afterTextClickTime = await page.evaluate(() => {
      const video = document.querySelector('video');
      return video ? video.currentTime : -1;
    });
    expect(afterTextClickTime).toBeGreaterThanOrEqual(14);

    await page.getByRole('button', { name: 'Fallacy' }).click();
    const filteredCards = page.getByTestId('yt-finding-item');
    const filteredCount = await filteredCards.count();
    expect(filteredCount).toBeGreaterThan(0);
    for (let i = 0; i < filteredCount; i += 1) {
      await expect(filteredCards.nth(i)).toHaveAttribute('data-issue-types', /fallacy/);
    }
  } finally {
    if (page) {
      await page.screenshot({
        path: path.join(ARTIFACT_DIR, 'page.png'),
        fullPage: true,
      });
      const panel = page.getByTestId('yt-bias-panel');
      if ((await panel.count()) > 0) {
        await panel.screenshot({
          path: path.join(ARTIFACT_DIR, 'panel.png'),
        });
      }
    }
    await popup?.close().catch(() => {});
    await closeExtensionContext({ context, userDataDir });
  }
});

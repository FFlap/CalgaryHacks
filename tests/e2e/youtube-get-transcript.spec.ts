import { expect, test } from '@playwright/test';
import {
  closeExtensionContext,
  launchExtensionContext,
  openPopupPage,
  sendRuntimeMessageWithRetry,
  waitForBackgroundReady,
} from './extension-fixture';

const VIDEO_ID = 'wbRa7WFtNqs';

test('GET_TRANSCRIPT fetches transcript for video wbRa7WFtNqs via background', async () => {
  test.setTimeout(60_000);

  const launch = await launchExtensionContext();
  const { context, extensionId, userDataDir } = launch;

  try {
    const videoPage = await context.newPage();
    await videoPage.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await videoPage.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const popup = await openPopupPage(context, extensionId);
    await waitForBackgroundReady(popup);
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
    }, VIDEO_ID);

    expect(tabId, 'Failed to resolve YouTube tab id for transcript fetch.').not.toBeNull();

    const result = await sendRuntimeMessageWithRetry<
      { type: 'GET_TRANSCRIPT'; videoId: string; tabId?: number },
      { ok: boolean; source?: string; segments?: any[]; reason?: string }
    >(popup, { type: 'GET_TRANSCRIPT', videoId: VIDEO_ID, tabId: tabId ?? undefined });

    console.log('GET_TRANSCRIPT result:', JSON.stringify({
      ok: result.ok,
      source: result.source,
      segmentCount: result.segments?.length ?? 0,
      reason: result.reason,
      firstSegment: result.segments?.[0],
      lastSegment: result.segments?.[result.segments.length - 1],
    }, null, 2));

    expect(result.ok, `Expected ok=true but got reason: ${result.reason}`).toBe(true);
    expect(result.source).toBe('youtube_api');
    expect(result.segments).toBeDefined();
    expect(result.segments!.length).toBeGreaterThanOrEqual(3);

    // Validate segment structure
    for (const segment of result.segments!.slice(0, 5)) {
      expect(segment).toHaveProperty('id');
      expect(segment).toHaveProperty('startSec');
      expect(segment).toHaveProperty('startLabel');
      expect(segment).toHaveProperty('text');
      expect(typeof segment.startSec).toBe('number');
      expect(segment.startSec).toBeGreaterThanOrEqual(0);
      expect(typeof segment.text).toBe('string');
      expect(segment.text.length).toBeGreaterThan(0);
    }

    // Timestamps should be monotonically non-decreasing
    for (let i = 1; i < result.segments!.length; i++) {
      expect(result.segments![i].startSec).toBeGreaterThanOrEqual(result.segments![i - 1].startSec);
    }

    await popup.close();
    await videoPage.close();
  } finally {
    await closeExtensionContext({ context, userDataDir });
  }
});

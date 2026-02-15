import { expect, test, type Page } from '@playwright/test';
import {
  closeExtensionContext,
  launchExtensionContext,
  openPopupPage,
  sendRuntimeMessageWithRetry,
} from './extension-fixture';

test('click-origin focus routing surfaces reasoning in popup', async () => {
  const launch = await launchExtensionContext();
  const { context, extensionId, userDataDir } = launch;

  let articlePage: Page | null = null;
  let popupPage: Page | null = null;

  const findingId = 'focus-test-finding';

  try {
    articlePage = await context.newPage();
    await articlePage.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    popupPage = await openPopupPage(context, extensionId);

    const tabId = await popupPage.evaluate(async () => {
      const runtimeChrome = (globalThis as any).chrome;
      const tabs = await runtimeChrome.tabs.query({
        currentWindow: true,
        url: ['https://example.com/*', 'http://example.com/*'],
      });
      return tabs[0]?.id ?? null;
    });

    expect(tabId, 'Failed to resolve target article tab for popup focus test.').not.toBeNull();

    await popupPage.evaluate(async ({ targetTabId, focusId }) => {
      const runtimeChrome = (globalThis as any).chrome;
      await runtimeChrome.storage.local.set({
        [`scan_report_${targetTabId}`]: {
          tabId: targetTabId,
          url: 'https://example.com/',
          title: 'Example Domain',
          scannedAt: new Date().toISOString(),
          summary: {
            totalFindings: 1,
            misinformationCount: 1,
            fallacyCount: 0,
            biasCount: 0,
          },
          findings: [
            {
              id: focusId,
              quote: 'Example Domain',
              issueTypes: ['misinformation'],
              confidence: 0.95,
              severity: 2,
              rationale: 'Test rationale from highlight click flow.',
              correction: 'Test correction.',
              citations: [
                {
                  title: 'Example source',
                  url: 'https://example.com/',
                  domain: 'example.com',
                },
                {
                  title: 'Example source 2',
                  url: 'https://iana.org/',
                  domain: 'iana.org',
                },
              ],
              highlightApplied: true,
            },
          ],
          truncated: false,
          analyzedChars: 100,
        },
      });
    }, { targetTabId: tabId, focusId: findingId });

    await sendRuntimeMessageWithRetry<
      { type: 'OPEN_POPUP_FOR_FINDING'; tabId: number; findingId: string },
      { ok: boolean }
    >(popupPage, {
      type: 'OPEN_POPUP_FOR_FINDING',
      tabId,
      findingId,
    });

    await popupPage.close();
    popupPage = await openPopupPage(context, extensionId, tabId);

    const focusedCard = popupPage.locator(
      `[data-finding-id="${findingId}"][data-focused="true"]`,
    );

    await expect(focusedCard).toBeVisible();
    await expect(focusedCard.getByTestId('finding-rationale')).toContainText(
      'Test rationale from highlight click flow.',
    );
  } finally {
    await popupPage?.close().catch(() => {});
    await articlePage?.close().catch(() => {});
    await closeExtensionContext({ context, userDataDir });
  }
});

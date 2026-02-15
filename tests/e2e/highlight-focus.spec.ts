import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  closeExtensionContext,
  launchExtensionContext,
  openPopupPage,
  sendRuntimeMessageWithRetry,
} from './extension-fixture';

function installEvidenceRoutes(context: BrowserContext): void {
  void context.route('https://factchecktools.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        claims: [
          {
            text: 'Example Domain',
            claimReview: [
              {
                publisher: { name: 'PolitiFact' },
                title: 'Fact-check review',
                textualRating: 'False',
                url: 'https://www.politifact.com/factchecks/example',
                reviewDate: '2024-04-10',
                languageCode: 'en',
              },
            ],
          },
        ],
      }),
    });
  });

  void context.route('https://en.wikipedia.org/w/api.php**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        query: {
          search: [{ title: 'Example Domain', snippet: 'Example snippet', pageid: 1 }],
        },
      }),
    });
  });

  void context.route('https://www.wikidata.org/w/api.php**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        search: [{ id: 'Q1', label: 'Universe', description: 'desc', concepturi: 'https://www.wikidata.org/wiki/Q1' }],
      }),
    });
  });

  void context.route('https://eutils.ncbi.nlm.nih.gov/**esearch.fcgi**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ esearchresult: { idlist: ['12345'] } }),
    });
  });

  void context.route('https://eutils.ncbi.nlm.nih.gov/**esummary.fcgi**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          uids: ['12345'],
          '12345': {
            title: 'Study',
            fulljournalname: 'Medical Journal',
            pubdate: '2023 Jan',
          },
        },
      }),
    });
  });

  void context.route('https://api.gdeltproject.org/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        articles: [
          {
            title: 'Related reporting article',
            url: 'https://www.reuters.com/world/example',
            domain: 'reuters.com',
            tone: '-0.8',
            seendate: '20240410T100000Z',
          },
        ],
      }),
    });
  });
}

test('click-origin focus routing surfaces reasoning in popup', async () => {
  const launch = await launchExtensionContext();
  const { context, extensionId, userDataDir } = launch;
  installEvidenceRoutes(context);

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
    await expect(focusedCard.getByTestId('evidence-content')).toBeVisible();
    await expect(focusedCard.getByTestId('factcheck-list')).toContainText('PolitiFact');
  } finally {
    await popupPage?.close().catch(() => {});
    await articlePage?.close().catch(() => {});
    await closeExtensionContext({ context, userDataDir });
  }
});

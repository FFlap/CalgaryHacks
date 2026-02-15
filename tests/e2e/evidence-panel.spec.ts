import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  closeExtensionContext,
  launchExtensionContext,
  openPopupPage,
} from './extension-fixture';

interface RouteCounters {
  google: number;
  wikipedia: number;
  wikidata: number;
  pubmedSearch: number;
  pubmedSummary: number;
  gdelt: number;
}

function installEvidenceRoutes(context: BrowserContext, options?: { failWikipedia?: boolean }): RouteCounters {
  const counters: RouteCounters = {
    google: 0,
    wikipedia: 0,
    wikidata: 0,
    pubmedSearch: 0,
    pubmedSummary: 0,
    gdelt: 0,
  };

  void context.route('https://factchecktools.googleapis.com/**', async (route) => {
    counters.google += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        claims: [
          {
            text: 'Example Domain claim text',
            claimant: 'Example claimant',
            claimReview: [
              {
                publisher: { name: 'PolitiFact' },
                title: 'Fact check review',
                textualRating: 'False',
                url: 'https://www.politifact.com/factchecks/example',
                reviewDate: '2024-03-15',
                languageCode: 'en',
              },
            ],
          },
        ],
      }),
    });
  });

  void context.route('https://en.wikipedia.org/w/api.php**', async (route) => {
    counters.wikipedia += 1;
    if (options?.failWikipedia) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        query: {
          search: [
            {
              title: 'Example Domain',
              snippet: 'A domain used in examples and technical documentation.',
              pageid: 1,
            },
          ],
        },
      }),
    });
  });

  void context.route('https://www.wikidata.org/w/api.php**', async (route) => {
    counters.wikidata += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        search: [
          {
            id: 'Q1',
            label: 'Universe',
            description: 'totality of space and time',
            concepturi: 'https://www.wikidata.org/wiki/Q1',
          },
        ],
      }),
    });
  });

  void context.route('https://eutils.ncbi.nlm.nih.gov/**esearch.fcgi**', async (route) => {
    counters.pubmedSearch += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        esearchresult: {
          idlist: ['12345'],
        },
      }),
    });
  });

  void context.route('https://eutils.ncbi.nlm.nih.gov/**esummary.fcgi**', async (route) => {
    counters.pubmedSummary += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          uids: ['12345'],
          '12345': {
            title: 'Sample peer-reviewed study',
            fulljournalname: 'Medical Journal',
            pubdate: '2023 Jan',
          },
        },
      }),
    });
  });

  void context.route('https://api.gdeltproject.org/**', async (route) => {
    counters.gdelt += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        articles: [
          {
            title: 'Related reporting article',
            url: 'https://www.reuters.com/world/example-article',
            domain: 'reuters.com',
            seendate: '20240315T120000Z',
            tone: '-1.3',
            language: 'English',
          },
        ],
      }),
    });
  });

  return counters;
}

async function resolveExampleTabId(popupPage: Page): Promise<number> {
  const tabId = await popupPage.evaluate(async () => {
    const runtimeChrome = (globalThis as any).chrome;
    const tabs = await runtimeChrome.tabs.query({
      currentWindow: true,
      url: ['https://example.com/*', 'http://example.com/*'],
    });
    return tabs[0]?.id ?? null;
  });

  if (typeof tabId !== 'number') {
    throw new Error('Failed to resolve example.com tab id.');
  }

  return tabId;
}

async function seedReport(popupPage: Page, tabId: number, findingId: string): Promise<void> {
  await popupPage.evaluate(
    async ({ targetTabId, focusId }) => {
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
              confidence: 0.93,
              severity: 3,
              rationale: 'Evidence test rationale.',
              correction: 'Evidence correction text for query context.',
              highlightApplied: true,
            },
          ],
          truncated: false,
          analyzedChars: 300,
        },
      });
    },
    { targetTabId: tabId, focusId: findingId },
  );
}

async function seedGoogleFactCheckApiKey(popupPage: Page): Promise<void> {
  await popupPage.evaluate(async () => {
    const runtimeChrome = (globalThis as any).chrome;
    await runtimeChrome.storage.local.set({
      google_fact_check_api_key: 'e2e-google-fact-check-key',
    });
  });
}

test('evidence panel loads trusted sources and reuses cached response across popup sessions', async () => {
  const launch = await launchExtensionContext();
  const { context, extensionId, userDataDir } = launch;
  const counters = installEvidenceRoutes(context);

  let articlePage: Page | null = null;
  let popupPage: Page | null = null;

  try {
    articlePage = await context.newPage();
    await articlePage.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    popupPage = await openPopupPage(context, extensionId);
    const tabId = await resolveExampleTabId(popupPage);
    const findingId = 'evidence-test-finding';

    await seedGoogleFactCheckApiKey(popupPage);
    await seedReport(popupPage, tabId, findingId);

    await popupPage.close();
    popupPage = await openPopupPage(context, extensionId, tabId);

    await popupPage.locator(`[data-finding-id="${findingId}"] .finding-summary`).click();

    const focusedCard = popupPage.locator(`[data-finding-id="${findingId}"]`);
    await focusedCard.getByTestId('load-evidence').click();
    await expect(focusedCard.getByTestId('evidence-content')).toBeVisible();
    await expect(focusedCard.getByTestId('evidence-status-pill')).toContainText('Contradicted');
    await expect(focusedCard.getByTestId('factcheck-list')).toContainText('PolitiFact');
    await expect(focusedCard.getByTestId('corroboration-list')).toContainText('Example Domain');
    await expect(focusedCard.getByTestId('gdelt-list')).toContainText('Related reporting article');

    expect(counters.google).toBe(1);
    expect(counters.wikipedia).toBe(1);
    expect(counters.wikidata).toBe(1);
    expect(counters.pubmedSearch).toBe(1);
    expect(counters.pubmedSummary).toBe(1);
    expect(counters.gdelt).toBe(1);

    await popupPage.close();
    popupPage = await openPopupPage(context, extensionId, tabId);
    await popupPage.locator(`[data-finding-id="${findingId}"] .finding-summary`).click();

    const cachedCard = popupPage.locator(`[data-finding-id="${findingId}"]`);
    await cachedCard.getByTestId('load-evidence').click();
    await expect(cachedCard.getByTestId('evidence-content')).toBeVisible();
    await expect(cachedCard.getByTestId('factcheck-list')).toContainText('PolitiFact');

    await popupPage.waitForTimeout(600);
    expect(counters.google).toBe(1);
    expect(counters.wikipedia).toBe(1);
    expect(counters.wikidata).toBe(1);
    expect(counters.pubmedSearch).toBe(1);
    expect(counters.pubmedSummary).toBe(1);
    expect(counters.gdelt).toBe(1);
  } finally {
    await popupPage?.close().catch(() => {});
    await articlePage?.close().catch(() => {});
    await closeExtensionContext({ context, userDataDir });
  }
});

test('evidence panel tolerates provider failure and still renders remaining sources', async () => {
  const launch = await launchExtensionContext();
  const { context, extensionId, userDataDir } = launch;
  installEvidenceRoutes(context, { failWikipedia: true });

  let articlePage: Page | null = null;
  let popupPage: Page | null = null;

  try {
    articlePage = await context.newPage();
    await articlePage.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    popupPage = await openPopupPage(context, extensionId);
    const tabId = await resolveExampleTabId(popupPage);
    const findingId = 'evidence-failure-finding';

    await seedGoogleFactCheckApiKey(popupPage);
    await seedReport(popupPage, tabId, findingId);

    await popupPage.close();
    popupPage = await openPopupPage(context, extensionId, tabId);

    await popupPage.locator(`[data-finding-id="${findingId}"] .finding-summary`).click();

    const card = popupPage.locator(`[data-finding-id="${findingId}"]`);
    await card.getByTestId('load-evidence').click();
    await expect(card.getByTestId('evidence-content')).toBeVisible();
    await expect(card.getByTestId('factcheck-list')).toContainText('PolitiFact');
    await expect(card.getByTestId('gdelt-list')).toContainText('Related reporting article');
    await expect(card.getByTestId('evidence-partial-errors')).toContainText('wikipedia');
  } finally {
    await popupPage?.close().catch(() => {});
    await articlePage?.close().catch(() => {});
    await closeExtensionContext({ context, userDataDir });
  }
});

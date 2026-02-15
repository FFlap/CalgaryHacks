import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  FOX_NEWS_URL,
  assertStructuralRules,
  clickFirstHighlightAndGetId,
  closeExtensionContext,
  coerceReport,
  dismissFoxNewsOverlays,
  ensureApiKey,
  launchExtensionContext,
  openPopupPage,
  sendRuntimeMessageWithRetry,
  startScan,
  waitForScanCompletion,
} from './extension-fixture';

const ARTIFACT_DIR = path.resolve(process.cwd(), 'test-results/foxnews');

test('Fox News page scan (live Gemini grounding, structural assertions)', async () => {
  test.setTimeout(300_000);
  expect(
    process.env.GEMINI_API_KEY,
    'Missing GEMINI_API_KEY. Export a valid key before running this live E2E test.',
  ).toBeTruthy();

  await fs.mkdir(ARTIFACT_DIR, { recursive: true });

  const launch = await launchExtensionContext();
  const { context, extensionId, userDataDir } = launch;

  let reportPayload: unknown;
  let popupPage: Page | null = null;
  let articlePage: Page | null = null;

  try {
    articlePage = await context.newPage();
    await articlePage.goto(FOX_NEWS_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await articlePage.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await dismissFoxNewsOverlays(articlePage);
    await articlePage.bringToFront();

    popupPage = await openPopupPage(context, extensionId);
    await ensureApiKey(popupPage, process.env.GEMINI_API_KEY!);
    await expect(
      popupPage.getByText('Background is waking up. Try again in a moment.'),
    ).toHaveCount(0);

    const startResponse = await sendRuntimeMessageWithRetry<
      { type: 'START_SCAN'; tabId?: number },
      Record<string, unknown>
    >(popupPage, { type: 'START_SCAN' }).catch(async () => startScan(popupPage!));
    const startTabId =
      startResponse && typeof startResponse.tabId === 'number'
        ? startResponse.tabId
        : undefined;

    const status = await waitForScanCompletion(popupPage, startTabId, 240_000);
    const statusState = String((status.state ?? status.status ?? '')).toLowerCase();
    expect(['done', 'completed']).toContain(statusState);

    const statusTabId =
      typeof status.tabId === 'number'
        ? status.tabId
        : typeof status.activeTabId === 'number'
          ? status.activeTabId
          : undefined;

    if (statusTabId == null) {
      throw new Error(
        `Unable to resolve tab id from status payload: ${JSON.stringify(status)}`,
      );
    }

    reportPayload = await sendRuntimeMessageWithRetry<
      { type: string; tabId: number },
      unknown
    >(popupPage, {
      type: 'GET_REPORT',
      tabId: statusTabId,
    });

    const report = coerceReport(reportPayload);
    await expect(
      popupPage.getByText('Background is waking up. Try again in a moment.'),
    ).toHaveCount(0);
    expect(new URL(report.url).hostname).toBe('www.foxnews.com');
    assertStructuralRules(report);

    const findingCount = report.summary?.totalFindings ?? report.findings.length;
    if (findingCount > 0) {
      const highlightCount = await articlePage.locator('mark[data-cred-id]').count();
      expect(
        highlightCount,
        'Expected at least one inline highlight when findings are present.',
      ).toBeGreaterThan(0);

      const clickedFindingId = await clickFirstHighlightAndGetId(articlePage);
      expect(clickedFindingId, 'Expected a highlight to provide a finding id.').toBeTruthy();

      await popupPage.close();
      popupPage = await openPopupPage(context, extensionId);
      await popupPage.waitForTimeout(600);

      const focusedCard = popupPage.locator(
        `[data-finding-id="${clickedFindingId}"][data-focused="true"]`,
      );
      await expect(
        focusedCard,
        'Clicking a source highlight should focus its reasoning card in popup.',
      ).toBeVisible();
      await expect(focusedCard.getByTestId('finding-rationale')).toBeVisible();
    } else {
      await expect(
        popupPage.getByText(/no high-confidence issues/i),
        'Expected explicit no-findings state in popup when findings are empty.',
      ).toBeVisible();
    }
  } finally {
    if (popupPage) {
      await popupPage.screenshot({
        path: path.join(ARTIFACT_DIR, 'popup.png'),
      });
    }
    if (articlePage) {
      await articlePage.screenshot({
        path: path.join(ARTIFACT_DIR, 'page.png'),
        fullPage: true,
      });
    }
    if (reportPayload !== undefined) {
      await fs.writeFile(
        path.join(ARTIFACT_DIR, 'report.json'),
        JSON.stringify(reportPayload, null, 2),
        'utf8',
      );
    }
    await closeExtensionContext({ context, userDataDir });
  }
});

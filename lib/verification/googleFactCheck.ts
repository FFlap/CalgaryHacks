import type { FactCheckMatch, NormalizedVerdict } from '@/lib/types';

import { fetchJsonWithRetry } from '@/lib/verification/http';

const GOOGLE_FACT_CHECK_API = 'https://factchecktools.googleapis.com/v1alpha1/claims:search';

declare const __GOOGLE_FACT_CHECK_API_KEY__: string;

interface GoogleFactCheckResponse {
  claims?: Array<{
    text?: string;
    claimant?: string;
    claimReview?: Array<{
      publisher?: {
        name?: string;
        site?: string;
      };
      title?: string;
      textualRating?: string;
      url?: string;
      reviewDate?: string;
      languageCode?: string;
    }>;
  }>;
}

function normalizeVerdict(input: string): NormalizedVerdict {
  const text = input.toLowerCase();

  if (
    /(false|pants on fire|incorrect|fake|hoax|scam|baseless|fabricated|debunked|not true|mostly false)/.test(
      text,
    )
  ) {
    return 'contradicted';
  }

  if (/(true|correct|accurate|supported|mostly true|legitimate)/.test(text)) {
    return 'supported';
  }

  if (/(misleading|partly|partially|half true|mixed|out of context|disputed|unproven)/.test(text)) {
    return 'contested';
  }

  return 'unknown';
}

export function hasGoogleFactCheckApiKey(): boolean {
  return Boolean(__GOOGLE_FACT_CHECK_API_KEY__ && __GOOGLE_FACT_CHECK_API_KEY__.trim().length > 0);
}

export async function searchGoogleFactChecks(query: string): Promise<{
  configured: boolean;
  matches: FactCheckMatch[];
}> {
  if (!hasGoogleFactCheckApiKey()) {
    return { configured: false, matches: [] };
  }

  const params = new URLSearchParams({
    query,
    languageCode: 'en',
    pageSize: '10',
    key: __GOOGLE_FACT_CHECK_API_KEY__,
  });

  const url = `${GOOGLE_FACT_CHECK_API}?${params.toString()}`;
  const json = await fetchJsonWithRetry<GoogleFactCheckResponse>(url, {
    label: 'Google Fact Check API',
    retries: 1,
  });

  const claims = Array.isArray(json.claims) ? json.claims : [];
  const rawMatches: FactCheckMatch[] = [];

  for (const claim of claims) {
    const claimText = String(claim.text ?? query).trim();
    const claimant = String(claim.claimant ?? '').trim() || undefined;
    const reviews = Array.isArray(claim.claimReview) ? claim.claimReview : [];

    for (const review of reviews) {
      const publisher =
        String(review.publisher?.name ?? review.publisher?.site ?? 'Unknown Publisher').trim() ||
        'Unknown Publisher';
      const reviewTitle = String(review.title ?? 'Fact-check review').trim() || 'Fact-check review';
      const textualRating = String(review.textualRating ?? '').trim() || undefined;
      const normalizedVerdict = normalizeVerdict(`${textualRating ?? ''} ${reviewTitle}`);

      rawMatches.push({
        claimText,
        claimant,
        publisher,
        reviewTitle,
        textualRating,
        reviewUrl: String(review.url ?? '').trim(),
        reviewDate: String(review.reviewDate ?? '').trim() || undefined,
        languageCode: String(review.languageCode ?? '').trim() || undefined,
        normalizedVerdict,
        sourceType: 'Google Fact Check API',
      });
    }
  }

  const deduped: FactCheckMatch[] = [];
  const seen = new Set<string>();

  for (const item of rawMatches) {
    const key = item.reviewUrl || `${item.publisher}|${item.reviewTitle}|${item.reviewDate ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= 12) {
      break;
    }
  }

  return {
    configured: true,
    matches: deduped,
  };
}

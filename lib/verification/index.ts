import type { Finding, FindingEvidence } from '@/lib/types';

import { classifyVerificationStatus } from '@/lib/verification/classify';
import {
  hasGoogleFactCheckApiKey,
  searchGoogleFactChecks,
} from '@/lib/verification/googleFactCheck';
import { searchGdeltArticles } from '@/lib/verification/gdelt';
import { searchPubMed } from '@/lib/verification/pubmed';
import { buildFindingQuery, extractSearchKeywords } from '@/lib/verification/query';
import { searchWikidata } from '@/lib/verification/wikidata';
import { searchWikipedia } from '@/lib/verification/wikipedia';

function buildQueryVariants(input: {
  base: string;
  quote: string;
  correction?: string;
}): string[] {
  const variants = [
    input.base,
    extractSearchKeywords(input.quote),
    input.correction ? extractSearchKeywords(input.correction) : '',
  ]
    .map((value) => value.trim())
    .filter((value) => value.length >= 4);

  return Array.from(new Set(variants)).slice(0, 3);
}

async function firstNonEmpty<T>(
  queries: string[],
  searcher: (query: string) => Promise<T[]>,
): Promise<T[]> {
  for (const query of queries) {
    const rows = await searcher(query);
    if (rows.length > 0) {
      return rows;
    }
  }
  return [];
}

async function searchFactChecksWithFallback(
  queries: string[],
  apiKey?: string | null,
): Promise<{ configured: boolean; matches: FindingEvidence['factChecks'] }> {
  let configured = hasGoogleFactCheckApiKey(apiKey);
  for (const query of queries) {
    const result = await searchGoogleFactChecks(query, apiKey);
    configured = result.configured;
    if (result.matches.length > 0) {
      return result;
    }
  }
  return { configured, matches: [] };
}

export async function buildFindingEvidence(input: {
  tabId: number;
  finding: Pick<Finding, 'id' | 'quote' | 'correction'>;
  googleFactCheckApiKey?: string | null;
}): Promise<FindingEvidence> {
  const query = buildFindingQuery(input.finding);
  const queries = buildQueryVariants({
    base: query,
    quote: input.finding.quote,
    correction: input.finding.correction,
  });

  const [factChecksResult, wikipediaResult, wikidataResult, pubmedResult, gdeltResult] =
    await Promise.allSettled([
      searchFactChecksWithFallback(queries, input.googleFactCheckApiKey),
      firstNonEmpty(queries, searchWikipedia),
      firstNonEmpty(queries, searchWikidata),
      firstNonEmpty(queries, searchPubMed),
      firstNonEmpty(queries, searchGdeltArticles),
    ]);

  const factChecksPayload =
    factChecksResult.status === 'fulfilled'
      ? factChecksResult.value
      : { configured: hasGoogleFactCheckApiKey(input.googleFactCheckApiKey), matches: [] };

  const corroboration = {
    wikipedia: wikipediaResult.status === 'fulfilled' ? wikipediaResult.value : [],
    wikidata: wikidataResult.status === 'fulfilled' ? wikidataResult.value : [],
    pubmed: pubmedResult.status === 'fulfilled' ? pubmedResult.value : [],
  };

  const gdeltArticles = gdeltResult.status === 'fulfilled' ? gdeltResult.value : [];
  const status = classifyVerificationStatus({
    factChecks: factChecksPayload.matches,
    corroboration,
  });

  const errors: FindingEvidence['errors'] = {};
  if (factChecksResult.status === 'rejected') {
    errors.factChecks = factChecksResult.reason instanceof Error
      ? factChecksResult.reason.message
      : 'Google Fact Check lookup failed.';
  }
  if (wikipediaResult.status === 'rejected') {
    errors.wikipedia = wikipediaResult.reason instanceof Error
      ? wikipediaResult.reason.message
      : 'Wikipedia lookup failed.';
  }
  if (wikidataResult.status === 'rejected') {
    errors.wikidata = wikidataResult.reason instanceof Error
      ? wikidataResult.reason.message
      : 'Wikidata lookup failed.';
  }
  if (pubmedResult.status === 'rejected') {
    errors.pubmed = pubmedResult.reason instanceof Error
      ? pubmedResult.reason.message
      : 'PubMed lookup failed.';
  }
  // GDELT failures are treated as non-blocking and surfaced as empty results.

  return {
    tabId: input.tabId,
    findingId: input.finding.id,
    findingQuote: input.finding.quote,
    query,
    generatedAt: new Date().toISOString(),
    status,
    factChecks: factChecksPayload.matches,
    corroboration,
    gdeltArticles,
    apiStatus: {
      googleFactCheckConfigured: factChecksPayload.configured,
    },
    errors,
  };
}

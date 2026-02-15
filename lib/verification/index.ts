import type { Finding, FindingEvidence } from '@/lib/types';

import { classifyVerificationStatus } from '@/lib/verification/classify';
import {
  hasGoogleFactCheckApiKey,
  searchGoogleFactChecks,
} from '@/lib/verification/googleFactCheck';
import { searchGdeltArticles } from '@/lib/verification/gdelt';
import { searchPubMed } from '@/lib/verification/pubmed';
import { buildFindingQuery } from '@/lib/verification/query';
import { searchWikidata } from '@/lib/verification/wikidata';
import { searchWikipedia } from '@/lib/verification/wikipedia';

export async function buildFindingEvidence(input: {
  tabId: number;
  finding: Pick<Finding, 'id' | 'quote' | 'correction'>;
}): Promise<FindingEvidence> {
  const query = buildFindingQuery(input.finding);

  const [factChecksResult, wikipediaResult, wikidataResult, pubmedResult, gdeltResult] =
    await Promise.allSettled([
      searchGoogleFactChecks(query),
      searchWikipedia(query),
      searchWikidata(query),
      searchPubMed(query),
      searchGdeltArticles(query),
    ]);

  const factChecksPayload =
    factChecksResult.status === 'fulfilled'
      ? factChecksResult.value
      : { configured: hasGoogleFactCheckApiKey(), matches: [] };

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

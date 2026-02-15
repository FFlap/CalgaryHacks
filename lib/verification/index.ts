import type { Finding, FindingEvidence, ScanReport } from '@/lib/types';

import { classifyVerificationStatus } from '@/lib/verification/classify';
import {
  hasGoogleFactCheckApiKey,
  searchGoogleFactChecks,
} from '@/lib/verification/googleFactCheck';
import { searchGdeltArticles } from '@/lib/verification/gdelt';
import { searchPubMed } from '@/lib/verification/pubmed';
import { buildEvidenceQueryPack } from '@/lib/verification/query';
import { rerankEvidenceWithOpenRouter } from '@/lib/verification/relevance';
import { searchWikidata } from '@/lib/verification/wikidata';
import { searchWikipedia } from '@/lib/verification/wikipedia';

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
  finding: Pick<Finding, 'id' | 'quote' | 'correction' | 'rationale' | 'issueTypes'>;
  pageContext?: ScanReport['pageContext'];
  googleFactCheckApiKey?: string | null;
  openRouterApiKey?: string | null;
}): Promise<FindingEvidence> {
  const queryPack = buildEvidenceQueryPack(input.finding, input.pageContext);
  const query = queryPack.primary;

  const [factChecksResult, wikipediaResult, wikidataResult, pubmedResult, gdeltResult] =
    await Promise.allSettled([
      searchFactChecksWithFallback(queryPack.factCheckQueries, input.googleFactCheckApiKey),
      firstNonEmpty(queryPack.wikipediaQueries, (candidate) =>
        searchWikipedia(candidate, {
          topicTerms: queryPack.topicTerms,
          entityTerms: queryPack.entityTerms,
          intent: queryPack.intent,
        }),
      ),
      firstNonEmpty(queryPack.wikidataQueries, searchWikidata),
      firstNonEmpty(queryPack.pubmedQueries, searchPubMed),
      firstNonEmpty(queryPack.gdeltQueries, searchGdeltArticles),
    ]);

  const factChecksPayload =
    factChecksResult.status === 'fulfilled'
      ? factChecksResult.value
      : { configured: hasGoogleFactCheckApiKey(input.googleFactCheckApiKey), matches: [] };

  let corroboration = {
    wikipedia: wikipediaResult.status === 'fulfilled' ? wikipediaResult.value : [],
    wikidata: wikidataResult.status === 'fulfilled' ? wikidataResult.value : [],
    pubmed: pubmedResult.status === 'fulfilled' ? pubmedResult.value : [],
  };

  let factChecks = factChecksPayload.matches;
  let gdeltArticles = gdeltResult.status === 'fulfilled' ? gdeltResult.value : [];

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

  const rerankKey = typeof input.openRouterApiKey === 'string' ? input.openRouterApiKey.trim() : '';
  if (rerankKey) {
    try {
      const reranked = await rerankEvidenceWithOpenRouter({
        apiKey: rerankKey,
        finding: input.finding,
        pageContext: input.pageContext,
        evidence: {
          factChecks,
          corroboration,
          gdeltArticles,
        },
      });
      factChecks = reranked.factChecks;
      corroboration = reranked.corroboration;
      gdeltArticles = reranked.gdeltArticles;
    } catch (error) {
      errors.openrouter = error instanceof Error ? error.message : 'OpenRouter evidence filtering failed.';
    }
  }
  // GDELT failures are treated as non-blocking and surfaced as empty results.
  const status = classifyVerificationStatus({
    factChecks,
    corroboration,
  });

  return {
    tabId: input.tabId,
    findingId: input.finding.id,
    findingQuote: input.finding.quote,
    query,
    generatedAt: new Date().toISOString(),
    status,
    factChecks,
    corroboration,
    gdeltArticles,
    apiStatus: {
      googleFactCheckConfigured: factChecksPayload.configured,
    },
    errors,
  };
}

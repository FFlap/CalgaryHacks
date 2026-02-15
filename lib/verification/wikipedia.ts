import type { CorroborationItem } from '@/lib/types';

import { fetchJsonWithRetry } from '@/lib/verification/http';
import { extractSearchKeywords } from '@/lib/verification/query';

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const MAX_RAW_RESULTS = 12;
const MAX_FINAL_RESULTS = 5;

const TOPIC_ANCHORS = [
  'border',
  'immigration',
  'election',
  'covid',
  'vaccine',
  'climate',
  'economy',
  'inflation',
  'crime',
  'healthcare',
  'tax',
  'war',
  'ukraine',
  'gaza',
  'china',
];

interface WikipediaResponse {
  query?: {
    search?: Array<{
      title?: string;
      snippet?: string;
      pageid?: number;
    }>;
  };
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  const stopWords = new Set([
    'a',
    'an',
    'the',
    'and',
    'or',
    'but',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'has',
    'have',
    'had',
    'can',
    'could',
    'would',
    'should',
    'that',
    'this',
    'these',
    'those',
    'it',
    'its',
    'they',
    'them',
    'their',
    'he',
    'she',
    'his',
    'her',
    'denied',
    'shown',
    'showed',
    'says',
    'said',
    'claim',
    'claims',
  ]);

  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

function pickAnchorTerm(terms: string[]): string | null {
  for (const candidate of TOPIC_ANCHORS) {
    if (terms.includes(candidate)) {
      return candidate;
    }
  }

  if (terms.length === 0) {
    return null;
  }

  return [...terms].sort((left, right) => right.length - left.length)[0];
}

function buildWikipediaSearchQuery(rawQuery: string): { apiQuery: string; terms: string[] } {
  const keywordText = extractSearchKeywords(rawQuery);
  const terms = tokenize(keywordText);
  const uniqueTerms = Array.from(new Set(terms)).slice(0, 8);

  if (uniqueTerms.length === 0) {
    return { apiQuery: rawQuery, terms: [] };
  }

  const anchor = pickAnchorTerm(uniqueTerms);
  if (!anchor) {
    return { apiQuery: uniqueTerms.join(' '), terms: uniqueTerms };
  }

  const remaining = uniqueTerms.filter((term) => term !== anchor).slice(0, 5);
  const apiQuery = [`intitle:${anchor}`, ...remaining].join(' ').trim();
  return { apiQuery, terms: uniqueTerms };
}

function relevanceScore(title: string, snippet: string, terms: string[]): number {
  if (terms.length === 0) return 0;

  const normalizedTitle = title.toLowerCase();
  const normalizedSnippet = snippet.toLowerCase();
  const combined = `${normalizedTitle} ${normalizedSnippet}`;

  let overlap = 0;
  let titleOverlap = 0;
  for (const term of terms) {
    if (combined.includes(term)) {
      overlap += 1;
    }
    if (normalizedTitle.includes(term)) {
      titleOverlap += 1;
    }
  }

  let score = overlap * 2 + titleOverlap * 3;

  if (
    /policy of the (first|second)|domestic policy|economic policy|administration/.test(
      normalizedTitle,
    )
  ) {
    score -= 3;
  }

  return score;
}

export async function searchWikipedia(query: string): Promise<CorroborationItem[]> {
  const { apiQuery, terms } = buildWikipediaSearchQuery(query);

  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: apiQuery,
    utf8: '1',
    format: 'json',
    srlimit: String(MAX_RAW_RESULTS),
  });

  const url = `${WIKIPEDIA_API}?${params.toString()}`;
  const json = await fetchJsonWithRetry<WikipediaResponse>(url, {
    label: 'Wikipedia API',
    retries: 1,
  });

  const results = Array.isArray(json.query?.search) ? json.query.search : [];
  const scored = results
    .map((item) => {
      const title = String(item.title ?? 'Wikipedia page').trim();
      const snippet = stripHtml(String(item.snippet ?? '').trim());
      const score = relevanceScore(title, snippet, terms);
      return {
        title,
        snippet,
        url: `https://en.wikipedia.org/?curid=${String(item.pageid ?? '')}`,
        source: 'Wikipedia' as const,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);

  const minOverlapScore = terms.length >= 5 ? 6 : 3;
  const filtered = scored.filter((item) => item.score >= minOverlapScore);
  const finalRows = (filtered.length > 0 ? filtered : scored).slice(0, MAX_FINAL_RESULTS);

  return finalRows.map(({ title, snippet, url, source }) => ({
    title,
    snippet,
    url,
    source,
  }));
}

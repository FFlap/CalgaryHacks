import type { CorroborationItem } from '@/lib/types';

import { fetchJsonWithRetry } from '@/lib/verification/http';

const PUBMED_ESEARCH_API = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_ESUMMARY_API = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const PUBMED_RESULT_LIMIT = 5;
const PUBMED_FETCH_LIMIT = 20;

const PUBMED_QUALITY_TERMS = [
  'systematic review',
  'meta-analysis',
  'umbrella review',
  'cohort',
  'case-control',
  'randomized',
  'population-based',
  'nationwide',
  'consensus',
  'longitudinal',
];

const PUBMED_LOW_SIGNAL_TERMS = [
  'editorial',
  'comment',
  'letter',
  'case report',
  'protocol',
];

interface PubmedESearchResponse {
  esearchresult?: {
    idlist?: string[];
  };
}

interface PubmedESummaryResponse {
  result?: {
    uids?: string[];
    [key: string]: unknown;
  };
}

interface PubmedSummaryItem {
  title?: string;
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
}

interface RankedPaper {
  item: CorroborationItem;
  score: number;
  year: number;
  titleKey: string;
}

function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function tokenOverlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  return intersection / Math.max(1, Math.min(leftSet.size, rightSet.size));
}

function extractYear(value: string): number {
  const matches = value.match(/(?:19|20)\d{2}/g);
  if (!matches || matches.length === 0) return 0;
  const candidate = Number(matches[matches.length - 1]);
  if (!Number.isFinite(candidate)) return 0;
  return candidate;
}

function scorePubMedTitle(title: string, pubdate: string, query: string): number {
  const titleLower = title.toLowerCase();
  if (titleLower.includes('retracted')) {
    return -100;
  }

  let score = 0;
  for (const term of PUBMED_QUALITY_TERMS) {
    if (!titleLower.includes(term)) continue;
    if (term === 'systematic review' || term === 'meta-analysis' || term === 'umbrella review') {
      score += 8;
      continue;
    }
    score += 4;
  }

  for (const term of PUBMED_LOW_SIGNAL_TERMS) {
    if (titleLower.includes(term)) {
      score -= 5;
    }
  }

  const year = extractYear(pubdate);
  if (year >= 2020) score += 3;
  else if (year >= 2014) score += 2;
  else if (year >= 2005) score += 1;

  const overlap = tokenOverlap(normalizeTokens(title), normalizeTokens(query));
  if (overlap >= 0.8) {
    // Penalize near-echoes of the query text, which are often the same disputed paper.
    score -= 7;
  }

  return score;
}

function titleKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function searchPubMed(query: string): Promise<CorroborationItem[]> {
  const qualityFilteredQuery = `${query} NOT (editorial[Publication Type] OR comment[Publication Type] OR letter[Publication Type])`;
  const searchParams = new URLSearchParams({
    db: 'pubmed',
    term: qualityFilteredQuery,
    retmode: 'json',
    retmax: String(PUBMED_FETCH_LIMIT),
    sort: 'relevance',
  });

  const searchUrl = `${PUBMED_ESEARCH_API}?${searchParams.toString()}`;
  const searchJson = await fetchJsonWithRetry<PubmedESearchResponse>(searchUrl, {
    label: 'PubMed ESearch API',
    retries: 1,
  });

  const ids = Array.isArray(searchJson.esearchresult?.idlist)
    ? searchJson.esearchresult?.idlist ?? []
    : [];

  if (ids.length === 0) {
    return [];
  }

  const summaryParams = new URLSearchParams({
    db: 'pubmed',
    id: ids.join(','),
    retmode: 'json',
  });

  const summaryUrl = `${PUBMED_ESUMMARY_API}?${summaryParams.toString()}`;
  const summaryJson = await fetchJsonWithRetry<PubmedESummaryResponse>(summaryUrl, {
    label: 'PubMed ESummary API',
    retries: 1,
  });

  const result = summaryJson.result ?? {};
  const uids = Array.isArray(result.uids) ? result.uids : ids;

  const papers: CorroborationItem[] = [];
  const ranked: RankedPaper[] = [];

  for (const uid of uids) {
    const item = result[uid] as PubmedSummaryItem | undefined;
    if (!item?.title) {
      continue;
    }

    const journal = String(item.fulljournalname ?? item.source ?? 'PubMed').trim();
    const pubdate = String(item.pubdate ?? '').trim();
    const score = scorePubMedTitle(item.title, pubdate, query);
    if (score <= -80 || score < -1) {
      continue;
    }

    const row: CorroborationItem = {
      title: item.title,
      snippet: pubdate ? `${journal} (${pubdate})` : journal,
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      source: 'PubMed',
    };

    ranked.push({
      item: row,
      score,
      year: extractYear(pubdate),
      titleKey: titleKey(item.title),
    });
  }

  ranked.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return right.year - left.year;
  });

  const deduped = new Map<string, RankedPaper>();
  for (const candidate of ranked) {
    const existing = deduped.get(candidate.titleKey);
    if (!existing || candidate.score > existing.score) {
      deduped.set(candidate.titleKey, candidate);
    }
  }

  for (const candidate of deduped.values()) {
    papers.push(candidate.item);
    if (papers.length >= PUBMED_RESULT_LIMIT) {
      break;
    }
  }

  return papers;
}

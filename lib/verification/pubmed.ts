import type { CorroborationItem } from '@/lib/types';

import { fetchJsonWithRetry } from '@/lib/verification/http';

const PUBMED_ESEARCH_API = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_ESUMMARY_API = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';

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

export async function searchPubMed(query: string): Promise<CorroborationItem[]> {
  const searchParams = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmode: 'json',
    retmax: '5',
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

  for (const uid of uids) {
    const item = result[uid] as PubmedSummaryItem | undefined;
    if (!item?.title) {
      continue;
    }

    const journal = String(item.fulljournalname ?? item.source ?? 'PubMed').trim();
    const pubdate = String(item.pubdate ?? '').trim();

    papers.push({
      title: item.title,
      snippet: pubdate ? `${journal} (${pubdate})` : journal,
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      source: 'PubMed',
    });

    if (papers.length >= 5) {
      break;
    }
  }

  return papers;
}

import type { CorroborationItem } from '@/lib/types';

import { fetchJsonWithRetry } from '@/lib/verification/http';

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

interface WikidataResponse {
  search?: Array<{
    id?: string;
    label?: string;
    description?: string;
    concepturi?: string;
  }>;
}

export async function searchWikidata(query: string): Promise<CorroborationItem[]> {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: query,
    language: 'en',
    format: 'json',
    limit: '5',
  });

  const url = `${WIKIDATA_API}?${params.toString()}`;
  const json = await fetchJsonWithRetry<WikidataResponse>(url, {
    label: 'Wikidata API',
    retries: 1,
  });

  const results = Array.isArray(json.search) ? json.search : [];

  return results.slice(0, 5).map((item) => ({
    title: String(item.label ?? item.id ?? 'Wikidata entity').trim(),
    snippet: String(item.description ?? '').trim(),
    url: String(item.concepturi ?? '').trim() || `https://www.wikidata.org/wiki/${String(item.id ?? '')}`,
    source: 'Wikidata',
  }));
}

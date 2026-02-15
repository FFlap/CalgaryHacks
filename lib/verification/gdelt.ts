import type { GdeltArticle } from '@/lib/types';

import { extractSearchKeywords } from '@/lib/verification/query';

const GDELT_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MAX_RESULTS = 5;
const GDELT_MIN_INTERVAL_MS = 5_200;
const GDELT_TIMEOUT_MS = 20_000;

const TRUSTED_DOMAINS = [
  'snopes.com',
  'politifact.com',
  'factcheck.org',
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'fullfact.org',
  'leadstories.com',
  'washingtonpost.com',
  'nytimes.com',
  'npr.org',
  'pbs.org',
  'who.int',
  'cdc.gov',
  'nature.com',
  'sciencemag.org',
];

interface GdeltResponse {
  articles?: Array<{
    title?: string;
    url?: string;
    domain?: string;
    seendate?: string;
    tone?: string | number;
    language?: string;
  }>;
}

let lastGdeltRequestAt = 0;
let gdeltQueue: Promise<void> = Promise.resolve();

function buildGdeltUrl(query: string): string {
  const params = new URLSearchParams({
    query,
    mode: 'ArtList',
    format: 'json',
    maxrecords: '30',
    timespan: '3m',
    sort: 'ToneDesc',
  });
  return `${GDELT_API}?${params.toString()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queueGdeltRequest<T>(work: () => Promise<T>): Promise<T> {
  const run = gdeltQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, GDELT_MIN_INTERVAL_MS - (now - lastGdeltRequestAt));
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastGdeltRequestAt = Date.now();
    return work();
  });

  gdeltQueue = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}

async function fetchGdeltJson(url: string): Promise<GdeltResponse | null> {
  return queueGdeltRequest(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GDELT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (response.status === 429) {
        return null;
      }

      if (!response.ok) {
        return null;
      }

      const text = await response.text();
      if (!text.trim()) {
        return null;
      }

      try {
        return JSON.parse(text) as GdeltResponse;
      } catch {
        return null;
      }
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}

function normalizeTone(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function mapArticles(response: GdeltResponse): GdeltArticle[] {
  const raw = Array.isArray(response.articles) ? response.articles : [];
  const unique: GdeltArticle[] = [];
  const seen = new Set<string>();

  for (const article of raw) {
    const url = String(article.url ?? '').trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);

    let domain = String(article.domain ?? '').trim();
    if (!domain) {
      try {
        domain = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        domain = 'unknown';
      }
    }

    unique.push({
      title: String(article.title ?? 'Related article').trim() || 'Related article',
      url,
      domain,
      tone: normalizeTone(article.tone),
      seenDate: String(article.seendate ?? '').trim() || undefined,
      language: String(article.language ?? '').trim() || undefined,
    });

    if (unique.length >= MAX_RESULTS) {
      break;
    }
  }

  return unique;
}

export async function searchGdeltArticles(query: string): Promise<GdeltArticle[]> {
  const keywords = extractSearchKeywords(query);
  const trustedDomainFilter = TRUSTED_DOMAINS.map((domain) => `domainis:${domain}`).join(' OR ');

  const primaryQuery = `${keywords} (${trustedDomainFilter})`;
  const primaryUrl = buildGdeltUrl(primaryQuery);
  const primaryResponse = await fetchGdeltJson(primaryUrl);
  if (!primaryResponse) {
    return [];
  }

  const primaryArticles = mapArticles(primaryResponse);
  if (primaryArticles.length > 0) {
    return primaryArticles;
  }

  const fallbackUrl = buildGdeltUrl(keywords);
  const fallbackResponse = await fetchGdeltJson(fallbackUrl);
  if (!fallbackResponse) {
    return [];
  }

  return mapArticles(fallbackResponse);
}

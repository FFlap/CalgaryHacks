import type { Finding, PageContext } from '@/lib/types';

export interface EvidenceQueryPack {
  primary: string;
  factCheckQueries: string[];
  wikipediaQueries: string[];
  wikidataQueries: string[];
  pubmedQueries: string[];
  gdeltQueries: string[];
  topicTerms: string[];
  entityTerms: string[];
  intent: 'misinformation' | 'argumentation';
}

const TERM_STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'that',
  'this',
  'these',
  'those',
  'and',
  'or',
  'if',
  'but',
  'about',
  'according',
  'claims',
  'claim',
  'reported',
  'reports',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'podcast',
  'video',
  'article',
  'statement',
  'said',
  'says',
  'stated',
  'argued',
  'denied',
  'showed',
  'shown',
  'couldnt',
  'cant',
]);

const ENTITY_NOISE = new Set([
  'The',
  'A',
  'An',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'President',
  'Comedian',
  'Senator',
  'Governor',
  'Representative',
  'Mr',
  'Mrs',
  'Ms',
  'Dr',
]);

function cleanText(value: string): string {
  return value.replace(/[“”"'`]+/g, '').replace(/\s+/g, ' ').trim();
}

function trimWords(value: string, maxWords: number): string {
  const words = cleanText(value).split(' ').filter(Boolean);
  return words.slice(0, maxWords).join(' ');
}

function uniqueStrings(values: string[]): string[] {
  const rows = values
    .map((value) => cleanText(value))
    .filter((value) => value.length >= 4);
  return Array.from(new Set(rows));
}

function uniqueTokens(values: string[], maxItems: number): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length >= 2),
    ),
  ).slice(0, maxItems);
}

function extractEntities(text: string): string[] {
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) ?? [];
  const cleaned: string[] = [];

  for (const candidate of matches) {
    const parts = candidate.split(' ').filter(Boolean);
    const filteredParts = parts.filter((part) => !ENTITY_NOISE.has(part));
    if (filteredParts.length === 0) continue;

    const entity = filteredParts.join(' ').trim();
    if (entity.length < 3) continue;
    cleaned.push(entity);
  }

  return Array.from(new Set(cleaned)).slice(0, 4);
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '').trim();
}

function extractTopicTerms(text: string, entities: string[]): string[] {
  const entityParts = new Set(
    entities
      .flatMap((entity) => entity.split(' '))
      .map((part) => normalizeToken(part))
      .filter(Boolean),
  );

  const terms = cleanText(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
    .filter((token) => !TERM_STOP_WORDS.has(token))
    .filter((token) => !entityParts.has(token));

  return Array.from(new Set(terms)).slice(0, 10);
}

function deriveCoreClaim(quote: string, correction: string | undefined, entities: string[]): string {
  let source = cleanText(correction || quote);

  const lower = source.toLowerCase();
  const thatIndex = lower.indexOf(' that ');
  if (thatIndex > 0) {
    const prefix = lower.slice(0, thatIndex);
    if (/(said|says|claimed|stated|argued|insisted|told|wrote|announced|reported)/.test(prefix)) {
      source = source.slice(thatIndex + 6).trim();
    }
  }

  source = source
    .replace(/^according to\s+[^,]+,\s*/i, '')
    .replace(/^on\s+[^,]+,\s*/i, '')
    .replace(/^in\s+[^,]+,\s*/i, '')
    .replace(/,\s*(even if|although|though|while)\b[\s\S]*$/i, '')
    .trim();

  if (/^(he|she|they|it)\b/i.test(source) && entities.length > 0) {
    source = source.replace(/^(he|she|they|it)\b/i, entities[0]);
  }

  return trimWords(source || quote, 22);
}

function takeCorrectionSnippet(correction?: string): string {
  if (!correction) return '';
  return trimWords(correction, 18);
}

export function buildFindingQuery(finding: Pick<Finding, 'quote' | 'correction'>): string {
  const quote = cleanText(finding.quote);
  const correction = takeCorrectionSnippet(finding.correction);

  if (!correction) {
    return quote;
  }

  return `${quote} ${correction}`.trim();
}

export function extractSearchKeywords(value: string): string {
  const words = cleanText(value)
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !TERM_STOP_WORDS.has(word.toLowerCase()));

  if (words.length === 0) {
    return cleanText(value).split(/\s+/).slice(0, 6).join(' ');
  }

  return words.slice(0, 10).join(' ');
}

export function buildEvidenceQueryPack(
  finding: Pick<Finding, 'quote' | 'correction' | 'rationale' | 'issueTypes'>,
  pageContext?: PageContext,
): EvidenceQueryPack {
  const quote = cleanText(finding.quote);
  const correction = finding.correction ? cleanText(finding.correction) : undefined;
  const rationale = cleanText(finding.rationale || '');

  const contextTopics = (pageContext?.topicKeywords ?? []).map((item) => item.toLowerCase());
  const contextEntities = pageContext?.entityKeywords ?? [];

  const entities = uniqueTokens(
    [...extractEntities(`${quote} ${correction ?? ''}`), ...contextEntities],
    6,
  );
  const topicTerms = uniqueTokens(
    [...extractTopicTerms(`${quote} ${correction ?? ''} ${rationale}`, entities), ...contextTopics],
    12,
  );

  const coreClaim = deriveCoreClaim(quote, correction, entities);

  const entityPhrase = entities.slice(0, 2).join(' ');
  const topicPhrase = topicTerms.slice(0, 6).join(' ');
  const compactClaim = [entityPhrase, topicPhrase].filter(Boolean).join(' ').trim() || coreClaim;
  const contextSummary = pageContext?.summary ? trimWords(pageContext.summary, 20) : '';
  const contextTopicPhrase = contextTopics.slice(0, 5).join(' ').trim();
  const contextEntityPhrase = contextEntities.slice(0, 2).join(' ').trim();

  const intent: EvidenceQueryPack['intent'] = finding.issueTypes.includes('misinformation')
    ? 'misinformation'
    : 'argumentation';

  const factCheckQueries = uniqueStrings([
    coreClaim,
    compactClaim,
    contextTopicPhrase,
    contextSummary ? `${compactClaim} ${contextSummary}` : '',
    contextSummary,
    intent === 'misinformation'
      ? `${compactClaim} fact check false misleading`
      : `${compactClaim} claim context explained`,
    intent === 'misinformation'
      ? `${topicTerms.slice(0, 4).join(' ')} fact check`
      : `${topicTerms.slice(0, 4).join(' ')} analysis`,
  ]);

  const wikipediaQueries = uniqueStrings([
    [topicTerms.slice(0, 5).join(' '), entities[0] ?? ''].join(' ').trim(),
    contextTopicPhrase,
    contextEntityPhrase ? `${contextEntityPhrase} ${contextTopicPhrase}` : '',
    contextSummary ? `${topicTerms.slice(0, 4).join(' ')} ${contextSummary}` : '',
    contextSummary,
    compactClaim,
    coreClaim,
  ]);

  const wikidataQueries = uniqueStrings([
    compactClaim,
    contextTopicPhrase,
    contextEntityPhrase ? `${contextEntityPhrase} ${contextTopicPhrase}` : '',
    contextSummary ? `${entities.slice(0, 2).join(' ')} ${contextSummary}` : '',
    contextSummary,
    coreClaim,
    topicTerms.slice(0, 4).join(' '),
  ]);

  const pubmedQueries = uniqueStrings([
    topicTerms.slice(0, 6).join(' '),
    contextTopicPhrase,
    contextSummary ? `${topicTerms.slice(0, 4).join(' ')} ${contextSummary}` : '',
    contextSummary,
    compactClaim,
  ]);

  const gdeltQueries = uniqueStrings([
    intent === 'misinformation'
      ? `${compactClaim} fact check debunked analysis`
      : `${compactClaim} analysis criticism context`,
    contextTopicPhrase ? `${contextTopicPhrase} analysis` : '',
    contextEntityPhrase ? `${contextEntityPhrase} ${contextTopicPhrase} analysis` : '',
    contextSummary ? `${topicTerms.slice(0, 5).join(' ')} ${contextSummary}` : '',
    contextSummary,
    compactClaim,
    topicTerms.slice(0, 6).join(' '),
  ]);

  return {
    primary: compactClaim,
    factCheckQueries: factCheckQueries.length > 0 ? factCheckQueries : [coreClaim],
    wikipediaQueries: wikipediaQueries.length > 0 ? wikipediaQueries : [coreClaim],
    wikidataQueries: wikidataQueries.length > 0 ? wikidataQueries : [coreClaim],
    pubmedQueries: pubmedQueries.length > 0 ? pubmedQueries : [coreClaim],
    gdeltQueries: gdeltQueries.length > 0 ? gdeltQueries : [coreClaim],
    topicTerms,
    entityTerms: entities,
    intent,
  };
}

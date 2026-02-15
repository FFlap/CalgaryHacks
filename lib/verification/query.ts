import type { Finding } from '@/lib/types';

function cleanText(value: string): string {
  return value.replace(/[“”"'`]+/g, '').replace(/\s+/g, ' ').trim();
}

function takeCorrectionSnippet(correction?: string): string {
  if (!correction) return '';
  const cleaned = cleanText(correction);
  if (!cleaned) return '';
  const words = cleaned.split(' ');
  if (words.length <= 18) return cleaned;
  return words.slice(0, 18).join(' ');
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
  const stopWords = new Set([
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
  ]);

  const words = cleanText(value)
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word.toLowerCase()));

  if (words.length === 0) {
    return cleanText(value).split(/\s+/).slice(0, 6).join(' ');
  }

  return words.slice(0, 10).join(' ');
}

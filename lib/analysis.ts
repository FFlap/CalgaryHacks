import { callOpenRouterJson } from '@/lib/openrouter';
import type {
  CandidateClaim,
  Finding,
  IssueType,
  RawFinding,
  ScanReport,
  ScanSummary,
} from '@/lib/types';

const MISINFORMATION_THRESHOLD = 0.78;
const ARGUMENT_THRESHOLD = 0.58;

const FALLACY_SUBTYPES = new Set([
  'straw man',
  'ad hominem',
  'false dilemma',
  'hasty generalization',
  'slippery slope',
  'appeal to fear',
]);

const BIAS_SUBTYPES = new Set([
  'loaded language',
  'cherry picking',
  'framing bias',
  'confirmation framed rhetoric',
]);

const ALLOWED_ISSUE_TYPES = new Set<IssueType>(['misinformation', 'fallacy', 'bias']);
const AFFIRMING_PATTERNS = [
  /\baccurate\b/,
  /\btrue\b/,
  /\bcorrect\b/,
  /\bfactual\b/,
  /\bconfirmed\b/,
  /\bdid happen\b/,
  /\bis accurate\b/,
  /\bis true\b/,
];
const MISINFORMATION_PATTERNS = [
  /\bfalse\b/,
  /\binaccurate\b/,
  /\bmisleading\b/,
  /\bdebunked\b/,
  /\bfabricated\b/,
  /\bhoax\b/,
  /\bunfounded\b/,
  /\bunsupported\b/,
  /\bnot true\b/,
  /\bno evidence\b/,
  /\bwithout evidence\b/,
  /\blacks evidence\b/,
  /\bout of context\b/,
];
const FALLACY_PATTERNS: Record<string, RegExp[]> = {
  'ad hominem': [/\bad hominem\b/, /\bname[- ]calling\b/, /\bcharacter attack\b/, /\binsult\b/],
  'appeal to fear': [/\bappeal to fear\b/, /\bfear\b/, /\bpanic\b/, /\bthreat\b/, /\bchaos\b/],
  'false dilemma': [/\bfalse dilemma\b/, /\beither\b.+\bor\b/, /\bonly choice\b/, /\bno alternative\b/],
  'hasty generalization': [/\bhasty generalization\b/, /\beveryone\b/, /\balways\b/, /\bnever\b/, /\ball\b.+\b(are|is)\b/],
  'slippery slope': [/\bslippery slope\b/, /\blead(s)? to\b.+\b(inevitably|always)\b/, /\broad-testing tactics\b/],
  'straw man': [/\bstraw man\b/, /\bmisrepresent(s|ed|ing)?\b/, /\bcaricature\b/],
};
const BIAS_PATTERNS: Record<string, RegExp[]> = {
  'loaded language': [
    /\bloaded language\b/,
    /\bauthoritarian\b/,
    /\bshameless\b/,
    /\bbad man\b/,
    /\bhenchmen\b/,
    /\bstorm troopers\b/,
    /\bconfederates\b/,
    /\bcowed\b/,
    /\bcomplicit\b/,
    /\bcorrupt(?:ed|ion)?\b/,
  ],
  'cherry picking': [/\bcherry picking\b/, /\bselective\b/, /\bone-sided\b/, /\bonly cites\b/],
  'framing bias': [/\bframing bias\b/, /\bframe(?:d|s|ing)?\b/, /\bnarrative\b/, /\bperformative\b/],
  'confirmation framed rhetoric': [/\bconfirmation\b/, /\bpreexisting\b/, /\benabler(s)?\b/, /\bpartisan\b/],
};
const HEURISTIC_MAX_FINDINGS = 8;
const HEURISTIC_LOADED_LANGUAGE_TERMS = [
  'bad man',
  'storm troopers',
  'henchmen',
  'authoritarian',
  'authoritarianism',
  'shameless',
  'complicit',
  'confederates',
  'corrupt',
  'corruption',
  'sabotage',
  'betrayal',
  'fascistic',
  'cowed',
  'lawbreaking',
  'minions',
];
const HEURISTIC_APPEAL_TO_FEAR_TERMS = [
  'chaos',
  'threaten',
  'seizing protesters',
  'remain in power',
  'road-testing tactics',
  'violence',
  'paramilitary',
  'repress the vote',
  'undermine the election',
  'unconstitutional use of force',
];

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeComparableText(input: string): string {
  return normalizeText(input)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSubtype(input?: string): string {
  return (input ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlap(left: string, right: string): { leftCoverage: number; rightCoverage: number } {
  const leftTokens = Array.from(new Set(normalizeComparableText(left).split(' ').filter((token) => token.length > 2)));
  const rightTokens = Array.from(new Set(normalizeComparableText(right).split(' ').filter((token) => token.length > 2)));

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return { leftCoverage: 0, rightCoverage: 0 };
  }

  const rightSet = new Set(rightTokens);
  const overlapCount = leftTokens.reduce((count, token) => count + (rightSet.has(token) ? 1 : 0), 0);

  const leftCoverage = overlapCount / leftTokens.length;
  const rightCoverage = overlapCount / rightTokens.length;

  return { leftCoverage, rightCoverage };
}

function isNearDuplicate(left: string, right?: string): boolean {
  if (!right) {
    return false;
  }

  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);
  if (!a || !b) {
    return false;
  }

  if (a === b || a.includes(b) || b.includes(a)) {
    return true;
  }

  const overlap = tokenOverlap(a, b);
  return overlap.leftCoverage >= 0.82 && overlap.rightCoverage >= 0.82;
}

function hasPattern(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function containsAnyTerm(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function splitIntoCandidateSentences(text: string): string[] {
  const sentences: string[] = [];
  const blocks = text
    .split(/\n+/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter((block) => block.length >= 20);

  for (const block of blocks) {
    const parts = block.split(/(?<=[.!?])\s+/);
    for (const part of parts) {
      const sentence = part.trim();
      if (sentence.length < 24 || sentence.length > 240) {
        continue;
      }
      sentences.push(sentence);
    }
  }

  return sentences;
}

function buildHeuristicRawFindings(text: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const seenQuotes = new Set<string>();
  const sentences = splitIntoCandidateSentences(text);

  for (const sentence of sentences) {
    const normalizedSentence = normalizeText(sentence);
    if (seenQuotes.has(normalizedSentence)) {
      continue;
    }

    if (containsAnyTerm(normalizedSentence, HEURISTIC_LOADED_LANGUAGE_TERMS)) {
      findings.push({
        quote: sentence,
        issueTypes: ['bias'],
        subtype: 'loaded language',
        confidence: 0.64,
        severity: 2,
        rationale:
          'Uses emotionally charged wording and character-framing terms instead of neutral phrasing.',
      });
      seenQuotes.add(normalizedSentence);
    } else if (containsAnyTerm(normalizedSentence, HEURISTIC_APPEAL_TO_FEAR_TERMS)) {
      findings.push({
        quote: sentence,
        issueTypes: ['fallacy'],
        subtype: 'appeal to fear',
        confidence: 0.62,
        severity: 2,
        rationale:
          'Leans on threat and chaos framing to persuade through fear-heavy consequences.',
      });
      seenQuotes.add(normalizedSentence);
    }

    if (findings.length >= HEURISTIC_MAX_FINDINGS) {
      break;
    }
  }

  return findings;
}

function quoteAppearsOnPage(
  quote: string,
  normalizedPageText: string,
  normalizedPageComparable: string,
): boolean {
  const normalizedQuote = normalizeText(quote);
  if (normalizedQuote.length < 16) {
    return false;
  }

  if (normalizedPageText.includes(normalizedQuote)) {
    return true;
  }

  const comparableQuote = normalizeComparableText(quote);
  if (!comparableQuote) {
    return false;
  }

  if (normalizedPageComparable.includes(comparableQuote)) {
    return true;
  }

  const overlap = tokenOverlap(comparableQuote, normalizedPageComparable);
  return overlap.leftCoverage >= 0.9;
}

function hasValidMisinformationSignals(rawFinding: RawFinding): boolean {
  if (rawFinding.confidence < MISINFORMATION_THRESHOLD) {
    return false;
  }
  if (!rawFinding.correction || rawFinding.correction.length < 12) {
    return false;
  }

  if (isNearDuplicate(rawFinding.quote, rawFinding.correction)) {
    return false;
  }

  const reasoningText = normalizeText(`${rawFinding.rationale} ${rawFinding.correction}`);
  const affirmsQuote = hasPattern(AFFIRMING_PATTERNS, reasoningText);
  const disputesQuote = hasPattern(MISINFORMATION_PATTERNS, reasoningText);

  if (affirmsQuote && !disputesQuote) {
    return false;
  }

  if (!disputesQuote) {
    return false;
  }

  return true;
}

function inferSubtypeForIssue(
  issue: 'fallacy' | 'bias',
  rawSubtype: string | undefined,
  rationale: string,
  quote: string,
): string | undefined {
  const normalizedRawSubtype = normalizeSubtype(rawSubtype);
  if (issue === 'fallacy' && FALLACY_SUBTYPES.has(normalizedRawSubtype)) {
    return normalizedRawSubtype;
  }
  if (issue === 'bias' && BIAS_SUBTYPES.has(normalizedRawSubtype)) {
    return normalizedRawSubtype;
  }

  const haystack = normalizeText(`${rawSubtype ?? ''} ${rationale} ${quote}`);
  const patterns = issue === 'fallacy' ? FALLACY_PATTERNS : BIAS_PATTERNS;

  for (const [subtype, checks] of Object.entries(patterns)) {
    if (checks.some((pattern) => pattern.test(haystack))) {
      return subtype;
    }
  }

  return issue === 'bias' ? 'loaded language' : 'hasty generalization';
}

function sanitizeRawFinding(
  rawFinding: RawFinding,
  normalizedPageText: string,
  normalizedPageComparable: string,
): RawFinding | null {
  if (!quoteAppearsOnPage(rawFinding.quote, normalizedPageText, normalizedPageComparable)) {
    return null;
  }

  if (!rawFinding.rationale || rawFinding.rationale.length < 16) {
    return null;
  }

  const sanitized: RawFinding = {
    ...rawFinding,
    issueTypes: [...rawFinding.issueTypes],
  };

  if (sanitized.issueTypes.includes('misinformation')) {
    const validMisinformation = hasValidMisinformationSignals(sanitized);
    if (!validMisinformation) {
      sanitized.issueTypes = sanitized.issueTypes.filter((issue) => issue !== 'misinformation');
      sanitized.correction = undefined;
    }
  }

  if (sanitized.issueTypes.length === 0) {
    return null;
  }

  if (sanitized.confidence < ARGUMENT_THRESHOLD) {
    sanitized.issueTypes = sanitized.issueTypes.filter((issue) => issue === 'misinformation');
  }

  const hasFallacy = sanitized.issueTypes.includes('fallacy');
  const hasBias = sanitized.issueTypes.includes('bias');
  if (hasFallacy && hasBias) {
    // Keep one argument class because each finding supports a single subtype field.
    sanitized.issueTypes = sanitized.issueTypes.filter((issue) => issue !== 'fallacy');
  }

  if (sanitized.issueTypes.includes('fallacy')) {
    const subtype = inferSubtypeForIssue(
      'fallacy',
      sanitized.subtype,
      sanitized.rationale,
      sanitized.quote,
    );
    if (!subtype || !FALLACY_SUBTYPES.has(subtype)) {
      sanitized.issueTypes = sanitized.issueTypes.filter((issue) => issue !== 'fallacy');
    } else {
      sanitized.subtype = subtype;
    }
  }

  if (sanitized.issueTypes.includes('bias')) {
    const subtype = inferSubtypeForIssue(
      'bias',
      sanitized.subtype,
      sanitized.rationale,
      sanitized.quote,
    );
    if (!subtype || !BIAS_SUBTYPES.has(subtype)) {
      sanitized.issueTypes = sanitized.issueTypes.filter((issue) => issue !== 'bias');
    } else {
      sanitized.subtype = subtype;
    }
  }

  if (sanitized.issueTypes.length === 0) {
    return null;
  }

  return sanitized;
}

function toIssueTypes(value: unknown): IssueType[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item).toLowerCase().trim())
    .filter((item): item is IssueType => ALLOWED_ISSUE_TYPES.has(item as IssueType));
}

function toSeverity(value: unknown): number {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) {
    return 3;
  }
  return Math.max(1, Math.min(5, Math.round(asNumber)));
}

function toConfidence(value: unknown): number {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) {
    return 0;
  }
  return Math.max(0, Math.min(1, asNumber));
}

function buildCandidatePrompt(url: string, title: string, content: string): string {
  return [
    'You are a strict but critical claim miner focused on misinformation, fallacies, and bias.',
    'Extract concise, direct quotes from the page that could be problematic or manipulative.',
    'For opinion writing, aggressively capture loaded rhetoric and character attacks as bias/fallacy candidates.',
    'Do not summarize the page.',
    'Return valid JSON with this shape only:',
    '{"candidates":[{"quote":"string","issueHints":["misinformation"|"fallacy"|"bias"],"subtypeHint":"string optional","reason":"string optional"}]}',
    'Rules:',
    '- Keep each quote under 260 characters.',
    '- Return at most 24 candidates.',
    '- Prefer recall over precision at this stage.',
    '- Include medium-strength concerns; do not require certain falsity for bias/fallacy.',
    '- issueHints can include multiple values.',
    `URL: ${url}`,
    `TITLE: ${title}`,
    'PAGE_TEXT_START',
    content,
    'PAGE_TEXT_END',
  ].join('\n');
}

function buildVerificationPrompt(
  url: string,
  title: string,
  candidates: CandidateClaim[],
): string {
  return [
    'You are a critical credibility analyst.',
    'Evaluate each quote for misinformation, logical fallacy, and rhetorical bias.',
    'For misinformation: include only if highly likely false or misleading.',
    'For fallacy and bias: use quote-grounded reasoning and allow strong rhetorical indicators.',
    'Approved fallacy subtypes: straw man, ad hominem, false dilemma, hasty generalization, slippery slope, appeal to fear.',
    'Approved bias subtypes: loaded language, cherry picking, framing bias, confirmation framed rhetoric.',
    'Return strict JSON with shape:',
    '{"findings":[{"quote":"string","issueTypes":["misinformation"|"fallacy"|"bias"],"subtype":"string optional","confidence":0.0,"severity":1,"rationale":"string","correction":"string optional"}]}',
    'Rules:',
    '- Output medium-to-high confidence items.',
    '- For misinformation include correction.',
    '- Never label accurate/supported statements as misinformation.',
    '- If your rationale says a quote is accurate/true/correct, omit it from findings.',
    '- A correction must materially differ from the quote and explain why the quote is false/misleading.',
    '- Never echo or paraphrase the same claim as the correction.',
    '- If a quote is not supportable as problematic, omit it.',
    `URL: ${url}`,
    `TITLE: ${title}`,
    `CANDIDATES_JSON: ${JSON.stringify(candidates)}`,
  ].join('\n');
}

function coerceCandidates(payload: unknown): CandidateClaim[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const rawCandidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(rawCandidates)) {
    return [];
  }

  const candidates: CandidateClaim[] = [];
  for (const item of rawCandidates) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const quote = String((item as { quote?: unknown }).quote ?? '').trim();
    if (quote.length < 16) {
      continue;
    }
    const issueHints = toIssueTypes((item as { issueHints?: unknown }).issueHints);
    if (issueHints.length === 0) {
      continue;
    }
    candidates.push({
      quote,
      issueHints,
      subtypeHint:
        String((item as { subtypeHint?: unknown }).subtypeHint ?? '').trim() || undefined,
      reason: String((item as { reason?: unknown }).reason ?? '').trim() || undefined,
    });
    if (candidates.length >= 24) {
      break;
    }
  }
  return candidates;
}

function coerceRawFindings(payload: unknown): RawFinding[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const findings = (payload as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) {
    return [];
  }

  const normalized: RawFinding[] = [];
  for (const item of findings) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const quote = String((item as { quote?: unknown }).quote ?? '').trim();
    const issueTypes = toIssueTypes((item as { issueTypes?: unknown }).issueTypes);
    if (!quote || issueTypes.length === 0) {
      continue;
    }

    normalized.push({
      quote,
      issueTypes,
      subtype: String((item as { subtype?: unknown }).subtype ?? '').trim() || undefined,
      confidence: toConfidence((item as { confidence?: unknown }).confidence),
      severity: toSeverity((item as { severity?: unknown }).severity),
      rationale: String((item as { rationale?: unknown }).rationale ?? '').trim(),
      correction: String((item as { correction?: unknown }).correction ?? '').trim() || undefined,
    });
  }
  return normalized;
}

function mergeFindings(rawFindings: RawFinding[]): Finding[] {
  const merged = new Map<string, Finding>();

  for (const rawFinding of rawFindings) {
    const key = normalizeText(rawFinding.quote);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        id: crypto.randomUUID(),
        quote: rawFinding.quote,
        issueTypes: [...rawFinding.issueTypes],
        subtype: rawFinding.subtype,
        confidence: rawFinding.confidence,
        severity: rawFinding.severity,
        rationale: rawFinding.rationale,
        correction: rawFinding.correction,
      });
      continue;
    }

    existing.issueTypes = Array.from(new Set([...existing.issueTypes, ...rawFinding.issueTypes]));
    existing.confidence = Math.max(existing.confidence, rawFinding.confidence);
    existing.severity = Math.max(existing.severity, rawFinding.severity);

    if (!existing.subtype && rawFinding.subtype) {
      existing.subtype = rawFinding.subtype;
    }
    if ((!existing.correction || existing.correction.length < 12) && rawFinding.correction) {
      existing.correction = rawFinding.correction;
    }
    if (rawFinding.rationale.length > existing.rationale.length) {
      existing.rationale = rawFinding.rationale;
    }
  }

  return [...merged.values()].sort((left, right) => {
    if (left.severity !== right.severity) {
      return right.severity - left.severity;
    }
    return right.confidence - left.confidence;
  });
}

function buildSummary(findings: Finding[]): ScanSummary {
  let misinformationCount = 0;
  let fallacyCount = 0;
  let biasCount = 0;

  for (const finding of findings) {
    if (finding.issueTypes.includes('misinformation')) misinformationCount += 1;
    if (finding.issueTypes.includes('fallacy')) fallacyCount += 1;
    if (finding.issueTypes.includes('bias')) biasCount += 1;
  }

  return {
    totalFindings: findings.length,
    misinformationCount,
    fallacyCount,
    biasCount,
  };
}

export async function analyzeClaims(options: {
  apiKey: string;
  tabId: number;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  analyzedChars: number;
}): Promise<ScanReport> {
  const { apiKey, tabId, url, title, text, truncated, analyzedChars } = options;
  const normalizedPageText = normalizeText(text);
  const normalizedPageComparable = normalizeComparableText(text);

  const candidatePrompt = buildCandidatePrompt(url, title, text);
  const candidateResponse = await callOpenRouterJson<{ candidates?: unknown }>({
    apiKey,
    prompt: candidatePrompt,
  });
  const candidates = coerceCandidates(candidateResponse);
  let rawFindings: RawFinding[] = [];
  if (candidates.length > 0) {
    const verificationPrompt = buildVerificationPrompt(url, title, candidates);
    const verificationResponse = await callOpenRouterJson<{ findings?: unknown }>({
      apiKey,
      prompt: verificationPrompt,
    });
    rawFindings = coerceRawFindings(verificationResponse);
  }

  const filtered: RawFinding[] = [];
  for (const finding of rawFindings) {
    const sanitized = sanitizeRawFinding(finding, normalizedPageText, normalizedPageComparable);
    if (sanitized) {
      filtered.push(sanitized);
    }
  }
  let findings = mergeFindings(filtered);

  if (findings.length === 0) {
    const heuristicRawFindings = buildHeuristicRawFindings(text);
    const heuristicFiltered: RawFinding[] = [];
    for (const finding of heuristicRawFindings) {
      const sanitized = sanitizeRawFinding(finding, normalizedPageText, normalizedPageComparable);
      if (sanitized) {
        heuristicFiltered.push(sanitized);
      }
    }
    findings = mergeFindings(heuristicFiltered);
  }

  return {
    tabId,
    url,
    title,
    scannedAt: new Date().toISOString(),
    summary: buildSummary(findings),
    findings,
    truncated,
    analyzedChars,
  };
}

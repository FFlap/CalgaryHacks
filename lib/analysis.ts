import { callOpenRouterJson } from '@/lib/openrouter';
import type {
  CandidateClaim,
  Finding,
  IssueType,
  RawFinding,
  ScanReport,
  ScanSummary,
  TranscriptSegment,
} from '@/lib/types';
import { nearestSegmentForTimestampLabel } from '@/lib/youtube-transcript';

const MISINFORMATION_THRESHOLD = 0.6;
const ARGUMENT_THRESHOLD = 0.5;
const YOUTUBE_MISINFORMATION_THRESHOLD = 0.45;
const YOUTUBE_ARGUMENT_THRESHOLD = 0.35;
const MAX_TRANSCRIPT_PROMPT_SEGMENTS = 520;

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
const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(input: string): string {
  let value = input;
  for (let round = 0; round < 3; round += 1) {
    const next = value
      .replace(/&(amp|lt|gt|quot|apos|#39);/gi, (entity) => HTML_ENTITY_MAP[entity.toLowerCase()] ?? entity)
      .replace(/&#(\d+);/g, (_, codeText) => {
        const code = Number(codeText);
        if (!Number.isFinite(code)) return _;
        try {
          return String.fromCodePoint(code);
        } catch {
          return _;
        }
      });
    if (next === value) break;
    value = next;
  }
  return value;
}

function stripWrappingQuotes(input: string): string {
  let value = input.trim();
  for (let i = 0; i < 2; i += 1) {
    const next = value
      .replace(/^[\s"'`“”‘’]+/, '')
      .replace(/[\s"'`“”‘’]+$/, '')
      .trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

function normalizeQuoteText(input: string): string {
  return stripWrappingQuotes(decodeHtmlEntities(input).replace(/\s+/g, ' '));
}

function normalizeSubtype(input?: string): string {
  return (input ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalizeSubtype(input?: string): string | undefined {
  const subtype = normalizeSubtype(input);
  if (!subtype) return undefined;

  const mappings = new Map<string, string>([
    ['false dichotomy', 'false dilemma'],
    ['either or fallacy', 'false dilemma'],
    ['hasty conclusion', 'hasty generalization'],
    ['slippery slope argument', 'slippery slope'],
    ['fear appeal', 'appeal to fear'],
    ['appeal to emotion', 'appeal to fear'],
    ['loaded wording', 'loaded language'],
    ['emotive language', 'loaded language'],
    ['selection bias', 'cherry picking'],
    ['framing', 'framing bias'],
    ['confirmation bias', 'confirmation framed rhetoric'],
  ]);

  return mappings.get(subtype) ?? subtype;
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

function toTimestampLabel(value: unknown): string | undefined {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!normalized) {
    return undefined;
  }
  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function buildTranscriptContext(segments: TranscriptSegment[]): string {
  return segments
    .slice(0, MAX_TRANSCRIPT_PROMPT_SEGMENTS)
    .map((segment) => `[${segment.startLabel}] ${segment.text}`)
    .join('\n');
}

function buildCandidatePrompt(options: {
  url: string;
  title: string;
  content: string;
  transcriptSegments?: TranscriptSegment[];
}): string {
  const { url, title, content, transcriptSegments } = options;
  const isYouTube = (transcriptSegments?.length ?? 0) > 0;

  return [
    'You are a sensitivity-first claim miner focused on misinformation, fallacies, and bias.',
    'Extract concise, direct quotes from the page that are potentially problematic.',
    'Do not summarize the page.',
    'Return valid JSON with this shape only:',
    isYouTube
      ? '{"candidates":[{"quote":"string","timestampLabel":"m:ss or h:mm:ss optional","issueHints":["misinformation"|"fallacy"|"bias"],"subtypeHint":"string optional","reason":"string optional"}]}'
      : '{"candidates":[{"quote":"string","issueHints":["misinformation"|"fallacy"|"bias"],"subtypeHint":"string optional","reason":"string optional"}]}',
    'Rules:',
    '- Keep each quote under 220 characters.',
    '- Return at most 24 candidates.',
    '- Prefer recall over strict precision; include medium-confidence likely issues.',
    '- issueHints can include multiple values.',
    ...(isYouTube
      ? [
          '- For each quote, include timestampLabel when a matching transcript timestamp is available.',
          '- timestampLabel must match transcript labels exactly.',
        ]
      : []),
    `URL: ${url}`,
    `TITLE: ${title}`,
    ...(isYouTube
      ? [
          'TRANSCRIPT_LINES_START',
          buildTranscriptContext(transcriptSegments ?? []),
          'TRANSCRIPT_LINES_END',
        ]
      : [
          'PAGE_TEXT_START',
          content,
          'PAGE_TEXT_END',
        ]),
  ].join('\n');
}

function buildVerificationPrompt(
  options: {
    url: string;
    title: string;
    candidates: CandidateClaim[];
    transcriptSegments?: TranscriptSegment[];
  },
): string {
  const { url, title, candidates, transcriptSegments } = options;
  const isYouTube = (transcriptSegments?.length ?? 0) > 0;

  return [
    'You are a recall-friendly credibility analyst.',
    'Evaluate each quote for misinformation, logical fallacy, and rhetorical bias.',
    'For misinformation: include likely false or misleading claims, even if uncertainty exists.',
    'For fallacy and bias: use quote-grounded reasoning only.',
    'Approved fallacy subtypes: straw man, ad hominem, false dilemma, hasty generalization, slippery slope, appeal to fear.',
    'Approved bias subtypes: loaded language, cherry picking, framing bias, confirmation framed rhetoric.',
    'Return strict JSON with shape:',
    isYouTube
      ? '{"findings":[{"quote":"string","timestampLabel":"m:ss or h:mm:ss optional","issueTypes":["misinformation"|"fallacy"|"bias"],"subtype":"string optional","confidence":0.0,"severity":1,"rationale":"string","correction":"string optional"}]}'
      : '{"findings":[{"quote":"string","issueTypes":["misinformation"|"fallacy"|"bias"],"subtype":"string optional","confidence":0.0,"severity":1,"rationale":"string","correction":"string optional"}]}',
    'Rules:',
    '- Output medium or high-confidence items when likely problematic.',
    '- For misinformation include correction.',
    '- If a quote is not supportable as problematic, omit it.',
    ...(isYouTube
      ? [
          '- Include timestampLabel whenever a quote is tied to a transcript line.',
          '- timestampLabel must match available transcript labels exactly.',
        ]
      : []),
    `URL: ${url}`,
    `TITLE: ${title}`,
    `CANDIDATES_JSON: ${JSON.stringify(candidates)}`,
    ...(isYouTube
      ? [
          'TRANSCRIPT_LINES_START',
          buildTranscriptContext(transcriptSegments ?? []),
          'TRANSCRIPT_LINES_END',
        ]
      : []),
  ].join('\n');
}

function buildDirectFindingsPrompt(options: {
  url: string;
  title: string;
  content: string;
  transcriptSegments?: TranscriptSegment[];
}): string {
  const { url, title, content, transcriptSegments } = options;
  const isYouTube = (transcriptSegments?.length ?? 0) > 0;

  return [
    'You are a sensitivity-first credibility analyst.',
    'Find likely misinformation, fallacy, and bias directly from the provided text.',
    'Use concise, direct quotes from the source text only.',
    'Return strict JSON only with shape:',
    isYouTube
      ? '{"findings":[{"quote":"string","timestampLabel":"m:ss or h:mm:ss optional","issueTypes":["misinformation"|"fallacy"|"bias"],"subtype":"string optional","confidence":0.0,"severity":1,"rationale":"string","correction":"string optional"}]}'
      : '{"findings":[{"quote":"string","issueTypes":["misinformation"|"fallacy"|"bias"],"subtype":"string optional","confidence":0.0,"severity":1,"rationale":"string","correction":"string optional"}]}',
    'Rules:',
    '- Prefer recall over strict precision.',
    '- Include medium-confidence likely issues.',
    '- Keep quote text close to source wording.',
    '- For misinformation, provide correction when possible.',
    ...(isYouTube
      ? [
          '- Include timestampLabel when possible.',
          '- timestampLabel should match transcript labels when available.',
        ]
      : []),
    `URL: ${url}`,
    `TITLE: ${title}`,
    ...(isYouTube
      ? [
          'TRANSCRIPT_LINES_START',
          buildTranscriptContext(transcriptSegments ?? []),
          'TRANSCRIPT_LINES_END',
        ]
      : [
          'PAGE_TEXT_START',
          content,
          'PAGE_TEXT_END',
        ]),
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
    const quote = normalizeQuoteText(String((item as { quote?: unknown }).quote ?? ''));
    if (quote.length < 18) {
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
      timestampLabel: toTimestampLabel((item as { timestampLabel?: unknown }).timestampLabel),
      reason: String((item as { reason?: unknown }).reason ?? '').trim() || undefined,
    });
    if (candidates.length >= 14) {
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
    const quote = normalizeQuoteText(String((item as { quote?: unknown }).quote ?? ''));
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
      timestampLabel: toTimestampLabel((item as { timestampLabel?: unknown }).timestampLabel),
    });
  }
  return normalized;
}

function quoteLikelyPresent(normalizedQuote: string, normalizedPageText: string): boolean {
  if (!normalizedQuote) return false;
  if (normalizedPageText.includes(normalizedQuote)) return true;

  const words = normalizedQuote
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
  if (words.length === 0) return false;

  const head = words.slice(0, Math.min(4, words.length)).join(' ');
  const tail = words.slice(Math.max(0, words.length - 4)).join(' ');
  if (head && tail && normalizedPageText.includes(head) && normalizedPageText.includes(tail)) {
    return true;
  }

  const matched = words.filter((word) => normalizedPageText.includes(word)).length;
  return matched / words.length >= 0.72;
}

function meetsPrecisionRules(
  rawFinding: RawFinding,
  normalizedPageText: string,
  isYouTube = false,
): boolean {
  const normalizedQuote = normalizeText(rawFinding.quote);
  const minQuoteLength = isYouTube ? 8 : 12;
  if (normalizedQuote.length < minQuoteLength || !quoteLikelyPresent(normalizedQuote, normalizedPageText)) {
    return false;
  }

  const minRationaleLength = isYouTube ? 5 : 8;
  if (!rawFinding.rationale || rawFinding.rationale.length < minRationaleLength) {
    return false;
  }

  if (rawFinding.issueTypes.includes('misinformation')) {
    const threshold = isYouTube ? YOUTUBE_MISINFORMATION_THRESHOLD : MISINFORMATION_THRESHOLD;
    if (rawFinding.confidence < threshold) {
      return false;
    }
    if (!isYouTube && (!rawFinding.correction || rawFinding.correction.length < 8)) {
      return false;
    }
    if (
      isYouTube &&
      (!rawFinding.correction || rawFinding.correction.length < 6) &&
      rawFinding.confidence < threshold + 0.15
    ) {
      return false;
    }
  }

  const argumentIssues = rawFinding.issueTypes.filter(
    (type) => type === 'fallacy' || type === 'bias',
  );
  if (argumentIssues.length > 0) {
    const threshold = isYouTube ? YOUTUBE_ARGUMENT_THRESHOLD : ARGUMENT_THRESHOLD;
    if (rawFinding.confidence < threshold) {
      return false;
    }

    const subtype = canonicalizeSubtype(rawFinding.subtype);
    if (rawFinding.issueTypes.includes('fallacy') && subtype && FALLACY_SUBTYPES.has(subtype)) {
      rawFinding.subtype = subtype;
    }
    if (rawFinding.issueTypes.includes('bias') && subtype && BIAS_SUBTYPES.has(subtype)) {
      rawFinding.subtype = subtype;
    }
  }

  return true;
}

function meetsFallbackRules(rawFinding: RawFinding, normalizedPageText: string): boolean {
  const normalizedQuote = normalizeText(rawFinding.quote);
  if (normalizedQuote.length < 10 || !quoteLikelyPresent(normalizedQuote, normalizedPageText)) {
    return false;
  }
  if (!rawFinding.rationale || rawFinding.rationale.length < 6) {
    return false;
  }
  return rawFinding.confidence >= 0.4;
}

function meetsFallbackRulesYouTube(rawFinding: RawFinding, normalizedPageText: string): boolean {
  const normalizedQuote = normalizeText(rawFinding.quote);
  if (normalizedQuote.length < 6 || !quoteLikelyPresent(normalizedQuote, normalizedPageText)) {
    return false;
  }
  if (!rawFinding.rationale || rawFinding.rationale.length < 4) {
    return false;
  }
  return rawFinding.confidence >= 0.28;
}

function segmentForQuote(quote: string, segments: TranscriptSegment[]): TranscriptSegment | null {
  const normalizedQuote = normalizeText(quote);
  if (!normalizedQuote) return null;
  for (const segment of segments) {
    const normalizedSegment = normalizeText(segment.text);
    if (normalizedSegment.includes(normalizedQuote) || normalizedQuote.includes(normalizedSegment)) {
      return segment;
    }
  }
  return null;
}

function attachTranscriptTimestamps(
  findings: Finding[],
  transcriptSegments: TranscriptSegment[],
): Finding[] {
  if (transcriptSegments.length === 0) return findings;

  return findings.map((finding) => {
    const byLabel = nearestSegmentForTimestampLabel(finding.timestampLabel, transcriptSegments);
    const byQuote = segmentForQuote(finding.quote, transcriptSegments);
    const segment = byLabel ?? byQuote;

    if (!segment) {
      return finding;
    }

    return {
      ...finding,
      timestampSec: segment.startSec,
      timestampLabel: segment.startLabel,
    };
  });
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
        timestampLabel: rawFinding.timestampLabel,
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
    if (!existing.timestampLabel && rawFinding.timestampLabel) {
      existing.timestampLabel = rawFinding.timestampLabel;
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

async function callOpenRouterJsonSafe<T>(options: {
  apiKey: string;
  prompt: string;
  fallback: T;
}): Promise<T> {
  try {
    return await callOpenRouterJson<T>({
      apiKey: options.apiKey,
      prompt: options.prompt,
    });
  } catch {
    return options.fallback;
  }
}

export async function analyzeClaims(options: {
  apiKey: string;
  tabId: number;
  url: string;
  title: string;
  text: string;
  transcriptSegments?: TranscriptSegment[];
  truncated: boolean;
  analyzedChars: number;
}): Promise<ScanReport> {
  const {
    apiKey,
    tabId,
    url,
    title,
    text,
    transcriptSegments = [],
    truncated,
    analyzedChars,
  } = options;
  const normalizedPageText = normalizeText(text);
  const isYouTube = transcriptSegments.length > 0;

  const candidatePrompt = buildCandidatePrompt({
    url,
    title,
    content: text,
    transcriptSegments,
  });
  const candidateResponse = await callOpenRouterJsonSafe<{ candidates?: unknown }>({
    apiKey,
    prompt: candidatePrompt,
    fallback: { candidates: [] },
  });
  const candidates = coerceCandidates(candidateResponse);

  if (candidates.length === 0) {
    const directPrompt = buildDirectFindingsPrompt({
      url,
      title,
      content: text,
      transcriptSegments,
    });
    const directResponse = await callOpenRouterJsonSafe<{ findings?: unknown }>({
      apiKey,
      prompt: directPrompt,
      fallback: { findings: [] },
    });
    const directRawFindings = coerceRawFindings(directResponse);
    const directFiltered = directRawFindings.filter((finding) =>
      meetsPrecisionRules(finding, normalizedPageText, isYouTube),
    );
    const directFallback = directRawFindings.filter((finding) =>
      isYouTube
        ? meetsFallbackRulesYouTube(finding, normalizedPageText)
        : meetsFallbackRules(finding, normalizedPageText),
    );
    const selected = directFiltered.length > 0 ? directFiltered : directFallback;
    const findings = attachTranscriptTimestamps(mergeFindings(selected), transcriptSegments);

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

  const verificationPrompt = buildVerificationPrompt({
    url,
    title,
    candidates,
    transcriptSegments,
  });
  const verificationResponse = await callOpenRouterJsonSafe<{ findings?: unknown }>({
    apiKey,
    prompt: verificationPrompt,
    fallback: { findings: [] },
  });

  const rawFindings = coerceRawFindings(verificationResponse);
  const filtered = rawFindings.filter((finding) =>
    meetsPrecisionRules(finding, normalizedPageText, isYouTube),
  );
  const fallback = rawFindings.filter((finding) =>
    isYouTube
      ? meetsFallbackRulesYouTube(finding, normalizedPageText)
      : meetsFallbackRules(finding, normalizedPageText),
  );
  const selected = filtered.length > 0 ? filtered : fallback;
  const findings = attachTranscriptTimestamps(mergeFindings(selected), transcriptSegments);

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

import { callGeminiJson } from '@/lib/gemini';
import type {
  CandidateClaim,
  Citation,
  Finding,
  IssueType,
  RawFinding,
  ScanReport,
  ScanSummary,
} from '@/lib/types';

const MISINFORMATION_THRESHOLD = 0.88;
const ARGUMENT_THRESHOLD = 0.82;
const MIN_CITATIONS = 2;

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

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeSubtype(input?: string): string {
  return (input ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function sanitizeCitations(
  value: unknown,
  fallbackCitations: Citation[],
): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();

  const pushCitation = (title: string, url: string) => {
    if (!/^https?:\/\//i.test(url) || seen.has(url)) {
      return;
    }
    seen.add(url);
    citations.push({
      title,
      url,
      domain: (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return undefined;
        }
      })(),
    });
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const title = String((item as { title?: unknown }).title ?? '').trim();
      const url = String((item as { url?: unknown }).url ?? '').trim();
      if (!title || !url) {
        continue;
      }
      pushCitation(title, url);
    }
  }

  for (const citation of fallbackCitations) {
    if (citations.length >= MIN_CITATIONS) {
      break;
    }
    pushCitation(citation.title, citation.url);
  }

  return citations;
}

function buildCandidatePrompt(url: string, title: string, content: string): string {
  return [
    'You are a strict claim miner focused on misinformation, fallacies, and bias.',
    'Extract only concise, direct quotes from the page that are likely problematic.',
    'Do not summarize the page.',
    'Return valid JSON with this shape only:',
    '{"candidates":[{"quote":"string","issueHints":["misinformation"|"fallacy"|"bias"],"subtypeHint":"string optional","reason":"string optional"}]}',
    'Rules:',
    '- Keep each quote under 220 characters.',
    '- Return at most 14 candidates.',
    '- Skip uncertain or weak items.',
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
    'You are a high-precision credibility analyst.',
    'Evaluate each quote for misinformation, logical fallacy, and rhetorical bias.',
    'For misinformation: use web grounding and include only if highly likely false or misleading.',
    'For fallacy and bias: use quote-grounded reasoning only.',
    'Approved fallacy subtypes: straw man, ad hominem, false dilemma, hasty generalization, slippery slope, appeal to fear.',
    'Approved bias subtypes: loaded language, cherry picking, framing bias, confirmation framed rhetoric.',
    'Return strict JSON with shape:',
    '{"findings":[{"quote":"string","issueTypes":["misinformation"|"fallacy"|"bias"],"subtype":"string optional","confidence":0.0,"severity":1,"rationale":"string","correction":"string optional","citations":[{"title":"string","url":"https://..."}]}]}',
    'Rules:',
    '- Output only high-confidence items.',
    '- For misinformation include correction and at least two quality sources when possible.',
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
    if (quote.length < 24) {
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
    if (candidates.length >= 14) {
      break;
    }
  }
  return candidates;
}

function coerceRawFindings(payload: unknown, fallbackCitations: Citation[]): RawFinding[] {
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
      citations: sanitizeCitations((item as { citations?: unknown }).citations, fallbackCitations),
    });
  }
  return normalized;
}

function meetsPrecisionRules(rawFinding: RawFinding, normalizedPageText: string): boolean {
  const normalizedQuote = normalizeText(rawFinding.quote);
  if (normalizedQuote.length < 24 || !normalizedPageText.includes(normalizedQuote)) {
    return false;
  }

  if (!rawFinding.rationale || rawFinding.rationale.length < 16) {
    return false;
  }

  if (rawFinding.issueTypes.includes('misinformation')) {
    if (rawFinding.confidence < MISINFORMATION_THRESHOLD) {
      return false;
    }
    if (!rawFinding.correction || rawFinding.correction.length < 12) {
      return false;
    }
    if ((rawFinding.citations ?? []).length < MIN_CITATIONS) {
      return false;
    }
  }

  const argumentIssues = rawFinding.issueTypes.filter(
    (type) => type === 'fallacy' || type === 'bias',
  );
  if (argumentIssues.length > 0) {
    if (rawFinding.confidence < ARGUMENT_THRESHOLD) {
      return false;
    }

    const subtype = normalizeSubtype(rawFinding.subtype);
    if (rawFinding.issueTypes.includes('fallacy') && !FALLACY_SUBTYPES.has(subtype)) {
      return false;
    }
    if (rawFinding.issueTypes.includes('bias') && !BIAS_SUBTYPES.has(subtype)) {
      return false;
    }
  }

  return true;
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
        citations: [...(rawFinding.citations ?? [])],
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

    const citationMap = new Map(existing.citations.map((citation) => [citation.url, citation]));
    for (const citation of rawFinding.citations ?? []) {
      citationMap.set(citation.url, citation);
    }
    existing.citations = [...citationMap.values()];
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

  const candidatePrompt = buildCandidatePrompt(url, title, text);
  const candidateResponse = await callGeminiJson<{ candidates?: unknown }>({
    apiKey,
    prompt: candidatePrompt,
  });
  const candidates = coerceCandidates(candidateResponse.data);

  if (candidates.length === 0) {
    return {
      tabId,
      url,
      title,
      scannedAt: new Date().toISOString(),
      summary: buildSummary([]),
      findings: [],
      truncated,
      analyzedChars,
    };
  }

  const verificationPrompt = buildVerificationPrompt(url, title, candidates);
  const verificationResponse = await callGeminiJson<{ findings?: unknown }>({
    apiKey,
    prompt: verificationPrompt,
    withGrounding: true,
  });

  const rawFindings = coerceRawFindings(verificationResponse.data, verificationResponse.groundingCitations);
  const filtered = rawFindings.filter((finding) => meetsPrecisionRules(finding, normalizedPageText));
  const findings = mergeFindings(filtered);

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

import { callOpenRouterJson } from '@/lib/openrouter';
import type { Finding, FindingEvidence, PageContext } from '@/lib/types';

type EvidenceKind =
  | 'factcheck'
  | 'wikipedia'
  | 'wikidata'
  | 'pubmed'
  | 'gdelt';

type Stance = 'critical' | 'supportive' | 'neutral' | 'mixed' | 'unknown';

interface CandidateRow {
  id: string;
  kind: EvidenceKind;
  summary: string;
}

interface ScoredRow {
  id: string;
  relevance: number;
  useful: boolean;
  stance: Stance;
}

interface RerankResponse {
  items?: Array<{
    id?: string;
    relevance?: number;
    useful?: boolean;
    stance?: string;
  }>;
}

interface RerankInput {
  apiKey: string;
  finding: Pick<Finding, 'quote' | 'correction' | 'rationale' | 'issueTypes'>;
  pageContext?: PageContext;
  evidence: Pick<FindingEvidence, 'factChecks' | 'corroboration' | 'gdeltArticles'>;
}

interface RerankResult {
  factChecks: FindingEvidence['factChecks'];
  corroboration: FindingEvidence['corroboration'];
  gdeltArticles: FindingEvidence['gdeltArticles'];
}

function trimText(input: string, max = 260): string {
  const cleaned = input.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3).trim()}...`;
}

function asScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function asStance(value: unknown): Stance {
  const text = String(value ?? '').toLowerCase().trim();
  if (text === 'critical' || text === 'supportive' || text === 'neutral' || text === 'mixed') {
    return text;
  }
  return 'unknown';
}

function buildCandidateRows(evidence: RerankInput['evidence']): CandidateRow[] {
  const rows: CandidateRow[] = [];

  evidence.factChecks.forEach((item, index) => {
    rows.push({
      id: `factcheck:${index}`,
      kind: 'factcheck',
      summary: trimText(
        [
          `publisher=${item.publisher}`,
          `title=${item.reviewTitle}`,
          item.claimText ? `claim=${item.claimText}` : '',
          item.textualRating ? `rating=${item.textualRating}` : '',
        ]
          .filter(Boolean)
          .join(' | '),
      ),
    });
  });

  evidence.corroboration.wikipedia.forEach((item, index) => {
    rows.push({
      id: `wikipedia:${index}`,
      kind: 'wikipedia',
      summary: trimText(`title=${item.title} | snippet=${item.snippet}`),
    });
  });

  evidence.corroboration.wikidata.forEach((item, index) => {
    rows.push({
      id: `wikidata:${index}`,
      kind: 'wikidata',
      summary: trimText(`title=${item.title} | snippet=${item.snippet}`),
    });
  });

  evidence.corroboration.pubmed.forEach((item, index) => {
    rows.push({
      id: `pubmed:${index}`,
      kind: 'pubmed',
      summary: trimText(`title=${item.title} | snippet=${item.snippet}`),
    });
  });

  evidence.gdeltArticles.forEach((item, index) => {
    rows.push({
      id: `gdelt:${index}`,
      kind: 'gdelt',
      summary: trimText(
        [
          `domain=${item.domain}`,
          `title=${item.title}`,
          typeof item.tone === 'number' ? `tone=${item.tone.toFixed(1)}` : '',
        ]
          .filter(Boolean)
          .join(' | '),
      ),
    });
  });

  return rows;
}

function buildPrompt(input: RerankInput, candidates: CandidateRow[]): string {
  const issueTypes = input.finding.issueTypes.join(', ');
  const correction = input.finding.correction ? trimText(input.finding.correction, 220) : '';
  const contextSummary = input.pageContext?.summary ? trimText(input.pageContext.summary, 220) : '';
  const contextTopics = (input.pageContext?.topicKeywords ?? []).slice(0, 8).join(', ');

  return [
    'You are a strict evidence relevance and stance filter for misinformation analysis.',
    'Task: score whether each candidate is truly relevant to evaluating the claim substance.',
    'Reject entity-only matches (e.g., person biography pages) when they do not address the claim topic.',
    'For misinformation findings, prefer critical/neutral/mixed verification context over supportive-only context.',
    'Return strict JSON only with shape:',
    '{"items":[{"id":"string","relevance":0.0,"useful":true,"stance":"critical|supportive|neutral|mixed|unknown"}]}',
    'Scoring guidance:',
    '- relevance 0.0..1.0, where >=0.65 is strong topical match.',
    '- useful=true only when source helps verify, critique, or contextualize the claim topic directly.',
    `ISSUE_TYPES: ${issueTypes}`,
    `CLAIM_QUOTE: ${trimText(input.finding.quote, 260)}`,
    `RATIONALE: ${trimText(input.finding.rationale, 260)}`,
    correction ? `CORRECTION_HINT: ${correction}` : 'CORRECTION_HINT: none',
    contextSummary ? `PAGE_CONTEXT_SUMMARY: ${contextSummary}` : 'PAGE_CONTEXT_SUMMARY: none',
    contextTopics ? `PAGE_CONTEXT_TOPICS: ${contextTopics}` : 'PAGE_CONTEXT_TOPICS: none',
    `CANDIDATES_JSON: ${JSON.stringify(candidates)}`,
  ].join('\n');
}

function filterByKeepIds<T>(items: T[], prefix: string, keepIds: Set<string>): T[] {
  const selected = items.filter((_, index) => keepIds.has(`${prefix}:${index}`));
  return selected;
}

function buildKeepSet(
  scoredRows: ScoredRow[],
  issueTypes: Finding['issueTypes'],
): Set<string> {
  const misinformation = issueTypes.includes('misinformation');

  const sorted = [...scoredRows].sort((left, right) => right.relevance - left.relevance);
  const broadlyRelevant = sorted.filter((row) => row.useful && row.relevance >= 0.55);
  if (!misinformation && broadlyRelevant.length > 0) {
    return new Set(broadlyRelevant.slice(0, 8).map((row) => row.id));
  }

  if (misinformation && broadlyRelevant.length > 0) {
    const criticalish = broadlyRelevant.filter((row) => row.stance !== 'supportive');
    if (criticalish.length > 0) {
      return new Set(criticalish.slice(0, 8).map((row) => row.id));
    }
    const strongSupportive = broadlyRelevant
      .filter((row) => row.relevance >= 0.7)
      .slice(0, 5)
      .map((row) => row.id);
    if (strongSupportive.length > 0) {
      return new Set(strongSupportive);
    }
    return new Set(broadlyRelevant.slice(0, 4).map((row) => row.id));
  }

  // Never drop everything. Keep a small best-effort set when signals are weak.
  const bestEffort = sorted
    .filter((row) => row.relevance >= 0.45)
    .slice(0, 4)
    .map((row) => row.id);
  if (bestEffort.length > 0) {
    return new Set(bestEffort);
  }

  return new Set(
    sorted
      .slice(0, 3)
      .map((row) => row.id),
  );
}

export async function rerankEvidenceWithOpenRouter(input: RerankInput): Promise<RerankResult> {
  const candidates = buildCandidateRows(input.evidence);
  if (candidates.length === 0) {
    return {
      factChecks: input.evidence.factChecks,
      corroboration: input.evidence.corroboration,
      gdeltArticles: input.evidence.gdeltArticles,
    };
  }

  const response = await callOpenRouterJson<RerankResponse>({
    apiKey: input.apiKey,
    prompt: buildPrompt(input, candidates),
    timeoutMs: 55_000,
  });

  const itemRows = Array.isArray(response.items) ? response.items : [];
  const scored: ScoredRow[] = itemRows
    .map((item) => ({
      id: String(item.id ?? '').trim(),
      relevance: asScore(item.relevance),
      useful: Boolean(item.useful),
      stance: asStance(item.stance),
    }))
    .filter((item) => item.id.length > 0);

  if (scored.length === 0) {
    return {
      factChecks: input.evidence.factChecks,
      corroboration: input.evidence.corroboration,
      gdeltArticles: input.evidence.gdeltArticles,
    };
  }

  const keepIds = buildKeepSet(scored, input.finding.issueTypes);

  return {
    factChecks: filterByKeepIds(input.evidence.factChecks, 'factcheck', keepIds),
    corroboration: {
      wikipedia: filterByKeepIds(input.evidence.corroboration.wikipedia, 'wikipedia', keepIds),
      wikidata: filterByKeepIds(input.evidence.corroboration.wikidata, 'wikidata', keepIds),
      pubmed: filterByKeepIds(input.evidence.corroboration.pubmed, 'pubmed', keepIds),
    },
    gdeltArticles: filterByKeepIds(input.evidence.gdeltArticles, 'gdelt', keepIds),
  };
}

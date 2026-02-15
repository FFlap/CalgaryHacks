import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  Gauge,
  KeyRound,
  LoaderCircle,
  Radar,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type {
  Finding,
  FindingEvidence,
  IssueType,
  RuntimeRequest,
  ScanReport,
  ScanStatus,
  VerificationCode,
} from '@/lib/types';

/* ------------------------------------------------------------------ */
/*  Extension runtime bridge                                          */
/* ------------------------------------------------------------------ */

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;
const API_KEY_STORAGE_KEY = 'openrouter_api_key';
const LEGACY_API_KEY_STORAGE_KEY = 'gemini_api_key';
const GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEY = 'google_fact_check_api_key';
const LEGACY_GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEYS = [
  'google_factcheck_api_key',
  'googleFactCheckApiKey',
  'GOOGLE_FACT_CHECK_API_KEY',
] as const;
const GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEYS = [
  GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEY,
  ...LEGACY_GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEYS,
] as const;

type ReportResponse = { report: ScanReport | null };
type SettingsResponse = { hasApiKey: boolean; hasGoogleFactCheckApiKey?: boolean };
type FocusResponse = { findingId: string | null };
type EvidenceResponse = {
  ok: boolean;
  evidence?: FindingEvidence;
  error?: string;
};
type FilterKey = 'all' | IssueType;
type PopupView = 'review' | 'dashboard';
type FindingEvidenceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; evidence: FindingEvidence }
  | { status: 'error'; message: string };
type DashboardFinding = {
  quote: string;
  issueTypes: IssueType[];
  subtype?: string;
  confidence: number;
  severity: number;
  rationale: string;
};
type DashboardPayload = {
  generatedAt: string;
  source: {
    title: string;
    url: string;
    scanMessage: string;
  };
  summary: {
    totalFindings: number;
    misinformationCount: number;
    fallacyCount: number;
    biasCount: number;
    averageConfidence: number;
    averageSeverity: number;
  };
  biasSubtypes: Array<{ subtype: string; count: number }>;
  findings: DashboardFinding[];
};

const runningStates = new Set<ScanStatus['state']>(['extracting', 'analyzing', 'highlighting']);

async function sendMessage<T>(message: RuntimeRequest): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = (await ext.runtime.sendMessage(message)) as T | undefined;
      if (typeof response !== 'undefined') {
        return response;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 120 + attempt * 80));
  }

  if (message.type === 'GET_SETTINGS') {
    return { hasApiKey: false, hasGoogleFactCheckApiKey: false } as T;
  }

  if (message.type === 'GET_SCAN_STATUS') {
    return {
      tabId: message.tabId,
      state: 'idle',
      progress: 0,
      message: 'Ready to scan the active page.',
      updatedAt: Date.now(),
    } as T;
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('Background service is temporarily unavailable.');
}

async function getReportWithRetry(tabId: number, attempts = 14): Promise<ReportResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'GET_REPORT',
        tabId,
      })) as ReportResponse | undefined;
      if (typeof response !== 'undefined') return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120 + attempt * 90));
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  return { report: null };
}

async function getFocusFindingWithRetry(
  tabId: number,
  attempts = 10,
): Promise<FocusResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'GET_FOCUS_FINDING',
        tabId,
      })) as FocusResponse | undefined;
      if (typeof response !== 'undefined') return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120 + attempt * 80));
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  return { findingId: null };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function labelForType(issue: IssueType) {
  if (issue === 'misinformation') return 'Misinfo';
  if (issue === 'fallacy') return 'Fallacy';
  return 'Bias';
}

function issueColor(issue: IssueType) {
  if (issue === 'misinformation') return 'bg-red-500/10 text-red-700 border-red-300/60';
  if (issue === 'fallacy') return 'bg-amber-500/10 text-amber-700 border-amber-300/60';
  return 'bg-sky-500/10 text-sky-700 border-sky-300/60';
}

function verificationPillClass(code: VerificationCode) {
  if (code === 'supported') return 'evidence-status-pill evidence-status-pill--supported';
  if (code === 'contradicted') return 'evidence-status-pill evidence-status-pill--contradicted';
  if (code === 'contested') return 'evidence-status-pill evidence-status-pill--contested';
  return 'evidence-status-pill evidence-status-pill--unverified';
}

function formatEvidenceDate(dateValue?: string) {
  if (!dateValue) return '';
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return dateValue;
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface TrustedSourceCard {
  id: string;
  source: string;
  title: string;
  snippet?: string;
  url: string;
  linkLabel: string;
  dateLabel?: string;
  verdictCode?: VerificationCode;
  verdictLabel?: string;
  auxLabel?: string;
}

function buildTrustedSourceCards(evidence: FindingEvidence): TrustedSourceCard[] {
  const cards: TrustedSourceCard[] = [];

  evidence.factChecks.forEach((match, index) => {
    cards.push({
      id: `factcheck:${index}:${match.reviewUrl}`,
      source: match.publisher || 'Fact-check',
      title: match.reviewTitle,
      snippet: match.claimText ? `Claim: ${match.claimText}` : undefined,
      url: match.reviewUrl,
      linkLabel: 'Open source',
      dateLabel: formatEvidenceDate(match.reviewDate),
      verdictCode: match.normalizedVerdict === 'unknown' ? 'unverified' : match.normalizedVerdict,
      verdictLabel: match.textualRating || match.normalizedVerdict,
    });
  });

  evidence.corroboration.wikipedia.forEach((item, index) => {
    cards.push({
      id: `wikipedia:${index}:${item.url}`,
      source: item.source,
      title: item.title,
      snippet: item.snippet,
      url: item.url,
      linkLabel: 'Open source',
    });
  });

  evidence.corroboration.wikidata.forEach((item, index) => {
    cards.push({
      id: `wikidata:${index}:${item.url}`,
      source: item.source,
      title: item.title,
      snippet: item.snippet,
      url: item.url,
      linkLabel: 'Open source',
    });
  });

  evidence.corroboration.pubmed.forEach((item, index) => {
    cards.push({
      id: `pubmed:${index}:${item.url}`,
      source: item.source,
      title: item.title,
      snippet: item.snippet,
      url: item.url,
      linkLabel: 'Open source',
    });
  });

  evidence.gdeltArticles.forEach((article, index) => {
    cards.push({
      id: `gdelt:${index}:${article.url}`,
      source: article.domain || 'GDELT',
      title: article.title,
      url: article.url,
      linkLabel: 'Open source',
      dateLabel: formatEvidenceDate(article.seenDate),
      auxLabel:
        typeof article.tone === 'number'
          ? `Tone ${article.tone > 0 ? '+' : ''}${article.tone.toFixed(1)}`
          : undefined,
    });
  });

  return cards;
}

function stateLabel(state: ScanStatus['state']) {
  if (state === 'extracting') return 'Extracting';
  if (state === 'analyzing') return 'Analyzing';
  if (state === 'highlighting') return 'Highlighting';
  if (state === 'done') return 'Complete';
  if (state === 'error') return 'Error';
  return 'Ready';
}

function formatQuoteForDisplay(input: string): string {
  const cleaned = input
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'`“”‘’]+/, '')
    .replace(/[\s"'`“”‘’]+$/, '')
    .trim();
  return cleaned ? `"${cleaned}"` : '""';
}

function sortFindingsForDisplay(findings: Finding[], timelineMode: boolean): Finding[] {
  if (!timelineMode) return findings;

  const withTimestamp = findings
    .filter((finding) => Number.isFinite(finding.timestampSec))
    .sort((left, right) => {
      const leftSec = left.timestampSec as number;
      const rightSec = right.timestampSec as number;
      if (leftSec !== rightSec) return leftSec - rightSec;
      if (left.severity !== right.severity) return right.severity - left.severity;
      return right.confidence - left.confidence;
    });

  const withoutTimestamp = findings
    .filter((finding) => !Number.isFinite(finding.timestampSec))
    .sort((left, right) => {
      if (left.severity !== right.severity) return right.severity - left.severity;
      return right.confidence - left.confidence;
    });

  return [...withTimestamp, ...withoutTimestamp];
}

const scanStepOrder: Array<{ state: ScanStatus['state']; label: string }> = [
  { state: 'extracting', label: 'Extract page text' },
  { state: 'analyzing', label: 'Analyze claims' },
  { state: 'highlighting', label: 'Add inline highlights' },
];

function getStepInfo(state: ScanStatus['state']) {
  const total = scanStepOrder.length;
  const index = scanStepOrder.findIndex((step) => step.state === state);
  if (index >= 0) {
    return {
      current: index + 1,
      total,
      label: scanStepOrder[index].label,
    };
  }
  if (state === 'done') {
    return {
      current: total,
      total,
      label: 'Completed',
    };
  }
  return null;
}

function trimText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function formatDashboardTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Updated now';
  return `Updated ${parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

function buildDashboardPayload(report: ScanReport | null, scanStatus: ScanStatus): DashboardPayload {
  const findings = report?.findings ?? [];
  const sortedFindings = [...findings].sort((left, right) => {
    if (left.severity !== right.severity) return right.severity - left.severity;
    return right.confidence - left.confidence;
  });

  const topFindings = sortedFindings.slice(0, 12).map((finding) => ({
    quote: trimText(finding.quote, 260),
    issueTypes: finding.issueTypes,
    subtype: finding.subtype,
    confidence: Number(finding.confidence.toFixed(3)),
    severity: finding.severity,
    rationale: trimText(finding.rationale, 320),
  }));

  const biasSubtypeCounts = new Map<string, number>();
  for (const finding of findings) {
    if (!finding.issueTypes.includes('bias')) continue;
    const subtype = (finding.subtype || 'unspecified').toLowerCase().trim();
    biasSubtypeCounts.set(subtype, (biasSubtypeCounts.get(subtype) ?? 0) + 1);
  }
  const biasSubtypes = [...biasSubtypeCounts.entries()]
    .map(([subtype, count]) => ({ subtype, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 8);

  const averageConfidence =
    findings.length > 0
      ? findings.reduce((sum, finding) => sum + finding.confidence, 0) / findings.length
      : 0;
  const averageSeverity =
    findings.length > 0
      ? findings.reduce((sum, finding) => sum + finding.severity, 0) / findings.length
      : 0;

  return {
    generatedAt: new Date().toISOString(),
    source: {
      title: report?.title || 'No page scanned yet',
      url: report?.url || '',
      scanMessage: scanStatus.message || 'Ready to scan',
    },
    summary: {
      totalFindings: report?.summary.totalFindings ?? findings.length,
      misinformationCount: report?.summary.misinformationCount ?? 0,
      fallacyCount: report?.summary.fallacyCount ?? 0,
      biasCount: report?.summary.biasCount ?? 0,
      averageConfidence: Number(averageConfidence.toFixed(3)),
      averageSeverity: Number(averageSeverity.toFixed(2)),
    },
    biasSubtypes,
    findings: topFindings,
  };
}

function StepProgressRing({
  current,
  total,
  size = 36,
}: {
  current: number;
  total: number;
  size?: number;
}) {
  const safeTotal = Math.max(1, total);
  const progress = Math.max(0, Math.min(1, current / safeTotal));
  const r = (size - 4) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - progress);

  return (
    <div className="step-ring" aria-label={`Scan progress ${current}/${safeTotal}`}>
      <svg width={size} height={size} className="progress-ring">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          opacity={0.18}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-500 ease-out"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="step-ring-label">
        {current}/{safeTotal}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Settings Modal                                                    */
/* ------------------------------------------------------------------ */

function SettingsModal({
  hasApiKey,
  hasGoogleFactCheckApiKey,
  onSaved,
}: {
  hasApiKey: boolean;
  hasGoogleFactCheckApiKey: boolean;
  onSaved: (updates: { openRouter?: boolean; googleFactCheck?: boolean }) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [googleFactCheckApiKey, setGoogleFactCheckApiKey] = useState('');
  const [isSavingOpenRouter, setIsSavingOpenRouter] = useState(false);
  const [isSavingGoogleFactCheck, setIsSavingGoogleFactCheck] = useState(false);
  const [message, setMessage] = useState('');
  const saveOpenRouterKey = useCallback(async () => {
    if (!apiKey.trim()) {
      setMessage('Please enter a valid OpenRouter API key.');
      return;
    }

    setIsSavingOpenRouter(true);
    try {
      const trimmed = apiKey.trim();
      await ext.storage.local.set({
        [API_KEY_STORAGE_KEY]: trimmed,
        [LEGACY_API_KEY_STORAGE_KEY]: trimmed,
      });
      await sendMessage<{ ok: boolean; hasApiKey: boolean }>({
        type: 'SAVE_API_KEY',
        apiKey: trimmed,
      }).catch(() => undefined);
      setMessage('OpenRouter API key saved.');
      setApiKey('');
      onSaved({ openRouter: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setIsSavingOpenRouter(false);
    }
  }, [apiKey, onSaved]);

  const saveGoogleFactCheckKey = useCallback(async () => {
    if (!googleFactCheckApiKey.trim()) {
      setMessage('Please enter a valid Google Fact Check API key.');
      return;
    }

    setIsSavingGoogleFactCheck(true);
    try {
      const trimmed = googleFactCheckApiKey.trim();
      await ext.storage.local.set({
        [GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEY]: trimmed,
        ...Object.fromEntries(
          LEGACY_GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEYS.map((key) => [key, trimmed]),
        ),
      });
      await sendMessage<{ ok: boolean; hasGoogleFactCheckApiKey: boolean }>({
        type: 'SAVE_GOOGLE_FACT_CHECK_API_KEY',
        apiKey: trimmed,
      }).catch(() => undefined);
      setMessage('Google Fact Check API key saved.');
      setGoogleFactCheckApiKey('');
      onSaved({ googleFactCheck: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setIsSavingGoogleFactCheck(false);
    }
  }, [googleFactCheckApiKey, onSaved]);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          className="settings-trigger"
          aria-label="Settings"
        >
          <Settings className="size-[15px]" />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            API Keys
          </DialogTitle>
          <DialogDescription>
            Stored locally in your browser. Never leaves this device.
          </DialogDescription>
        </DialogHeader>

        {(hasApiKey || hasGoogleFactCheckApiKey) && (
          <div className="mb-3 rounded-lg border border-emerald-200/60 bg-emerald-50/80 px-3 py-2 text-xs text-emerald-700">
            <div className="mb-1 flex items-center gap-2">
              <ShieldCheck className="size-3.5 shrink-0" />
              Keys configured:
            </div>
            <div className="pl-5">
              <div>OpenRouter: {hasApiKey ? 'Configured' : 'Not configured'}</div>
              <div>Google Fact Check: {hasGoogleFactCheckApiKey ? 'Configured' : 'Not configured'}</div>
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-foreground/80">OpenRouter API key</p>
            <div className="flex gap-2">
              <Input
                data-testid="api-key-input"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setMessage('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveOpenRouterKey();
                }}
                placeholder={hasApiKey ? 'Enter new key to replace...' : 'Paste your OpenRouter API key'}
                className="font-mono text-xs"
              />
              <Button
                data-testid="save-api-key"
                onClick={() => void saveOpenRouterKey()}
                disabled={isSavingOpenRouter || !apiKey.trim()}
                className="shrink-0"
                size="sm"
              >
                {isSavingOpenRouter ? <LoaderCircle className="size-3.5 animate-spin" /> : 'Save'}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-foreground/80">Google Fact Check API key</p>
            <div className="flex gap-2">
              <Input
                data-testid="google-fact-check-key-input"
                type="password"
                autoComplete="off"
                value={googleFactCheckApiKey}
                onChange={(e) => {
                  setGoogleFactCheckApiKey(e.target.value);
                  setMessage('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveGoogleFactCheckKey();
                }}
                placeholder={
                  hasGoogleFactCheckApiKey
                    ? 'Enter new key to replace...'
                    : 'Paste your Google Fact Check API key'
                }
                className="font-mono text-xs"
              />
              <Button
                data-testid="save-google-fact-check-key"
                onClick={() => void saveGoogleFactCheckKey()}
                disabled={isSavingGoogleFactCheck || !googleFactCheckApiKey.trim()}
                className="shrink-0"
                size="sm"
              >
                {isSavingGoogleFactCheck ? <LoaderCircle className="size-3.5 animate-spin" /> : 'Save'}
              </Button>
            </div>
          </div>
        </div>

        {message && (
          <p className="mt-2 text-xs text-muted-foreground">{message}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Finding Card (expandable)                                         */
/* ------------------------------------------------------------------ */

function FindingCard({
  finding,
  isExpanded,
  isFocused,
  evidenceState,
  onToggle,
  onJump,
  onLoadEvidence,
  onRetryEvidence,
}: {
  finding: Finding;
  isExpanded: boolean;
  isFocused: boolean;
  evidenceState: FindingEvidenceState;
  onToggle: () => void;
  onJump: () => void;
  onLoadEvidence: () => void;
  onRetryEvidence: () => void;
}) {
  const evidence = evidenceState.status === 'loaded' ? evidenceState.evidence : null;
  const evidenceErrors: Array<[string, string]> = [];
  if (evidence) {
    for (const [source, message] of Object.entries(evidence.errors)) {
      if (typeof message === 'string' && message.trim()) {
        evidenceErrors.push([source, message]);
      }
    }
  }
  const trustedSourceCards = evidence ? buildTrustedSourceCards(evidence) : [];

  return (
    <article
      data-testid="finding-card"
      data-finding-id={finding.id}
      data-focused={isFocused ? 'true' : 'false'}
      className={`finding-card ${isFocused ? 'ring-2 ring-amber-400/80 border-amber-400/80' : ''}`}
    >
      {/* Collapsed summary — always visible */}
      <button
        type="button"
        onClick={onToggle}
        className="finding-summary"
      >
        <div className="flex flex-1 items-start gap-2 text-left">
          <div className="mt-0.5 flex shrink-0 flex-wrap gap-1">
            {finding.issueTypes.map((t) => (
              <span
                key={`${finding.id}-${t}`}
                className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-semibold leading-tight ${issueColor(t)}`}
              >
                {labelForType(t)}
              </span>
            ))}
          </div>
          <p className="line-clamp-2 text-[13px] leading-snug text-foreground/85">
            {formatQuoteForDisplay(finding.quote)}
          </p>
        </div>
        <ChevronDown
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Expanded detail */}
      <div
        className={`finding-detail ${isExpanded ? 'finding-detail--open' : ''}`}
      >
        <div className="finding-detail-inner">
          {/* Severity / confidence bar */}
          <div className="mb-2.5 flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block size-1.5 rounded-full bg-current opacity-50" />
              Confidence {Math.round(finding.confidence * 100)}%
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block size-1.5 rounded-full bg-current opacity-50" />
              Severity {finding.severity}/5
            </span>
            {finding.subtype && (
              <Badge variant="outline" className="h-auto px-1.5 py-0 text-[10px]">
                {finding.subtype}
              </Badge>
            )}
          </div>

          {/* Rationale */}
          <div className="mb-2.5">
            <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Why this was flagged
            </p>
            <p data-testid="finding-rationale" className="text-[12.5px] leading-relaxed text-foreground/80">
              {finding.rationale}
            </p>
          </div>

          {/* Correction */}
          {finding.correction && (
            <div className="mb-2.5 rounded-md border border-emerald-200/60 bg-emerald-50/50 px-2.5 py-2">
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-widest text-emerald-700/70">
                Correction
              </p>
              <p className="text-[12.5px] leading-relaxed text-emerald-900/80">
                {finding.correction}
              </p>
            </div>
          )}

          {/* Jump action */}
          <Button
            data-testid="jump-to-highlight"
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onJump();
            }}
            className="h-7 text-xs"
          >
            <Radar className="size-3.5" />
            Jump to highlight
          </Button>

          <section className="evidence-panel" data-testid="finding-evidence-panel">
            <div className="evidence-panel-head">
              <p className="evidence-panel-title">Trusted sources</p>
              {evidence && (
                <span className={verificationPillClass(evidence.status.code)} data-testid="evidence-status-pill">
                  {evidence.status.label}
                </span>
              )}
            </div>

            {evidenceState.status === 'idle' && (
              <Button
                size="sm"
                variant="outline"
                onClick={(event) => {
                  event.stopPropagation();
                  onLoadEvidence();
                }}
                className="h-7 text-xs"
                data-testid="load-evidence"
              >
                Find trusted sources
              </Button>
            )}

            {evidenceState.status === 'loading' && (
              <div className="evidence-loading" data-testid="evidence-loading">
                <div className="evidence-skeleton evidence-skeleton--w70" />
                <div className="evidence-skeleton evidence-skeleton--w90" />
                <div className="evidence-skeleton evidence-skeleton--w80" />
              </div>
            )}

            {evidenceState.status === 'error' && (
              <div className="evidence-error" data-testid="evidence-error">
                <p>{evidenceState.message}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetryEvidence();
                  }}
                  className="h-7 text-xs"
                >
                  Retry
                </Button>
              </div>
            )}

            {evidence && (
              <div className="evidence-content" data-testid="evidence-content">
                <p className="evidence-reason" data-testid="evidence-status-reason">
                  {evidence.status.reason}
                </p>
                <div className="evidence-meta-row">
                  <span>Confidence: {evidence.status.confidence}</span>
                  <button
                    type="button"
                    className="evidence-refresh-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRetryEvidence();
                    }}
                  >
                    Refresh sources
                  </button>
                </div>

                {!evidence.apiStatus.googleFactCheckConfigured && (
                  <p className="evidence-warning">
                    Google Fact Check key not detected for this extension profile. Add it in
                    Settings under Google Fact Check API key (separate from OpenRouter).
                  </p>
                )}

                {trustedSourceCards.length === 0 ? (
                  <p className="evidence-empty">No trusted sources found for this finding.</p>
                ) : (
                  <div className="evidence-source-list" data-testid="trusted-source-list">
                    {trustedSourceCards.map((item) => (
                      <article key={item.id} className="evidence-source-card">
                        <div className="evidence-source-card-head">
                          <span className="evidence-source-chip">{item.source}</span>
                          {item.verdictCode ? (
                            <span className={verificationPillClass(item.verdictCode)}>
                              {item.verdictLabel || item.verdictCode}
                            </span>
                          ) : item.auxLabel ? (
                            <span className="evidence-source-meta-text">{item.auxLabel}</span>
                          ) : null}
                        </div>
                        <p className="evidence-source-title">{item.title}</p>
                        {item.snippet && <p className="evidence-source-snippet">{item.snippet}</p>}
                        <div className="evidence-source-meta">
                          {item.dateLabel ? <span>{item.dateLabel}</span> : <span />}
                          <a href={item.url} target="_blank" rel="noopener noreferrer" className="evidence-source-link">
                            {item.linkLabel}
                          </a>
                        </div>
                      </article>
                    ))}
                  </div>
                )}

                {evidenceErrors.length > 0 && (
                  <div className="evidence-partial-errors" data-testid="evidence-partial-errors">
                    {evidenceErrors.map(([source, message]) => (
                      <p key={source}>{`${source}: ${message}`}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                               */
/* ------------------------------------------------------------------ */

function App() {
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [hasGoogleFactCheckApiKey, setHasGoogleFactCheckApiKey] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus>({
    state: 'idle',
    progress: 0,
    message: 'Ready to scan the active page.',
    updatedAt: Date.now(),
  });
  const [report, setReport] = useState<ScanReport | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [popupView, setPopupView] = useState<PopupView>('review');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [focusedFindingId, setFocusedFindingId] = useState<string | null>(null);
  const [evidenceByFinding, setEvidenceByFinding] = useState<Record<string, FindingEvidenceState>>({});

  /* ---- data loading ---- */

  const loadStatusAndReport = useCallback(async (tabId: number) => {
    const [status, reportResponse] = await Promise.all([
      sendMessage<ScanStatus>({ type: 'GET_SCAN_STATUS', tabId }),
      getReportWithRetry(tabId),
    ]);
    setScanStatus(
      status ?? { tabId, state: 'idle', progress: 0, message: 'Idle.', updatedAt: Date.now() },
    );
    setReport(reportResponse?.report ?? null);
  }, []);

  const loadFindingEvidence = useCallback(
    async (findingId: string, forceRefresh = false) => {
      if (activeTabId == null) return;

      const currentState = evidenceByFinding[findingId];
      if (!forceRefresh && (currentState?.status === 'loading' || currentState?.status === 'loaded')) {
        return;
      }

      setEvidenceByFinding((prev) => ({ ...prev, [findingId]: { status: 'loading' } }));

      try {
        const response = await sendMessage<EvidenceResponse>({
          type: 'GET_FINDING_EVIDENCE',
          tabId: activeTabId,
          findingId,
          forceRefresh,
        });

        if (!response?.ok || !response.evidence) {
          throw new Error(response?.error || 'Failed to load trusted sources.');
        }

        setEvidenceByFinding((prev) => ({
          ...prev,
          [findingId]: { status: 'loaded', evidence: response.evidence as FindingEvidence },
        }));
      } catch (error) {
        setEvidenceByFinding((prev) => ({
          ...prev,
          [findingId]: {
            status: 'error',
            message: error instanceof Error ? error.message : 'Failed to load trusted sources.',
          },
        }));
      }
    },
    [activeTabId, evidenceByFinding],
  );

  useEffect(() => {
    let cancelled = false;

    async function initializePopup() {
      try {
        const tabParam = new URLSearchParams(window.location.search).get('tabId');
        const forcedTabId = tabParam && /^\d+$/.test(tabParam) ? Number(tabParam) : null;

        const [localStorageState, settings, tabs] = await Promise.all([
          ext.storage.local.get([
            API_KEY_STORAGE_KEY,
            LEGACY_API_KEY_STORAGE_KEY,
            ...GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEYS,
          ]),
          sendMessage<SettingsResponse>({ type: 'GET_SETTINGS' }).catch(() => undefined),
          forcedTabId == null
            ? ext.tabs.query({ active: true, currentWindow: true })
            : Promise.resolve([] as any[]),
        ]);

        if (cancelled) return;

        const storageHasKey =
          (typeof localStorageState?.[API_KEY_STORAGE_KEY] === 'string' &&
            localStorageState[API_KEY_STORAGE_KEY].trim().length > 0) ||
          (typeof localStorageState?.[LEGACY_API_KEY_STORAGE_KEY] === 'string' &&
            localStorageState[LEGACY_API_KEY_STORAGE_KEY].trim().length > 0);
        const storageHasGoogleFactCheckKey =
          GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEYS.some(
            (key) =>
              typeof localStorageState?.[key] === 'string' &&
              localStorageState[key].trim().length > 0,
          );
        setHasApiKey(storageHasKey || Boolean(settings?.hasApiKey));
        setHasGoogleFactCheckApiKey(
          storageHasGoogleFactCheckKey || Boolean(settings?.hasGoogleFactCheckApiKey),
        );

        const currentTabId = forcedTabId ?? tabs[0]?.id ?? null;
        setActiveTabId(currentTabId);
        if (currentTabId != null) {
          await loadStatusAndReport(currentTabId);
          const focusResponse = await getFocusFindingWithRetry(currentTabId).catch(
            () => ({ findingId: null }),
          );
          if (focusResponse.findingId) {
            setFocusedFindingId(focusResponse.findingId);
            setExpandedId(focusResponse.findingId);
            setFilter('all');
          }
        }
      } catch (error) {
        if (cancelled) return;
        setScanStatus({
          state: 'error',
          progress: 1,
          message: error instanceof Error ? error.message : 'Failed to initialize popup state.',
          updatedAt: Date.now(),
        });
      }
    }

    void initializePopup();
    return () => {
      cancelled = true;
    };
  }, [loadStatusAndReport]);

  useEffect(() => {
    if (activeTabId == null || !runningStates.has(scanStatus.state)) return;

    const timer = setInterval(async () => {
      try {
        const status = await sendMessage<ScanStatus>({
          type: 'GET_SCAN_STATUS',
          tabId: activeTabId,
        });
        setScanStatus(status);

        if (!runningStates.has(status.state)) {
          const reportResponse = await sendMessage<ReportResponse>({
            type: 'GET_REPORT',
            tabId: activeTabId,
          }).catch(async () => getReportWithRetry(activeTabId));
          setReport(reportResponse?.report ?? null);
        }
      } catch {
        // Ignore transient polling failures.
      }
    }, 1600);

    return () => clearInterval(timer);
  }, [activeTabId, scanStatus.state]);

  useEffect(() => {
    if (activeTabId == null || report) return;
    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        const [reportResponse, focusResponse] = await Promise.all([
          getReportWithRetry(activeTabId, 18),
          getFocusFindingWithRetry(activeTabId, 12).catch(() => ({ findingId: null })),
        ]);

        if (cancelled) return;
        if (reportResponse?.report) {
          setReport(reportResponse.report);
        }

        if (focusResponse.findingId) {
          setFocusedFindingId(focusResponse.findingId);
          setExpandedId(focusResponse.findingId);
          setFilter('all');
        }
      } catch {
        // Leave empty-state if background remains unavailable.
      }
    }, 450);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeTabId, report]);

  useEffect(() => {
    setEvidenceByFinding({});
  }, [report?.tabId, report?.scannedAt]);

  useEffect(() => {
    if (!focusedFindingId || !report) return;
    const found = report.findings.some((finding) => finding.id === focusedFindingId);
    if (!found) return;

    setFilter('all');
    setExpandedId(focusedFindingId);

    const timer = setTimeout(() => {
      const selector = `[data-finding-id="${CSS.escape(focusedFindingId)}"]`;
      const element = document.querySelector<HTMLElement>(selector);
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);

    return () => clearTimeout(timer);
  }, [focusedFindingId, report]);

  /* ---- actions ---- */

  const startScan = useCallback(async () => {
    if (activeTabId == null) return;

    let keyReady = hasApiKey;
    if (!keyReady) {
      const stored = await ext.storage.local.get([API_KEY_STORAGE_KEY, LEGACY_API_KEY_STORAGE_KEY]);
      keyReady =
        (typeof stored?.[API_KEY_STORAGE_KEY] === 'string' &&
          stored[API_KEY_STORAGE_KEY].trim().length > 0) ||
        (typeof stored?.[LEGACY_API_KEY_STORAGE_KEY] === 'string' &&
          stored[LEGACY_API_KEY_STORAGE_KEY].trim().length > 0);
      if (keyReady) setHasApiKey(true);
      else return;
    }

    try {
      setEvidenceByFinding({});
      setScanStatus({
        tabId: activeTabId,
        state: 'extracting',
        progress: 0.05,
        message: 'Preparing scan...',
        updatedAt: Date.now(),
      });
      await sendMessage<{ ok: boolean; tabId: number }>({ type: 'START_SCAN' });
    } catch (error) {
      setScanStatus({
        tabId: activeTabId,
        state: 'error',
        progress: 1,
        message: error instanceof Error ? error.message : 'Scan failed to start.',
        updatedAt: Date.now(),
      });
    }
  }, [activeTabId, hasApiKey]);

  const jumpToFinding = useCallback(
    async (findingId: string) => {
      if (activeTabId == null) return;
      setFocusedFindingId(findingId);
      await sendMessage<{ ok: boolean }>({
        type: 'JUMP_TO_FINDING',
        tabId: activeTabId,
        findingId,
      });
    },
    [activeTabId],
  );

  /* ---- derived ---- */

  const filteredFindings = useMemo(() => {
    const findings = report?.findings ?? [];
    const filtered = filter === 'all' ? findings : findings.filter((f) => f.issueTypes.includes(filter));
    return sortFindingsForDisplay(filtered, report?.scanKind === 'youtube_video');
  }, [report?.findings, report?.scanKind, filter]);

  const dashboardPayload = useMemo(
    () => buildDashboardPayload(report, scanStatus),
    [report, scanStatus],
  );
  const dashboardSummary = dashboardPayload.summary;
  const dashboardUpdatedLabel = formatDashboardTimestamp(dashboardPayload.generatedAt);
  const confidencePct = Math.round(dashboardSummary.averageConfidence * 100);
  const severityPct = Math.round((dashboardSummary.averageSeverity / 5) * 100);
  const issueBreakdown = useMemo(
    () => [
      { key: 'misinformation', label: 'Misinformation', count: dashboardSummary.misinformationCount },
      { key: 'fallacy', label: 'Fallacies', count: dashboardSummary.fallacyCount },
      { key: 'bias', label: 'Bias Signals', count: dashboardSummary.biasCount },
    ],
    [dashboardSummary.biasCount, dashboardSummary.fallacyCount, dashboardSummary.misinformationCount],
  );
  const issueDenominator = Math.max(1, dashboardSummary.totalFindings);

  const isRunning = runningStates.has(scanStatus.state);
  const totalFindings = report?.summary.totalFindings ?? 0;
  const stepInfo = getStepInfo(scanStatus.state);

  /* ---- render ---- */

  return (
    <div className="popup-shell">
      <div className="paper-grain" aria-hidden />

      {/* ---- Header ---- */}
      <header className="popup-header">
        <div className="flex items-center gap-2.5">
          <div className="header-mark" aria-hidden>
            <Radar className="size-[13px]" />
          </div>
          <div>
            <p className="eyebrow">Signal Desk</p>
            <h1 className="headline">Credibility Review</h1>
          </div>
        </div>
        <SettingsModal
          hasApiKey={hasApiKey}
          hasGoogleFactCheckApiKey={hasGoogleFactCheckApiKey}
          onSaved={(updates) => {
            if (updates.openRouter) setHasApiKey(true);
            if (updates.googleFactCheck) setHasGoogleFactCheckApiKey(true);
          }}
        />
      </header>

      <nav className="popup-view-tabs" aria-label="Popup sections">
        <button
          type="button"
          className={`popup-view-tab ${popupView === 'review' ? 'is-active' : ''}`}
          onClick={() => setPopupView('review')}
          aria-selected={popupView === 'review'}
        >
          Review
        </button>
        <button
          type="button"
          className={`popup-view-tab ${popupView === 'dashboard' ? 'is-active' : ''}`}
          onClick={() => setPopupView('dashboard')}
          aria-selected={popupView === 'dashboard'}
        >
          Dashboard
        </button>
      </nav>

      {popupView === 'review' ? (
        <>
          {/* ---- Scan section ---- */}
          <section className="scan-section">
            <div className="flex items-center gap-3">
              <div className="relative flex items-center justify-center text-primary">
                {isRunning ? (
                  <StepProgressRing
                    current={stepInfo?.current ?? 1}
                    total={stepInfo?.total ?? 3}
                    size={36}
                  />
                ) : (
                  <div className="flex size-9 items-center justify-center rounded-full border border-border/60 bg-background/60">
                    {scanStatus.state === 'done' ? (
                      <ShieldCheck className="size-4 text-emerald-600" />
                    ) : scanStatus.state === 'error' ? (
                      <Gauge className="size-4 text-destructive" />
                    ) : (
                      <Search className="size-4 text-muted-foreground" />
                    )}
                  </div>
                )}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="scan-state-label">{stateLabel(scanStatus.state)}</span>
                </div>
                {stepInfo && (
                  <p data-testid="scan-status" className="text-[11px] text-muted-foreground">
                    {`Step ${stepInfo.current} of ${stepInfo.total}: ${stepInfo.label}`}
                  </p>
                )}
                <p className="scan-message">{scanStatus.message}</p>
              </div>
            </div>

            <div className="scan-actions-grid">
              <Button
                data-testid="start-scan"
                onClick={() => void startScan()}
                disabled={isRunning || activeTabId == null || !hasApiKey}
                className="mt-3 w-full"
                size="sm"
              >
                {isRunning ? (
                  <>
                    <LoaderCircle className="size-3.5 animate-spin" />
                    Scanning...
                  </>
                ) : (
                  <>
                    <Search className="size-3.5" />
                    Scan Active Tab
                  </>
                )}
              </Button>
            </div>

            {!hasApiKey && (
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                Open <Settings className="inline size-3 -translate-y-px" /> settings to add your OpenRouter API key.
              </p>
            )}
          </section>

          {/* ---- Findings ---- */}
          <section className="findings-section">
            {/* Summary counters */}
            <div className="findings-bar">
              <span className="findings-bar-label">
                {totalFindings} {totalFindings === 1 ? 'finding' : 'findings'}
              </span>
              <div className="flex gap-1.5">
                <span className="counter counter--red">
                  {report?.summary.misinformationCount ?? 0}
                </span>
                <span className="counter counter--amber">
                  {report?.summary.fallacyCount ?? 0}
                </span>
                <span className="counter counter--sky">
                  {report?.summary.biasCount ?? 0}
                </span>
              </div>
            </div>

            {/* Filter chips */}
            <div className="mb-2.5 flex gap-1">
              {(['all', 'misinformation', 'fallacy', 'bias'] as FilterKey[]).map((opt) => (
                <button
                  key={opt}
                  onClick={() => setFilter(opt)}
                  className={`filter-chip ${filter === opt ? 'filter-chip--active' : ''}`}
                >
                  {opt === 'all' ? 'All' : labelForType(opt)}
                </button>
              ))}
            </div>

            {/* Findings list */}
            <div className="findings-list">
              {!report ? (
                <div className="empty-state">
                  Run a scan to review the active page for credibility issues.
                </div>
              ) : report.findings.length === 0 ? (
                <div className="empty-state empty-state--ok">
                  <ShieldCheck className="size-4 shrink-0" />
                  No high-confidence issues found.
                </div>
              ) : filteredFindings.length === 0 ? (
                <div className="empty-state">No findings for this filter.</div>
              ) : (
                filteredFindings.map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    isExpanded={expandedId === finding.id}
                    isFocused={focusedFindingId === finding.id}
                    evidenceState={evidenceByFinding[finding.id] ?? { status: 'idle' }}
                    onToggle={() =>
                      setExpandedId((prev) => (prev === finding.id ? null : finding.id))
                    }
                    onJump={() => void jumpToFinding(finding.id)}
                    onLoadEvidence={() => void loadFindingEvidence(finding.id)}
                    onRetryEvidence={() => void loadFindingEvidence(finding.id, true)}
                  />
                ))
              )}
            </div>
          </section>
        </>
      ) : (
        <section className="mini-dashboard-section">
          <div className="mini-dashboard-head">
            <p className="mini-dashboard-title">{dashboardPayload.source.title}</p>
            <p className="mini-dashboard-meta">{dashboardUpdatedLabel}</p>
            {dashboardPayload.source.url && (
              <p className="mini-dashboard-url">{dashboardPayload.source.url}</p>
            )}
          </div>

          <div className="mini-kpi-grid">
            <article className="mini-kpi-card">
              <p className="mini-kpi-label">Total</p>
              <p className="mini-kpi-value">{dashboardSummary.totalFindings}</p>
            </article>
            <article className="mini-kpi-card">
              <p className="mini-kpi-label">Misinfo</p>
              <p className="mini-kpi-value mini-kpi-value--red">{dashboardSummary.misinformationCount}</p>
            </article>
            <article className="mini-kpi-card">
              <p className="mini-kpi-label">Fallacies</p>
              <p className="mini-kpi-value mini-kpi-value--amber">{dashboardSummary.fallacyCount}</p>
            </article>
            <article className="mini-kpi-card">
              <p className="mini-kpi-label">Bias</p>
              <p className="mini-kpi-value mini-kpi-value--blue">{dashboardSummary.biasCount}</p>
            </article>
          </div>

          <div className="mini-quality-grid">
            <div>
              <div className="mini-quality-row">
                <span>Confidence</span>
                <span>{confidencePct}%</span>
              </div>
              <div className="mini-meter-track">
                <div className="mini-meter-fill mini-meter-fill--blue" style={{ width: `${confidencePct}%` }} />
              </div>
            </div>
            <div>
              <div className="mini-quality-row">
                <span>Severity</span>
                <span>{dashboardSummary.averageSeverity.toFixed(1)}/5</span>
              </div>
              <div className="mini-meter-track">
                <div className="mini-meter-fill mini-meter-fill--amber" style={{ width: `${severityPct}%` }} />
              </div>
            </div>
          </div>

          <div className="mini-issue-list">
            {issueBreakdown.map((row) => {
              const pct = Math.round((row.count / issueDenominator) * 100);
              return (
                <div key={row.key}>
                  <div className="mini-quality-row">
                    <span>{row.label}</span>
                    <span>{row.count}</span>
                  </div>
                  <div className="mini-meter-track">
                    <div className="mini-meter-fill mini-meter-fill--neutral" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mini-flagged-head">Flagged Snippets</div>
          <div className="mini-flagged-list">
            {dashboardPayload.findings.length === 0 ? (
              <div className="empty-state empty-state--ok">
                <ShieldCheck className="size-4 shrink-0" />
                No high-confidence issues found.
              </div>
            ) : (
              dashboardPayload.findings.slice(0, 8).map((finding, index) => (
                <article key={`${finding.quote}-${index}`} className="mini-flagged-item">
                  <p className="mini-flagged-quote">{finding.quote}</p>
                  <div className="mini-flagged-meta">
                    <div className="mini-tag-row">
                      {finding.issueTypes.map((issue) => (
                        <span key={`${finding.quote}-${issue}`} className={`mini-tag mini-tag--${issue}`}>
                          {labelForType(issue)}
                        </span>
                      ))}
                    </div>
                    <span>{Math.round(finding.confidence * 100)}%</span>
                    <span>{finding.severity}/5</span>
                  </div>
                  <p className="mini-flagged-rationale">{finding.rationale}</p>
                </article>
              ))
            )}
          </div>
        </section>
      )}
    </div>
  );
}

export default App;

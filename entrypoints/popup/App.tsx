import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  Gauge,
  KeyRound,
  LoaderCircle,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react';

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
  CorroborationItem,
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

type ReportResponse = { report: ScanReport | null };
type SettingsResponse = { hasApiKey: boolean; hasGoogleFactCheckApiKey?: boolean };
type FocusResponse = { findingId: string | null };
type EvidenceResponse = {
  ok: boolean;
  evidence?: FindingEvidence;
  error?: string;
};
type FilterKey = 'all' | IssueType;
type FindingEvidenceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; evidence: FindingEvidence }
  | { status: 'error'; message: string };

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
  if (issue === 'misinformation') return 'issue-badge--misinfo';
  if (issue === 'fallacy') return 'issue-badge--fallacy';
  return 'issue-badge--bias';
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

function renderCorroborationRows(rows: CorroborationItem[]) {
  return rows.map((item) => (
    <article key={`${item.source}-${item.url}`} className="evidence-source-card">
      <div className="evidence-source-card-head">
        <span className="evidence-source-chip">{item.source}</span>
      </div>
      <p className="evidence-source-title">{item.title}</p>
      {item.snippet && <p className="evidence-source-snippet">{item.snippet}</p>}
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="evidence-source-link">
        Open source
      </a>
    </article>
  ));
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

function isYouTubeTabUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      return false;
    }
    return parsed.pathname === '/watch' && Boolean(parsed.searchParams.get('v'));
  } catch {
    return false;
  }
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
/*  Finding details + cards                                           */
/* ------------------------------------------------------------------ */

function FindingDetailBody({
  finding,
  evidenceState,
  onJump,
  onLoadEvidence,
  onRetryEvidence,
  stopPropagation = false,
  layout = 'default',
}: {
  finding: Finding;
  evidenceState: FindingEvidenceState;
  onJump: () => void;
  onLoadEvidence: () => void;
  onRetryEvidence: () => void;
  stopPropagation?: boolean;
  layout?: 'default' | 'split';
}) {
  const evidence = evidenceState.status === 'loaded' ? evidenceState.evidence : null;
  const evidenceErrors: Array<[string, string]> = [];
  const comparisonLabel = finding.subtype?.trim() || null;
  if (evidence) {
    for (const [source, message] of Object.entries(evidence.errors)) {
      if (typeof message === 'string' && message.trim()) {
        evidenceErrors.push([source, message]);
      }
    }
  }

  return (
    <>
      {/* Severity / confidence bar */}
      <div className="detail-meta-row">
        <span className="detail-meta-item">
          <span className="inline-block size-1.5 rounded-full bg-current opacity-50" />
          Confidence {Math.round(finding.confidence * 100)}%
        </span>
        <span className="detail-meta-item">
          <span className="inline-block size-1.5 rounded-full bg-current opacity-50" />
          Severity {finding.severity}/5
        </span>
      </div>

      <div className="finding-top-actions">
        {comparisonLabel && (
          <span className="finding-category-pill">
            {comparisonLabel}
          </span>
        )}
        <button
          type="button"
          data-testid="jump-to-highlight"
          onClick={(event) => {
            if (stopPropagation) event.stopPropagation();
            onJump();
          }}
          className="finding-jump-inline"
        >
          Jump to highlight
        </button>
      </div>

      {/* Rationale */}
      <div className="mb-2.5">
        <p className="section-label">
          Why this was flagged
        </p>
        <p data-testid="finding-rationale" className="detail-text">
          {finding.rationale}
        </p>
      </div>

      {/* Correction */}
      {finding.correction && (
        <div className="corr-box">
          <p className="corr-title">
            Correction
          </p>
          <p className="corr-text">
            {finding.correction}
          </p>
        </div>
      )}

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
                    if (stopPropagation) event.stopPropagation();
                    onLoadEvidence();
                  }}
                  className="h-7 text-xs"
                data-testid="load-evidence"
              >
                Load trusted sources
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
                    if (stopPropagation) event.stopPropagation();
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
                      if (stopPropagation) event.stopPropagation();
                      onRetryEvidence();
                    }}
                  >
                    Refresh sources
                  </button>
                </div>

                {!evidence.apiStatus.googleFactCheckConfigured && (
                  <p className="evidence-warning">
                    Google Fact Check API key is not configured in Settings.
                  </p>
                )}

                <div className="evidence-section">
                  <h4>Fact-check matches</h4>
                  {evidence.factChecks.length === 0 ? (
                    <p className="evidence-empty">No direct ClaimReview match found.</p>
                  ) : (
                    <div className="evidence-source-list" data-testid="factcheck-list">
                      {evidence.factChecks.map((match) => (
                        <article key={`${match.reviewUrl}-${match.publisher}`} className="evidence-source-card">
                          <div className="evidence-source-card-head">
                            <span className="evidence-source-chip">{match.publisher}</span>
                            <span className={verificationPillClass(
                              match.normalizedVerdict === 'unknown' ? 'unverified' : match.normalizedVerdict,
                            )}>
                              {match.textualRating || match.normalizedVerdict}
                            </span>
                          </div>
                          <p className="evidence-source-title">{match.reviewTitle}</p>
                          {match.claimText && (
                            <p className="evidence-source-snippet">Claim: {match.claimText}</p>
                          )}
                          <div className="evidence-source-meta">
                            {match.reviewDate && <span>{formatEvidenceDate(match.reviewDate)}</span>}
                            {match.reviewUrl && (
                              <a
                                href={match.reviewUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="evidence-source-link"
                              >
                                Open fact-check
                              </a>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </div>

                <div className="evidence-section">
                  <h4>Corroboration sources</h4>
                  {evidence.corroboration.wikipedia.length === 0 &&
                  evidence.corroboration.wikidata.length === 0 &&
                  evidence.corroboration.pubmed.length === 0 ? (
                    <p className="evidence-empty">No corroboration sources found.</p>
                  ) : (
                    <div className="evidence-source-list" data-testid="corroboration-list">
                      {renderCorroborationRows(evidence.corroboration.wikipedia)}
                      {renderCorroborationRows(evidence.corroboration.wikidata)}
                      {renderCorroborationRows(evidence.corroboration.pubmed)}
                    </div>
                  )}
                </div>

                <div className="evidence-section">
                  <h4>Related reporting (GDELT)</h4>
                  {evidence.gdeltArticles.length === 0 ? (
                    <p className="evidence-empty">No related GDELT articles found.</p>
                  ) : (
                    <div className="evidence-source-list" data-testid="gdelt-list">
                      {evidence.gdeltArticles.map((article) => (
                        <article key={article.url} className="evidence-source-card">
                          <div className="evidence-source-card-head">
                            <span className="evidence-source-chip">{article.domain}</span>
                            {typeof article.tone === 'number' && (
                              <span className="evidence-source-meta-text">
                                Tone {article.tone > 0 ? '+' : ''}
                                {article.tone.toFixed(1)}
                              </span>
                            )}
                          </div>
                          <p className="evidence-source-title">{article.title}</p>
                          <div className="evidence-source-meta">
                            {article.seenDate && <span>{formatEvidenceDate(article.seenDate)}</span>}
                            <a href={article.url} target="_blank" rel="noopener noreferrer" className="evidence-source-link">
                              Open article
                            </a>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </div>

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
    </>
  );
}

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
  return (
    <article
      data-testid="finding-card"
      data-finding-id={finding.id}
      data-focused={isFocused ? 'true' : 'false'}
      className="finding-card"
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
                className={`issue-badge ${issueColor(t)}`}
              >
                {labelForType(t)}
              </span>
            ))}
          </div>
          <p className="finding-summary-quote">
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
          <FindingDetailBody
            finding={finding}
            evidenceState={evidenceState}
            onJump={onJump}
            onLoadEvidence={onLoadEvidence}
            onRetryEvidence={onRetryEvidence}
            stopPropagation
          />
        </div>
      </div>
    </article>
  );
}

function SplitFindingDetail({
  finding,
  isFocused,
  evidenceState,
  onJump,
  onLoadEvidence,
  onRetryEvidence,
}: {
  finding: Finding;
  isFocused: boolean;
  evidenceState: FindingEvidenceState;
  onJump: () => void;
  onLoadEvidence: () => void;
  onRetryEvidence: () => void;
}) {
  return (
    <article
      data-testid="finding-card"
      data-finding-id={finding.id}
      data-focused={isFocused ? 'true' : 'false'}
      className="screen6-detail-card"
    >
      <div className="screen6-claim-card">
        <div className="screen6-detail-head">
          <div className="mt-0.5 flex shrink-0 flex-wrap gap-1">
            {finding.issueTypes.map((issue) => (
              <span
                key={`${finding.id}-${issue}`}
                className={`issue-badge ${issueColor(issue)}`}
              >
                {labelForType(issue)}
              </span>
            ))}
          </div>
        </div>
        <p className="screen6-detail-quote">{formatQuoteForDisplay(finding.quote)}</p>
      </div>

      <div className="screen6-detail-content">
        <FindingDetailBody
          finding={finding}
          evidenceState={evidenceState}
          onJump={onJump}
          onLoadEvidence={onLoadEvidence}
          onRetryEvidence={onRetryEvidence}
          layout="split"
        />
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                               */
/* ------------------------------------------------------------------ */

function App() {
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [activeTabUrl, setActiveTabUrl] = useState<string | null>(null);
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [focusedFindingId, setFocusedFindingId] = useState<string | null>(null);
  const [appliedFocusFindingId, setAppliedFocusFindingId] = useState<string | null>(null);
  const [activeFindingId, setActiveFindingId] = useState<string | null>(null);
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
            GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEY,
          ]),
          sendMessage<SettingsResponse>({ type: 'GET_SETTINGS' }).catch(() => undefined),
          forcedTabId == null
            ? ext.tabs.query({ active: true, lastFocusedWindow: true })
            : Promise.resolve([] as any[]),
        ]);

        if (cancelled) return;

        const storageHasKey =
          (typeof localStorageState?.[API_KEY_STORAGE_KEY] === 'string' &&
            localStorageState[API_KEY_STORAGE_KEY].trim().length > 0) ||
          (typeof localStorageState?.[LEGACY_API_KEY_STORAGE_KEY] === 'string' &&
            localStorageState[LEGACY_API_KEY_STORAGE_KEY].trim().length > 0);
        const storageHasGoogleFactCheckKey =
          typeof localStorageState?.[GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEY] === 'string' &&
          localStorageState[GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEY].trim().length > 0;
        setHasApiKey(storageHasKey || Boolean(settings?.hasApiKey));
        setHasGoogleFactCheckApiKey(
          storageHasGoogleFactCheckKey || Boolean(settings?.hasGoogleFactCheckApiKey),
        );

        const currentTabId = forcedTabId ?? tabs[0]?.id ?? null;
        setActiveTabId(currentTabId);
        const resolvedTabUrl =
          typeof tabs[0]?.url === 'string'
            ? tabs[0].url
            : currentTabId != null
              ? await ext.tabs.get(currentTabId).then((tab) => tab?.url ?? null).catch(() => null)
              : null;
        setActiveTabUrl(resolvedTabUrl);
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
    if (appliedFocusFindingId === focusedFindingId) return;
    const found = report.findings.some((finding) => finding.id === focusedFindingId);
    if (!found) return;

    setFilter('all');
    setActiveFindingId(focusedFindingId);
    setExpandedId(focusedFindingId);
    setAppliedFocusFindingId(focusedFindingId);

    const timer = setTimeout(() => {
      const selector = `[data-finding-id="${CSS.escape(focusedFindingId)}"]`;
      const element = document.querySelector<HTMLElement>(selector);
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);

    return () => clearTimeout(timer);
  }, [appliedFocusFindingId, focusedFindingId, report]);

  useEffect(() => {
    if (!expandedId) return;
    void loadFindingEvidence(expandedId);
  }, [expandedId, loadFindingEvidence]);

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

  const isRunning = runningStates.has(scanStatus.state);
  const totalFindings = report?.summary.totalFindings ?? 0;
  const stepInfo = getStepInfo(scanStatus.state);
  const isYoutubeMode =
    report?.scanKind === 'youtube_video' ||
    isYouTubeTabUrl(report?.url ?? activeTabUrl);
  const webViewMode: 'initial' | 'scanning' | 'scanned' = isRunning
    ? 'scanning'
    : report
      ? 'scanned'
      : 'initial';

  const webStepIndex = scanStatus.state === 'analyzing'
    ? 1
    : scanStatus.state === 'highlighting'
      ? 2
      : 0;
  const webStepCurrent = Math.min(webStepIndex + 1, 3);
  const webScanSteps = [
    {
      label: 'DOM content capture',
      state: webStepIndex > 0 ? 'done' : 'running',
    },
    {
      label: 'Misinformation confidence scoring',
      state: webStepIndex > 1 ? 'done' : webStepIndex === 1 ? 'running' : 'queued',
    },
    {
      label: 'Correction draft generation',
      state: webStepIndex === 2 ? 'running' : 'queued',
    },
  ] as const;

  const activeFinding = filteredFindings.find((finding) => finding.id === activeFindingId) ?? null;

  useEffect(() => {
    if (filteredFindings.length === 0) {
      setActiveFindingId(null);
      return;
    }

    if (
      activeFindingId == null &&
      focusedFindingId &&
      filteredFindings.some((finding) => finding.id === focusedFindingId)
    ) {
      setActiveFindingId((prev) => (prev === focusedFindingId ? prev : focusedFindingId));
      return;
    }

    const hasSelected =
      activeFindingId != null && filteredFindings.some((finding) => finding.id === activeFindingId);
    if (!hasSelected) {
      setActiveFindingId(filteredFindings[0].id);
    }
  }, [activeFindingId, filteredFindings, focusedFindingId]);

  useEffect(() => {
    if (webViewMode !== 'scanned' || !activeFindingId) return;
    void loadFindingEvidence(activeFindingId);
  }, [activeFindingId, loadFindingEvidence, webViewMode]);

  /* ---- render ---- */

  return (
    <div className="popup-shell popup-shell--web">
      <div className="paper-grain" aria-hidden />

      {/* ---- Header ---- */}
      <header className="popup-header">
        <div className="flex items-center gap-2.5">
          <div className="header-mark" aria-hidden>
            <img src="/clarity-logo.svg" alt="" className="header-logo" />
          </div>
          <div>
            <h1 className="headline">Clarity</h1>
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

      {webViewMode === 'initial' ? (
        <section className="screen14">
          <div className="screen14-card">
            <div>
              <p className="screen14-title">Scan</p>
              <p className="screen14-sub">
                {scanStatus.state === 'error'
                  ? scanStatus.message
                  : 'Start a scan for the active tab to detect misleading claims and bias.'}
              </p>
            </div>
            <Button
              data-testid="start-scan"
              onClick={() => void startScan()}
              disabled={activeTabId == null || !hasApiKey}
              className="screen14-action"
              size="sm"
            >
              <Search className="size-3.5" />
              Scan Tab
            </Button>
            {!hasApiKey && (
              <p className="screen14-note">
                Open <Settings className="inline size-3 -translate-y-px" /> settings to add your OpenRouter API key.
              </p>
            )}
          </div>
        </section>
      ) : webViewMode === 'scanning' ? (
        <section className="screen13">
          <div className="screen13-card">
            <div className="screen13-top">
              <div>
                <p className="screen13-status">Website analysis</p>
                <h2 className="screen13-headline">Scanning claims and building findings...</h2>
              </div>
              <span className="screen13-ring" aria-hidden />
            </div>

            <div className="screen13-meter-row">
              <span>Progress</span>
              <span data-testid="scan-status">{`Step ${webStepCurrent} / 3`}</span>
            </div>
            <div className="screen13-track">
              <div className="screen13-fill" style={{ width: `${(webStepCurrent / 3) * 100}%` }} />
            </div>

            <div className="screen13-steps">
              {webScanSteps.map((step) => (
                <div key={step.label} className={`screen13-step screen13-step--${step.state}`}>
                  <p className="screen13-step-label">
                    <span className={`screen13-step-dot screen13-step-dot--${step.state}`} />
                    {step.label}
                  </p>
                  <span className="screen13-step-state">{step.state}</span>
                </div>
              ))}
            </div>

            <p className="screen13-message">{scanStatus.message}</p>
          </div>
        </section>
      ) : (
        <section className="screen6">
          <div className="screen6-filter-row">
            {(['all', 'misinformation', 'fallacy', 'bias'] as FilterKey[]).map((opt) => {
              const count = opt === 'all'
                ? totalFindings
                : opt === 'misinformation'
                  ? (report?.summary.misinformationCount ?? 0)
                  : opt === 'fallacy'
                    ? (report?.summary.fallacyCount ?? 0)
                    : (report?.summary.biasCount ?? 0);

              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    setFilter(opt);
                  }}
                  className={`screen6-filter-tab ${filter === opt ? 'screen6-filter-tab--active' : ''}`}
                >
                  {opt === 'all' ? 'All' : labelForType(opt)}
                  <strong>{count}</strong>
                </button>
              );
            })}
          </div>

          <div className="screen6-body">
            <aside className="screen6-list">
              {!report ? (
                <div className="empty-state">Run a scan to review this tab.</div>
              ) : report.findings.length === 0 ? (
                <div className="empty-state empty-state--ok">
                  <ShieldCheck className="size-4 shrink-0" />
                  No high-confidence issues found.
                </div>
              ) : filteredFindings.length === 0 ? (
                <div className="empty-state">No findings for this filter.</div>
              ) : (
                filteredFindings.map((finding) => (
                  <button
                    key={finding.id}
                    type="button"
                    className={`screen6-list-item ${activeFinding?.id === finding.id ? 'screen6-list-item--active' : ''}`}
                    onClick={() => {
                      setActiveFindingId(finding.id);
                    }}
                  >
                    <div className="screen6-list-item-head">
                      <div className="mt-0.5 flex shrink-0 flex-wrap gap-1">
                        {finding.issueTypes.map((issue) => (
                          <span
                            key={`${finding.id}-${issue}`}
                            className={`issue-badge ${issueColor(issue)}`}
                          >
                            {labelForType(issue)}
                          </span>
                        ))}
                      </div>
                    </div>
                    <p className="screen6-list-item-quote">{formatQuoteForDisplay(finding.quote)}</p>
                  </button>
                ))
              )}
            </aside>

            <div className="screen6-detail">
              {activeFinding ? (
                <SplitFindingDetail
                  key={activeFinding.id}
                  finding={activeFinding}
                  isFocused={focusedFindingId === activeFinding.id}
                  evidenceState={evidenceByFinding[activeFinding.id] ?? { status: 'idle' }}
                  onJump={() => void jumpToFinding(activeFinding.id)}
                  onLoadEvidence={() => void loadFindingEvidence(activeFinding.id)}
                  onRetryEvidence={() => void loadFindingEvidence(activeFinding.id, true)}
                />
              ) : (
                <div className="empty-state">Select a finding to inspect details.</div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export default App;

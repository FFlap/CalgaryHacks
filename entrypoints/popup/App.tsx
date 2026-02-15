import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ExternalLink,
  Gauge,
  KeyRound,
  Link2,
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
import type { Finding, IssueType, RuntimeRequest, ScanReport, ScanStatus } from '@/lib/types';

/* ------------------------------------------------------------------ */
/*  Extension runtime bridge                                          */
/* ------------------------------------------------------------------ */

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;
const API_KEY_STORAGE_KEY = 'gemini_api_key';

type ReportResponse = { report: ScanReport | null };
type SettingsResponse = { hasApiKey: boolean };
type FocusResponse = { findingId: string | null };
type FilterKey = 'all' | IssueType;

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
    return { hasApiKey: false } as T;
  }

  if (message.type === 'GET_REPORT') {
    return { report: null } as T;
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

function stateLabel(state: ScanStatus['state']) {
  if (state === 'extracting') return 'Extracting';
  if (state === 'analyzing') return 'Analyzing';
  if (state === 'highlighting') return 'Highlighting';
  if (state === 'done') return 'Complete';
  if (state === 'error') return 'Error';
  return 'Ready';
}

/* ------------------------------------------------------------------ */
/*  Settings Modal                                                    */
/* ------------------------------------------------------------------ */

function SettingsModal({
  hasApiKey,
  onSaved,
}: {
  hasApiKey: boolean;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const save = useCallback(async () => {
    if (!apiKey.trim()) {
      setMessage('Please enter a valid API key.');
      return;
    }

    setIsSaving(true);
    try {
      const trimmed = apiKey.trim();
      await ext.storage.local.set({ [API_KEY_STORAGE_KEY]: trimmed });
      await sendMessage<{ ok: boolean; hasApiKey: boolean }>({
        type: 'SAVE_API_KEY',
        apiKey: trimmed,
      }).catch(() => undefined);
      setMessage('Saved successfully.');
      setApiKey('');
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setIsSaving(false);
    }
  }, [apiKey, onSaved]);

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
            Gemini API Key
          </DialogTitle>
          <DialogDescription>
            Stored locally in your browser. Never leaves this device.
          </DialogDescription>
        </DialogHeader>

        {hasApiKey && (
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-emerald-50/80 px-3 py-2 text-xs text-emerald-700 border border-emerald-200/60">
            <ShieldCheck className="size-3.5 shrink-0" />
            API key is configured and active.
          </div>
        )}

        <div className="flex gap-2">
          <Input
            ref={inputRef}
            data-testid="api-key-input"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setMessage('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
            placeholder={hasApiKey ? 'Enter new key to replace…' : 'Paste your Gemini API key'}
            className="font-mono text-xs"
          />
          <Button
            data-testid="save-api-key"
            onClick={() => void save()}
            disabled={isSaving || !apiKey.trim()}
            className="shrink-0"
            size="sm"
          >
            {isSaving ? <LoaderCircle className="size-3.5 animate-spin" /> : 'Save'}
          </Button>
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
  onToggle,
  onJump,
}: {
  finding: Finding;
  isExpanded: boolean;
  isFocused: boolean;
  onToggle: () => void;
  onJump: () => void;
}) {
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
            "{finding.quote}"
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

          {/* Citations */}
          {finding.citations.length > 0 && (
            <ul className="mb-2.5 space-y-1">
              {finding.citations.map((c) => (
                <li key={`${finding.id}-${c.url}`}>
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
                  >
                    <Link2 className="size-3 shrink-0" />
                    {c.title}
                    <ExternalLink className="size-2.5 opacity-40" />
                  </a>
                </li>
              ))}
            </ul>
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
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/*  Progress ring                                                     */
/* ------------------------------------------------------------------ */

function ProgressRing({ progress, size = 32 }: { progress: number; size?: number }) {
  const r = (size - 4) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(progress, 1));

  return (
    <svg width={size} height={size} className="progress-ring">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        opacity={0.12}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        className="transition-[stroke-dashoffset] duration-500"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                               */
/* ------------------------------------------------------------------ */

function App() {
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
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

  /* ---- data loading ---- */

  const loadStatusAndReport = useCallback(async (tabId: number) => {
    const [status, reportResponse] = await Promise.all([
      sendMessage<ScanStatus>({ type: 'GET_SCAN_STATUS', tabId }),
      sendMessage<ReportResponse>({ type: 'GET_REPORT', tabId }),
    ]);
    setScanStatus(
      status ?? { tabId, state: 'idle', progress: 0, message: 'Idle.', updatedAt: Date.now() },
    );
    setReport(reportResponse?.report ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function initializePopup() {
      try {
        const [localStorageState, settings, tabs] = await Promise.all([
          ext.storage.local.get(API_KEY_STORAGE_KEY),
          sendMessage<SettingsResponse>({ type: 'GET_SETTINGS' }).catch(() => undefined),
          ext.tabs.query({ active: true, currentWindow: true }),
        ]);

        if (cancelled) return;

        const storageHasKey =
          typeof localStorageState?.[API_KEY_STORAGE_KEY] === 'string' &&
          localStorageState[API_KEY_STORAGE_KEY].trim().length > 0;
        setHasApiKey(storageHasKey || Boolean(settings?.hasApiKey));

        const currentTabId = tabs[0]?.id ?? null;
        setActiveTabId(currentTabId);
        if (currentTabId != null) {
          await loadStatusAndReport(currentTabId);
          const focusResponse = await sendMessage<FocusResponse>({
            type: 'GET_FOCUS_FINDING',
            tabId: currentTabId,
          }).catch(() => ({ findingId: null }));
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
          });
          setReport(reportResponse?.report ?? null);
        }
      } catch {
        // Ignore transient polling failures.
      }
    }, 1600);

    return () => clearInterval(timer);
  }, [activeTabId, scanStatus.state]);

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
      const stored = await ext.storage.local.get(API_KEY_STORAGE_KEY);
      keyReady =
        typeof stored?.[API_KEY_STORAGE_KEY] === 'string' &&
        stored[API_KEY_STORAGE_KEY].trim().length > 0;
      if (keyReady) setHasApiKey(true);
      else return;
    }

    try {
      setScanStatus({
        tabId: activeTabId,
        state: 'extracting',
        progress: 0.05,
        message: 'Preparing scan\u2026',
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
      window.close();
    },
    [activeTabId],
  );

  /* ---- derived ---- */

  const filteredFindings = useMemo(() => {
    const findings = report?.findings ?? [];
    if (filter === 'all') return findings;
    return findings.filter((f) => f.issueTypes.includes(filter));
  }, [report?.findings, filter]);

  const isRunning = runningStates.has(scanStatus.state);
  const totalFindings = report?.summary.totalFindings ?? 0;

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
          onSaved={() => setHasApiKey(true)}
        />
      </header>

      {/* ---- Scan section ---- */}
      <section className="scan-section">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center text-primary">
            {isRunning ? (
              <ProgressRing progress={scanStatus.progress} size={36} />
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
              {isRunning && (
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {Math.round(scanStatus.progress * 100)}%
                </span>
              )}
            </div>
            <p className="scan-message">{scanStatus.message}</p>
          </div>
        </div>

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
              Scanning\u2026
            </>
          ) : (
            <>
              <Search className="size-3.5" />
              Scan Active Tab
            </>
          )}
        </Button>

        {!hasApiKey && (
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            Open <Settings className="inline size-3 -translate-y-px" /> settings to add your Gemini API key.
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
                onToggle={() =>
                  setExpandedId((prev) => (prev === finding.id ? null : finding.id))
                }
                onJump={() => void jumpToFinding(finding.id)}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

export default App;

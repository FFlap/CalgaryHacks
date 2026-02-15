export type ScanState =
  | 'idle'
  | 'extracting'
  | 'analyzing'
  | 'highlighting'
  | 'done'
  | 'error';

export type IssueType = 'misinformation' | 'fallacy' | 'bias';
export type VerificationCode = 'supported' | 'contradicted' | 'contested' | 'unverified';
export type NormalizedVerdict = 'supported' | 'contradicted' | 'contested' | 'unknown';
export type CorroborationSource = 'Wikipedia' | 'Wikidata' | 'PubMed';

export interface VerificationStatus {
  code: VerificationCode;
  label: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface FactCheckMatch {
  claimText: string;
  claimant?: string;
  publisher: string;
  reviewTitle: string;
  textualRating?: string;
  reviewUrl: string;
  reviewDate?: string;
  languageCode?: string;
  normalizedVerdict: NormalizedVerdict;
  sourceType: 'Google Fact Check API';
}

export interface CorroborationItem {
  title: string;
  snippet: string;
  url: string;
  source: CorroborationSource;
}

export interface GdeltArticle {
  title: string;
  url: string;
  domain: string;
  tone?: number;
  seenDate?: string;
  language?: string;
}

export interface EvidenceErrors {
  factChecks?: string;
  wikipedia?: string;
  wikidata?: string;
  pubmed?: string;
  gdelt?: string;
}

export interface FindingEvidence {
  tabId: number;
  findingId: string;
  findingQuote: string;
  query: string;
  generatedAt: string;
  status: VerificationStatus;
  factChecks: FactCheckMatch[];
  corroboration: {
    wikipedia: CorroborationItem[];
    wikidata: CorroborationItem[];
    pubmed: CorroborationItem[];
  };
  gdeltArticles: GdeltArticle[];
  apiStatus: {
    googleFactCheckConfigured: boolean;
  };
  errors: EvidenceErrors;
}

export interface TranscriptSegment {
  id: string;
  startSec: number;
  startLabel: string;
  text: string;
}

export interface TranscriptPayload {
  source: 'youtube_api';
  segments: TranscriptSegment[];
  unavailableReason?: string;
}

export interface Finding {
  id: string;
  quote: string;
  issueTypes: IssueType[];
  subtype?: string;
  confidence: number;
  severity: number;
  rationale: string;
  correction?: string;
  timestampSec?: number;
  timestampLabel?: string;
  highlightApplied?: boolean;
}

export interface ScanSummary {
  totalFindings: number;
  misinformationCount: number;
  fallacyCount: number;
  biasCount: number;
}

export interface ScanReport {
  tabId: number;
  url: string;
  title: string;
  scanKind?: 'webpage' | 'youtube_video';
  videoId?: string;
  transcript?: TranscriptPayload;
  scannedAt: string;
  summary: ScanSummary;
  findings: Finding[];
  truncated: boolean;
  analyzedChars: number;
}

export interface ScanStatus {
  tabId?: number;
  state: ScanState;
  progress: number;
  message: string;
  updatedAt: number;
  errorCode?: string;
}

export interface YouTubeTranscriptExtractionResult {
  ok: boolean;
  source?: 'youtube_api';
  segments?: TranscriptSegment[];
  reason?: string;
}

export type RuntimeRequest =
  | { type: 'SAVE_API_KEY'; apiKey: string }
  | { type: 'SAVE_GOOGLE_FACT_CHECK_API_KEY'; apiKey: string }
  | { type: 'GET_SETTINGS' }
  | { type: 'START_SCAN'; tabId?: number }
  | { type: 'GET_EMBEDDED_PANEL_STATE' }
  | { type: 'GET_SCAN_STATUS'; tabId?: number }
  | { type: 'GET_REPORT'; tabId: number }
  | { type: 'GET_FINDING_EVIDENCE'; tabId: number; findingId: string; forceRefresh?: boolean }
  | { type: 'GET_FOCUS_FINDING'; tabId: number }
  | { type: 'OPEN_POPUP_FOR_FINDING'; findingId: string; tabId?: number }
  | { type: 'JUMP_TO_FINDING'; tabId: number; findingId: string }
  | { type: 'CLEAR_HIGHLIGHTS'; tabId: number }
  | { type: 'GET_TRANSCRIPT'; videoId: string; tabId?: number };

export interface ExtractionResult {
  url: string;
  title: string;
  lang: string;
  text: string;
  charCount: number;
}

export interface CandidateClaim {
  quote: string;
  issueHints: IssueType[];
  subtypeHint?: string;
  timestampLabel?: string;
  reason?: string;
}

export interface RawFinding {
  quote: string;
  issueTypes: IssueType[];
  subtype?: string;
  confidence: number;
  severity: number;
  rationale: string;
  correction?: string;
  timestampLabel?: string;
}

export interface EmbeddedPanelUpdate {
  type: 'EMBEDDED_PANEL_UPDATE';
  tabId: number;
  status: ScanStatus;
  report: ScanReport | null;
}

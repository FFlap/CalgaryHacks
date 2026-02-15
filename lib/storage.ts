import type { FindingEvidence, ScanReport } from '@/lib/types';

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
const REPORT_PREFIX = 'scan_report_';
const EVIDENCE_PREFIX = 'finding_evidence_';

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

export async function saveApiKey(apiKey: string): Promise<void> {
  await ext.storage.local.set({
    [API_KEY_STORAGE_KEY]: apiKey,
    [LEGACY_API_KEY_STORAGE_KEY]: apiKey,
  });
}

export async function getApiKey(): Promise<string | null> {
  const stored = await ext.storage.local.get([API_KEY_STORAGE_KEY, LEGACY_API_KEY_STORAGE_KEY]);
  const value = stored[API_KEY_STORAGE_KEY] ?? stored[LEGACY_API_KEY_STORAGE_KEY];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export async function hasApiKey(): Promise<boolean> {
  return (await getApiKey()) !== null;
}

export async function saveGoogleFactCheckApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  await ext.storage.local.set({
    [GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEY]: trimmed,
    ...Object.fromEntries(
      LEGACY_GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEYS.map((key) => [key, trimmed]),
    ),
  });
}

export async function getGoogleFactCheckApiKey(): Promise<string | null> {
  const localStored = await ext.storage.local.get([...GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEYS]);
  for (const key of GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEYS) {
    const value = localStored[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      if (key !== GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEY) {
        await ext.storage.local.set({
          [GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEY]: value.trim(),
        });
      }
      return value.trim();
    }
  }

  // Older builds may have used sync storage; keep compatibility.
  const syncStored = await ext.storage.sync.get([...GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEYS]);
  for (const key of GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEYS) {
    const value = syncStored[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      await ext.storage.local.set({
        [GOOGLE_FACT_CHECK_API_KEY_STORAGE_KEY]: value.trim(),
      });
      return value.trim();
    }
  }

  return null;
}

export async function hasGoogleFactCheckApiKey(): Promise<boolean> {
  return (await getGoogleFactCheckApiKey()) !== null;
}

export async function saveReport(tabId: number, report: ScanReport): Promise<void> {
  await ext.storage.local.set({ [`${REPORT_PREFIX}${tabId}`]: report });
}

export async function getReport(tabId: number): Promise<ScanReport | null> {
  const stored = await ext.storage.local.get(`${REPORT_PREFIX}${tabId}`);
  const value = stored[`${REPORT_PREFIX}${tabId}`];
  if (value && typeof value === 'object') {
    return value as ScanReport;
  }
  return null;
}

function evidenceKey(tabId: number, findingId: string): string {
  return `${EVIDENCE_PREFIX}${tabId}_${findingId}`;
}

export async function saveFindingEvidence(
  tabId: number,
  findingId: string,
  evidence: FindingEvidence,
): Promise<void> {
  await ext.storage.local.set({ [evidenceKey(tabId, findingId)]: evidence });
}

export async function getFindingEvidence(
  tabId: number,
  findingId: string,
): Promise<FindingEvidence | null> {
  const key = evidenceKey(tabId, findingId);
  const stored = await ext.storage.local.get(key);
  const value = stored[key];
  if (value && typeof value === 'object') {
    return value as FindingEvidence;
  }
  return null;
}

export async function clearFindingEvidenceForTab(tabId: number): Promise<void> {
  const all = await ext.storage.local.get(null);
  const prefix = `${EVIDENCE_PREFIX}${tabId}_`;
  const keys = Object.keys(all).filter((key) => key.startsWith(prefix));
  if (keys.length > 0) {
    await ext.storage.local.remove(keys);
  }
}

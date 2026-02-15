import type { ScanReport } from '@/lib/types';

const API_KEY_STORAGE_KEY = 'gemini_api_key';
const REPORT_PREFIX = 'scan_report_';

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

export async function saveApiKey(apiKey: string): Promise<void> {
  await ext.storage.local.set({ [API_KEY_STORAGE_KEY]: apiKey });
}

export async function getApiKey(): Promise<string | null> {
  const stored = await ext.storage.local.get(API_KEY_STORAGE_KEY);
  const value = stored[API_KEY_STORAGE_KEY];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export async function hasApiKey(): Promise<boolean> {
  return (await getApiKey()) !== null;
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

import type { TranscriptSegment } from '@/lib/types';

const BASIC_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

function decodeHtmlEntities(input: string): string {
  let value = input;

  // Run a few rounds so double-encoded text like "&amp;#39;" is fully decoded.
  for (let round = 0; round < 3; round += 1) {
    const next = value
      .replace(/&(amp|lt|gt|quot|apos|#39);/g, (match) => BASIC_ENTITIES[match] ?? match)
      .replace(/&#(\d+);/g, (_, code) => {
        const parsed = Number(code);
        return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _;
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
        const parsed = Number.parseInt(code, 16);
        return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _;
      });

    if (next === value) break;
    value = next;
  }

  return value;
}

function cleanTranscriptText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/\s+/g, ' ')
    .replace(/\u200b/g, '')
    .trim();
}

export function formatTimeLabel(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function parseTimestampLabelToSeconds(label: string): number | null {
  const parts = label
    .trim()
    .split(':')
    .map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }

  if (numbers.length === 2) {
    return numbers[0] * 60 + numbers[1];
  }
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}

export function normalizeTranscriptSegments(
  rows: Array<{ startSec: number; text: string; startLabel?: string }>,
): TranscriptSegment[] {
  const normalized = rows
    .map((row) => {
      const startSec = Number(row.startSec);
      const text = cleanTranscriptText(row.text);
      if (!Number.isFinite(startSec) || startSec < 0 || !text) {
        return null;
      }
      const label = row.startLabel?.trim() || formatTimeLabel(startSec);
      return {
        id: `${Math.round(startSec * 1000)}-${text.slice(0, 24)}`,
        startSec,
        startLabel: label,
        text,
      } satisfies TranscriptSegment;
    })
    .filter((row): row is TranscriptSegment => row !== null)
    .sort((left, right) => left.startSec - right.startSec);

  const deduped: TranscriptSegment[] = [];
  for (const segment of normalized) {
    const previous = deduped[deduped.length - 1];
    if (
      previous &&
      Math.abs(previous.startSec - segment.startSec) < 0.2 &&
      previous.text === segment.text
    ) {
      continue;
    }
    deduped.push(segment);
  }
  return deduped;
}

export function validateTranscriptSegments(
  segments: TranscriptSegment[],
  minimum = 3,
): { ok: boolean; reason?: string } {
  if (segments.length < minimum) {
    return { ok: false, reason: 'too_few_segments' };
  }

  let last = -1;
  for (const segment of segments) {
    if (segment.startSec < last) {
      return { ok: false, reason: 'non_monotonic_timestamps' };
    }
    last = segment.startSec;
  }

  return { ok: true };
}

export function nearestSegmentForTimestampLabel(
  label: string | undefined,
  segments: TranscriptSegment[],
): TranscriptSegment | null {
  if (!label || segments.length === 0) {
    return null;
  }

  const normalizedLabel = label.trim();
  const exact = segments.find((segment) => segment.startLabel === normalizedLabel);
  if (exact) return exact;

  const parsedSec = parseTimestampLabelToSeconds(normalizedLabel);
  if (parsedSec == null) return null;

  let best: TranscriptSegment | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const segment of segments) {
    const distance = Math.abs(segment.startSec - parsedSec);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = segment;
    }
  }

  if (bestDistance > 4 || !best) {
    return null;
  }
  return best;
}

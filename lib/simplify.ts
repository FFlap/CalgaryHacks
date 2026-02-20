import { callOpenRouterJson } from '@/lib/openrouter';
import type { RewriteLevel } from '@/lib/types';

const MAX_SIMPLIFY_INPUT_CHARS = 2_400;

interface SimplifyResponse {
  simplified: string;
}

export async function simplifySelectionText(options: {
  apiKey: string;
  text: string;
  level?: RewriteLevel;
}): Promise<string> {
  const normalized = options.text.replace(/\s+/g, ' ').trim();
  if (normalized.length < 8) {
    throw new Error('Please highlight a longer sentence to simplify.');
  }
  const level = options.level ?? 2;
  const levelGuidance: Record<RewriteLevel, string> = {
    1: 'Level 1: Use very basic language for a 10-year-old. Very short sentences. Explain uncommon words.',
    2: 'Level 2: Use middle-school language. Clear and simple, with minimal jargon.',
    3: 'Level 3: Keep close to original meaning and tone, but make it a bit easier to read.',
  };

  const prompt = [
    'Rewrite the selected text in very plain, everyday English.',
    'Audience: low reading level, non-expert adults.',
    levelGuidance[level],
    'Rules:',
    '- Keep the original meaning.',
    '- Use short sentences and common words.',
    '- Avoid jargon, idioms, and technical terms when possible.',
    '- Do not add new facts.',
    '- Keep it concise.',
    'Return strict JSON only:',
    '{"simplified":"string"}',
    `SELECTED_TEXT: ${normalized.slice(0, MAX_SIMPLIFY_INPUT_CHARS)}`,
  ].join('\n');

  const response = await callOpenRouterJson<SimplifyResponse>({
    apiKey: options.apiKey,
    prompt,
    timeoutMs: 45_000,
  });

  const simplified = String(response?.simplified ?? '').replace(/\s+/g, ' ').trim();
  if (!simplified) {
    throw new Error('Simplification returned an empty response.');
  }

  return simplified;
}

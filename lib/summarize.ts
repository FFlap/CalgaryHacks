import { callOpenRouterJson } from '@/lib/openrouter';
import type { RewriteLevel } from '@/lib/types';

const MAX_SUMMARIZE_INPUT_CHARS = 3_200;

interface SummarizeResponse {
  summary: string;
}

export async function summarizeSelectionText(options: {
  apiKey: string;
  text: string;
  level?: RewriteLevel;
}): Promise<string> {
  const normalized = options.text.replace(/\s+/g, ' ').trim();
  if (normalized.length < 8) {
    throw new Error('Please highlight a longer sentence to summarize.');
  }
  const level = options.level ?? 2;
  const levelGuidance: Record<RewriteLevel, string[]> = {
    1: [
      'Level 1: Summarize in very basic language a 10-year-old can understand.',
      'Use 3 to 5 short sentences.',
    ],
    2: [
      'Level 2: Summarize in middle-school friendly language.',
      'Use 2 to 4 sentences.',
    ],
    3: [
      'Level 3: Summarize with wording close to the original, but slightly easier.',
      'Use 2 to 3 sentences.',
    ],
  };

  const prompt = [
    'Summarize the selected text clearly and directly.',
    ...levelGuidance[level],
    'Rules:',
    '- Keep the main points; do not drop important context.',
    '- Do not add new facts.',
    '- Use plain language.',
    '- Do not make it a one-line summary unless the input is extremely short.',
    'Return strict JSON only:',
    '{"summary":"string"}',
    `SELECTED_TEXT: ${normalized.slice(0, MAX_SUMMARIZE_INPUT_CHARS)}`,
  ].join('\n');

  const response = await callOpenRouterJson<SummarizeResponse>({
    apiKey: options.apiKey,
    prompt,
    timeoutMs: 45_000,
  });

  const summary = String(response?.summary ?? '').replace(/\s+/g, ' ').trim();
  if (!summary) {
    throw new Error('Summarization returned an empty response.');
  }

  return summary;
}

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

interface GeminiCallOptions {
  apiKey: string;
  prompt: string;
  withGrounding?: boolean;
  timeoutMs?: number;
}

interface GroundingChunk {
  web?: {
    title?: string;
    uri?: string;
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    groundingMetadata?: {
      groundingChunks?: GroundingChunk[];
    };
  }>;
}

export interface GeminiCallResult {
  text: string;
  groundingCitations: Array<{ title: string; url: string; domain?: string }>;
}

function extractJsonBlock(input: string): string {
  const fenced = input.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return input.slice(start, end + 1).trim();
  }
  return input.trim();
}

function parseResponseText(response: GeminiResponse): string {
  const part = response.candidates?.[0]?.content?.parts?.find((item) => item.text);
  if (!part?.text) {
    throw new Error('Gemini response did not contain text content.');
  }
  return extractJsonBlock(part.text);
}

function normalizeDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function parseGroundingCitations(response: GeminiResponse): GeminiCallResult['groundingCitations'] {
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  const citations: GeminiCallResult['groundingCitations'] = [];

  for (const chunk of chunks) {
    const url = chunk.web?.uri;
    const title = chunk.web?.title;
    if (!url || !title || seen.has(url)) {
      continue;
    }
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }
    seen.add(url);
    citations.push({
      title,
      url,
      domain: normalizeDomain(url),
    });
  }

  return citations;
}

export async function callGeminiJson<T>(
  options: GeminiCallOptions,
): Promise<{ data: T; groundingCitations: GeminiCallResult['groundingCitations'] }> {
  const { apiKey, prompt, withGrounding = false, timeoutMs = 70_000 } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: withGrounding ? [{ google_search: {} }] : undefined,
        generationConfig: {
          temperature: 0.1,
          ...(withGrounding ? {} : { responseMimeType: 'application/json' }),
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini API failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const parsed = (await response.json()) as GeminiResponse;
    const text = parseResponseText(parsed);
    const data = JSON.parse(text) as T;
    return {
      data,
      groundingCitations: parseGroundingCitations(parsed),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Gemini request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

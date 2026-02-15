const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'arcee-ai/trinity-large-preview:free';

interface OpenRouterCallOptions {
  apiKey: string;
  prompt: string;
  timeoutMs?: number;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
          }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

function extractJsonBlock(input: string): string {
  const fenced = input.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstObject = input.indexOf('{');
  const firstArray = input.indexOf('[');
  let start = -1;
  if (firstObject === -1) start = firstArray;
  else if (firstArray === -1) start = firstObject;
  else start = Math.min(firstObject, firstArray);

  if (start === -1) {
    return input.trim();
  }

  const openChar = input[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < input.length; i += 1) {
    const char = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, i + 1).trim();
      }
    }
  }

  return input.trim();
}

function stripFenceMarkers(input: string): string {
  return input
    .replace(/```(?:json)?/gi, '')
    .replace(/^\s*`+json\b/gi, '')
    .replace(/`{3,}/g, '')
    .trim();
}

function parseResponseText(response: OpenRouterResponse): string {
  const content = response.choices?.[0]?.message?.content;

  if (typeof content === 'string' && content.trim()) {
    return extractJsonBlock(content);
  }

  if (Array.isArray(content)) {
    const combined = content
      .map((item) => item?.text ?? '')
      .join('\n')
      .trim();
    if (combined) {
      return extractJsonBlock(combined);
    }
  }

  throw new Error('OpenRouter response did not contain text content.');
}

function normalizeJsonCandidate(input: string): string {
  return input
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function parseJsonWithRecovery<T>(raw: string): T {
  const stripped = stripFenceMarkers(raw);
  const extracted = extractJsonBlock(raw);
  const strippedExtracted = stripFenceMarkers(extracted);
  const attempts = [
    raw,
    stripped,
    extracted,
    strippedExtracted,
    normalizeJsonCandidate(raw),
    normalizeJsonCandidate(stripped),
    normalizeJsonCandidate(extracted),
    normalizeJsonCandidate(strippedExtracted),
  ];
  let lastError: unknown;

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'Unknown JSON parse error.';
  throw new Error(`Failed to parse model JSON response: ${message}`);
}

export async function callOpenRouterJson<T>(options: OpenRouterCallOptions): Promise<T> {
  const { apiKey, prompt, timeoutMs = 70_000 } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'CalgaryHacks Credibility Extension',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        temperature: 0.1,
        max_tokens: 1800,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter API failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const parsed = (await response.json()) as OpenRouterResponse;
    if (parsed.error?.message) {
      throw new Error(`OpenRouter error: ${parsed.error.message}`);
    }
    const text = parseResponseText(parsed);
    return parseJsonWithRecovery<T>(text);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('OpenRouter request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

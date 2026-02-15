const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'arcee-ai/trinity-large-preview:free';
const STRICT_JSON_SYSTEM_PROMPT =
  'You are a JSON API. Return only strict RFC8259 JSON. No markdown, no explanations, no code fences.';

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

function extractBalancedJsonDocument(input: string): string | null {
  let start = -1;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '{' || ch === '[') {
      start = i;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }

    if (ch === '}' || ch === ']') {
      const top = stack[stack.length - 1];
      const isMatch = (top === '{' && ch === '}') || (top === '[' && ch === ']');
      if (!isMatch) {
        return null;
      }
      stack.pop();
      if (stack.length === 0) {
        return input.slice(start, i + 1).trim();
      }
    }
  }

  return null;
}

function extractJsonBlock(input: string): string {
  const fenced = input.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const balanced = extractBalancedJsonDocument(fenced[1].trim());
    if (balanced) {
      return balanced;
    }
    return fenced[1].trim();
  }

  const balanced = extractBalancedJsonDocument(input);
  if (balanced) {
    return balanced;
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

function normalizeJsonCandidate(input: string): string {
  return input
    .replace(/^\uFEFF/, '')
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

export async function callOpenRouterJson<T>(options: OpenRouterCallOptions): Promise<T> {
  const { apiKey, prompt, timeoutMs = 70_000 } = options;
  let lastParseError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const strictMode = attempt === 1;
    const strictPrompt = strictMode
      ? `${prompt}\n\nIMPORTANT: Return valid JSON only. Do not use markdown or comments.`
      : prompt;

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
          temperature: strictMode ? 0 : 0.1,
          max_tokens: 1800,
          response_format: strictMode ? { type: 'json_object' } : undefined,
          messages: [
            {
              role: 'system',
              content: STRICT_JSON_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: strictPrompt,
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

      try {
        return parseJsonWithRecovery<T>(text);
      } catch (error) {
        lastParseError = error instanceof Error ? error : new Error('Unknown JSON parse failure.');
        if (attempt === 0) {
          continue;
        }
        throw new Error(
          `OpenRouter response was not valid JSON after strict retry: ${lastParseError.message}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('OpenRouter request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `OpenRouter response was not valid JSON after strict retry: ${lastParseError?.message ?? 'unknown error.'}`,
  );
}

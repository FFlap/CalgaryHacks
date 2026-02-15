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
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return input.slice(start, end + 1).trim();
  }
  return input.trim();
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
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('OpenRouter request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

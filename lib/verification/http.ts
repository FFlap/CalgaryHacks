const DEFAULT_TIMEOUT_MS = 18_000;

interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: HeadersInit;
  label: string;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchJsonWithRetry<T>(
  url: string,
  options: FetchJsonOptions,
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2, headers, label } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...headers,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        const snippet = body.slice(0, 220);
        const err = new Error(`${label} failed (${response.status}): ${snippet}`);
        if (attempt < retries && isRetryableStatus(response.status)) {
          lastError = err;
          continue;
        }
        throw err;
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new Error(`${label} returned invalid JSON.`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        lastError = new Error(`${label} request timed out.`);
      } else {
        lastError = error instanceof Error ? error : new Error(`${label} request failed.`);
      }

      if (attempt >= retries) {
        throw lastError;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error(`${label} request failed.`);
}

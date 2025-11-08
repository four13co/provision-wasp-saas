/**
 * Retry utility with exponential backoff
 * Provides resilient API calls that can handle transient network failures
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  verbose?: boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  verbose: false
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 *
 * @param fn Function to retry
 * @param options Retry configuration
 * @returns Result of the function
 *
 * @example
 * const data = await retry(async () => {
 *   const response = await fetch('https://api.example.com/data');
 *   if (!response.ok) throw new Error(`HTTP ${response.status}`);
 *   return response.json();
 * }, { maxRetries: 3, verbose: true });
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Don't retry on last attempt
      if (attempt === opts.maxRetries) {
        break;
      }

      // Calculate delay with exponential backoff
      const baseDelay = opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt);
      const jitter = Math.random() * 0.3 * baseDelay; // Add ±30% jitter
      const delay = Math.min(baseDelay + jitter, opts.maxDelayMs);

      if (opts.verbose) {
        console.log(`  ⚠️  Attempt ${attempt + 1}/${opts.maxRetries + 1} failed: ${error?.message || error}`);
        console.log(`  🔄 Retrying in ${Math.round(delay)}ms...`);
      }

      await sleep(delay);
    }
  }

  // All retries exhausted
  throw lastError;
}

/**
 * Retry a fetch request with exponential backoff
 * Convenience wrapper around retry() for fetch calls
 *
 * @param url URL to fetch
 * @param init Fetch options
 * @param options Retry configuration
 * @returns Fetch response
 *
 * @example
 * const response = await retryFetch('https://api.example.com/data', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ name: 'test' })
 * }, { maxRetries: 3, verbose: true });
 */
export async function retryFetch(
  url: string,
  init?: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  return retry(async () => {
    const response = await fetch(url, init);

    // Throw on HTTP errors to trigger retry
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return response;
  }, options);
}

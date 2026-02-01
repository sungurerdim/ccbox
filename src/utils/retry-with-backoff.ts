/**
 * Retry utility with exponential backoff for ccbox.
 *
 * Generic retry function for transient failures (network, Docker operations).
 */

/**
 * Retry an async function with exponential backoff.
 *
 * @param fn - Async function to retry.
 * @param maxRetries - Maximum number of retry attempts (0 = no retries, just run once).
 * @param initialDelayMs - Initial delay in milliseconds (doubles each attempt).
 * @param label - Operation label for debug logging.
 * @returns The result of fn() on success.
 * @throws The last error if all attempts fail.
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  initialDelayMs = 1000,
  label = "Operation"
): Promise<T> {
  const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? "";
      const message = err instanceof Error ? err.message : String(err);
      const isRetryable = RETRYABLE_CODES.has(code)
        || message.includes("fetch failed")
        || /5\d{2}/.test(message);

      if (!isRetryable || attempt === maxRetries) {
        throw err;
      }

      const delay = Math.min(initialDelayMs * (2 ** attempt), 30000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error(`${label} failed after ${maxRetries + 1} attempts`);
}

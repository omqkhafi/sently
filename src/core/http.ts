/**
 * @module
 * Shared HTTP fetch for provider transports: deadline plus defensive body parsing.
 */
import { httpStatusToSentlyCode, SentlyError } from "./errors.js";

/** Default HTTP deadline for provider `fetch` calls. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/** Fetch init plus an optional deadline override. */
export interface ProviderFetchInit extends RequestInit {
  /** Deadline in milliseconds. Default: {@link DEFAULT_HTTP_TIMEOUT_MS}. `0` waits without a deadline. */
  timeoutMs?: number;
}

/**
 * `fetch` with a deadline. Abort becomes {@link SentlyError} `TIMEOUT`.
 *
 * @param input - Request URL or Request
 * @param init - Fetch options. `timeoutMs` is not forwarded to `fetch`.
 */
export async function providerFetch(
  input: RequestInfo | URL,
  init?: ProviderFetchInit,
): Promise<Response> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const { timeoutMs: _timeoutMs, ...rest } = init ?? {};
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal =
    rest.signal && timeoutSignal
      ? AbortSignal.any([rest.signal, timeoutSignal])
      : (timeoutSignal ?? rest.signal);

  try {
    return await fetch(input, { ...rest, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new SentlyError("HTTP request timed out", "TIMEOUT", { cause: error });
    }
    throw error;
  }
}

/**
 * Read a provider response body without throwing `SyntaxError` or `TypeError`.
 *
 * A non-OK response with a JSON object is returned so the caller can throw its
 * provider error. A non-OK response that is empty, JSON `null`, or not JSON
 * throws {@link SentlyError} with `statusCode`. An OK response with an empty
 * or `null` body throws `PROVIDER_ERROR`.
 *
 * @param response - Fetch response
 * @param provider - Provider id used on thrown errors
 */
export async function readJsonBody<T>(response: Response, provider = "http"): Promise<T> {
  const text = await response.text();
  const trimmed = text.trim();

  if (!response.ok) {
    if (trimmed.length === 0 || trimmed === "null") {
      throw new SentlyError(`${provider} request failed`, httpStatusToSentlyCode(response.status), {
        statusCode: response.status,
        provider,
      });
    }
    try {
      const parsed = JSON.parse(trimmed) as T;
      if (parsed === null) {
        throw new SentlyError(
          `${provider} request failed`,
          httpStatusToSentlyCode(response.status),
          { statusCode: response.status, provider },
        );
      }
      return parsed;
    } catch (cause) {
      if (cause instanceof SentlyError) {
        throw cause;
      }
      throw new SentlyError(`${provider} request failed`, httpStatusToSentlyCode(response.status), {
        statusCode: response.status,
        provider,
        cause,
      });
    }
  }

  if (trimmed.length === 0 || trimmed === "null") {
    throw new SentlyError(`${provider} returned an empty body`, "PROVIDER_ERROR", {
      statusCode: response.status,
      provider,
    });
  }

  try {
    const parsed = JSON.parse(trimmed) as T;
    if (parsed === null) {
      throw new SentlyError(`${provider} returned an empty body`, "PROVIDER_ERROR", {
        statusCode: response.status,
        provider,
      });
    }
    return parsed;
  } catch (error) {
    if (error instanceof SentlyError) {
      throw error;
    }
    throw new SentlyError(`${provider} returned invalid JSON`, "PROVIDER_ERROR", {
      statusCode: response.status,
      provider,
      cause: error,
    });
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

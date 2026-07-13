/**
 * Shared network-retry utilities for HTTP/`fetch` operations such as Git LFS
 * batch requests, blob uploads, and downloads.
 *
 * Why this exists: Node's `fetch` (undici) reports most transport failures with
 * the generic message `"fetch failed"` and hides the real reason one or more
 * levels down in `error.cause` (e.g. `ECONNRESET`, `UND_ERR_SOCKET`). Classifying
 * retryability off `error.message` alone therefore misses genuinely transient
 * failures. These helpers walk the full `cause` chain so transient errors are
 * retried consistently across every network call.
 */

/** Default number of retries (so total attempts = maxRetries + 1). */
export const DEFAULT_MAX_RETRIES = 3;
/** Base delay for exponential backoff. */
export const DEFAULT_BASE_DELAY_MS = 1000;
/** Hard cap on any single backoff delay. */
export const DEFAULT_MAX_DELAY_MS = 30_000;
/** Exponential growth factor (delay ≈ base * factor^attempt). */
const BACKOFF_FACTOR = 3;
/** Never honor a server `Retry-After` longer than this. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Human-readable descriptions for low-level network error codes. Used to turn
 * an opaque `"fetch failed"` into something actionable in error reports.
 */
export const NETWORK_ERROR_DESCRIPTIONS: Record<string, string> = {
    ENOTFOUND: "DNS lookup failed - hostname not found",
    EAI_AGAIN: "DNS lookup timed out - network may be unstable",
    ECONNREFUSED: "Connection refused - server may be down",
    ECONNRESET: "Connection reset by server",
    ECONNABORTED: "Connection aborted",
    ETIMEDOUT: "Connection timed out",
    EPIPE: "Connection broken",
    EHOSTUNREACH: "Host unreachable",
    ENETUNREACH: "Network unreachable",
    UND_ERR_CONNECT_TIMEOUT: "Connection timed out",
    UND_ERR_HEADERS_TIMEOUT: "Server took too long to send headers",
    UND_ERR_BODY_TIMEOUT: "Response body timed out",
    UND_ERR_SOCKET: "Socket closed unexpectedly",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "SSL certificate verification failed",
    DEPTH_ZERO_SELF_SIGNED_CERT: "Self-signed SSL certificate rejected",
    CERT_HAS_EXPIRED: "SSL certificate has expired",
    ERR_TLS_CERT_ALTNAME_INVALID: "SSL certificate hostname mismatch",
};

/** Transient transport error codes that are safe to retry. */
const RETRYABLE_ERROR_CODES = new Set<string>([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
]);

/** Definitive failures that must never be retried (auth/cert problems). */
const NON_RETRYABLE_ERROR_CODES = new Set<string>([
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
]);

type MaybeError = {
    message?: unknown;
    code?: unknown;
    status?: unknown;
    name?: unknown;
    cause?: unknown;
    retryAfterMs?: unknown;
};

/** Attach a `cause` to a new Error without depending on ES2022 lib typings. */
export function errorWithCause(message: string, cause: unknown): Error {
    const error = new Error(message);
    (error as Error & { cause?: unknown }).cause = cause;
    return error;
}

/**
 * Walk an error's `cause` chain, yielding each link once. Guards against cyclic
 * `cause` references so we never loop forever on malformed errors.
 */
function* iterateErrorChain(error: unknown): Generator<MaybeError> {
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        yield current as MaybeError;
        current = (current as MaybeError).cause;
    }
}

function getMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    const msg = (error as MaybeError)?.message;
    return typeof msg === "string" ? msg : String(error);
}

function getStatus(error: MaybeError): number | undefined {
    const status = error.status;
    return typeof status === "number" && status > 0 ? status : undefined;
}

function getCode(error: MaybeError): string | undefined {
    return typeof error.code === "string" ? error.code : undefined;
}

function isTimeoutOrAbortName(name: unknown): boolean {
    return name === "TimeoutError" || name === "AbortError";
}

export interface RetryClassificationOptions {
    /** Retry HTTP 429 (rate limited). Defaults to true. */
    retryOn429?: boolean;
}

/**
 * Decide whether an error represents a transient failure worth retrying.
 *
 * The whole `cause` chain is inspected, so a wrapped `"fetch failed"` whose
 * underlying cause is e.g. `UND_ERR_SOCKET` is correctly treated as retryable.
 * An explicit HTTP status anywhere in the chain is authoritative: 5xx (and 429
 * when enabled) retry, every other status is a definitive client error.
 */
export function isRetryableError(
    error: unknown,
    options: RetryClassificationOptions = {},
): boolean {
    const { retryOn429 = true } = options;

    for (const link of iterateErrorChain(error)) {
        const status = getStatus(link);
        if (status !== undefined) {
            if (status >= 500) {
                return true;
            }
            if (status === 429) {
                return retryOn429;
            }
            // Any other explicit HTTP status is a definitive client error.
            return false;
        }

        const code = getCode(link);
        if (code) {
            if (NON_RETRYABLE_ERROR_CODES.has(code)) {
                return false;
            }
            if (RETRYABLE_ERROR_CODES.has(code)) {
                return true;
            }
        }

        // Node/undici report transport failures as `TypeError: fetch failed`.
        if (link instanceof TypeError && /fetch failed/i.test(getMessage(link))) {
            return true;
        }

        // Our own timeout aborts (and undici timeouts) surface as DOMExceptions.
        // Genuine user-initiated cancellation is handled by the AbortSignal check
        // in retryWithBackoff before this is ever consulted.
        if (isTimeoutOrAbortName(link.name)) {
            return true;
        }

        const message = getMessage(link);
        if (
            /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|UND_ERR/i.test(
                message,
            )
        ) {
            return true;
        }
    }

    return false;
}

/**
 * Build an actionable, single-line description of a network error by walking the
 * cause chain and decoding known error codes. Turns `"fetch failed"` into
 * `"fetch failed - Socket closed unexpectedly (UND_ERR_SOCKET)"`.
 */
export function getNetworkErrorDetails(error: unknown): string {
    const top = getMessage(error);
    const parts: string[] = [top];

    for (const link of iterateErrorChain(error)) {
        if (link === error) {
            continue;
        }
        const code = getCode(link);
        const description = code ? NETWORK_ERROR_DESCRIPTIONS[code] : undefined;
        const message = getMessage(link);

        if (description && !parts.includes(description)) {
            parts.push(code ? `${description} (${code})` : description);
        } else if (code && !parts.some((p) => p.includes(code))) {
            parts.push(`(${code})`);
        } else if (message && message !== top && !parts.includes(message)) {
            parts.push(message);
        }
    }

    return parts.join(" - ");
}

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into ms.
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
    if (!headerValue) {
        return undefined;
    }
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
    }
    const dateMs = Date.parse(headerValue);
    if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - Date.now());
    }
    return undefined;
}

function getRetryAfterMs(error: unknown): number | undefined {
    for (const link of iterateErrorChain(error)) {
        const value = link.retryAfterMs;
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
            return value;
        }
    }
    return undefined;
}

const createAbortError = (signal?: AbortSignal): unknown =>
    signal?.reason ?? new DOMException("Aborted", "AbortError");

/** Sleep that rejects promptly if the provided signal aborts mid-delay. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError(signal));
            return;
        }
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            cleanup();
            reject(createAbortError(signal));
        };
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Compute the next backoff delay: exponential growth, capped, with "equal
 * jitter" (half fixed + half random) to avoid thundering-herd retries when many
 * concurrent uploads fail at once. Honors a server-provided `Retry-After` when
 * it is longer than the computed delay.
 */
export function computeBackoffDelay(
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number,
    retryAfterMs?: number,
): number {
    const exponential = baseDelayMs * Math.pow(BACKOFF_FACTOR, attempt);
    const capped = Math.min(exponential, maxDelayMs);
    const jittered = capped / 2 + Math.random() * (capped / 2);
    const serverRequested = Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS);
    return Math.max(jittered, serverRequested);
}

export interface RetryOptions extends RetryClassificationOptions {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    signal?: AbortSignal;
    /** Override the default transient-error classifier. */
    isRetryable?: (error: unknown) => boolean;
    /** Called before each backoff sleep (for logging/telemetry). */
    onRetry?: (info: { attempt: number; maxRetries: number; delayMs: number; error: unknown }) => void;
}

/**
 * Run `fn`, retrying transient failures with jittered exponential backoff.
 * Only retries when the error is classified retryable; honors an AbortSignal
 * both between attempts and during the backoff sleep.
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    label: string,
    options: RetryOptions = {},
): Promise<T> {
    const {
        maxRetries = DEFAULT_MAX_RETRIES,
        baseDelayMs = DEFAULT_BASE_DELAY_MS,
        maxDelayMs = DEFAULT_MAX_DELAY_MS,
        signal,
        retryOn429,
        onRetry,
    } = options;
    const isRetryable =
        options.isRetryable ?? ((error: unknown) => isRetryableError(error, { retryOn429 }));

    let hadFailure = false;
    for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) {
            throw createAbortError(signal);
        }
        try {
            const result = await fn();
            if (hadFailure) {
                console.log(
                    `[Retry] ${label} succeeded on attempt ${attempt + 1} after previous failure(s)`,
                );
            }
            return result;
        } catch (error) {
            hadFailure = true;
            // Distinguish genuine cancellation from a retryable failure.
            if (signal?.aborted) {
                throw createAbortError(signal);
            }
            if (attempt >= maxRetries || !isRetryable(error)) {
                throw error;
            }
            const delayMs = computeBackoffDelay(
                attempt,
                baseDelayMs,
                maxDelayMs,
                getRetryAfterMs(error),
            );
            onRetry?.({ attempt, maxRetries, delayMs, error });
            console.log(
                `[Retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delayMs)}ms: ${getNetworkErrorDetails(error)}`,
            );
            await abortableDelay(delayMs, signal);
        }
    }
}

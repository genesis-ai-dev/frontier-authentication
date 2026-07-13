import * as assert from "assert";
import {
    isRetryableError,
    getNetworkErrorDetails,
    parseRetryAfterMs,
    computeBackoffDelay,
    retryWithBackoff,
    errorWithCause,
} from "../../../git/networkRetry";

/** Build an Error carrying a low-level `code` (mimics a Node system error). */
const codeError = (code: string, message = code): Error => {
    const err = new Error(message);
    (err as NodeJS.ErrnoException).code = code;
    return err;
};

/** Build an Error carrying an HTTP `status`. */
const statusError = (status: number, message = `HTTP ${status}`): Error => {
    const err = new Error(message);
    (err as Error & { status: number }).status = status;
    return err;
};

suite("networkRetry - isRetryableError", () => {
    test("bare 'fetch failed' TypeError is retryable", () => {
        assert.strictEqual(isRetryableError(new TypeError("fetch failed")), true);
    });

    test("undici cause code (UND_ERR_SOCKET) one level down is retryable", () => {
        const wrapped = errorWithCause("fetch failed", codeError("UND_ERR_SOCKET"));
        assert.strictEqual(isRetryableError(wrapped), true);
    });

    test("regression: descriptive wrapper preserving a transient cause is retryable", () => {
        // Mirrors the GitService LFS upload path: a friendly message wrapping the
        // original `TypeError: fetch failed` (whose cause is a socket error).
        const undiciError = errorWithCause("fetch failed", codeError("ECONNRESET"));
        const userFacing = errorWithCause(
            "Network error uploading file 0 to LFS storage: fetch failed",
            undiciError,
        );
        assert.strictEqual(isRetryableError(userFacing), true);
    });

    test("HTTP 5xx is retryable", () => {
        assert.strictEqual(isRetryableError(statusError(503)), true);
    });

    test("HTTP 429 is retryable by default, configurable off", () => {
        assert.strictEqual(isRetryableError(statusError(429)), true);
        assert.strictEqual(isRetryableError(statusError(429), { retryOn429: false }), false);
    });

    test("HTTP 4xx client errors are not retryable", () => {
        assert.strictEqual(isRetryableError(statusError(404)), false);
        assert.strictEqual(isRetryableError(statusError(401)), false);
    });

    test("explicit HTTP status is authoritative over a transient cause", () => {
        const err = statusError(400);
        (err as Error & { cause?: unknown }).cause = codeError("ECONNRESET");
        assert.strictEqual(isRetryableError(err), false);
    });

    test("TLS/certificate errors are never retryable", () => {
        assert.strictEqual(isRetryableError(codeError("CERT_HAS_EXPIRED")), false);
        assert.strictEqual(
            isRetryableError(errorWithCause("fetch failed", codeError("DEPTH_ZERO_SELF_SIGNED_CERT"))),
            false,
        );
    });

    test("transient codes by message are retryable", () => {
        assert.strictEqual(isRetryableError(new Error("read ECONNRESET")), true);
        assert.strictEqual(isRetryableError(new Error("socket hang up")), true);
    });

    test("non-network errors are not retryable", () => {
        assert.strictEqual(isRetryableError(new Error("Unexpected JSON structure")), false);
        assert.strictEqual(isRetryableError("plain string"), false);
    });

    test("cyclic cause chains do not hang", () => {
        const a = new Error("a") as Error & { cause?: unknown };
        const b = new Error("b") as Error & { cause?: unknown };
        a.cause = b;
        b.cause = a;
        assert.strictEqual(isRetryableError(a), false);
    });
});

suite("networkRetry - getNetworkErrorDetails", () => {
    test("decodes undici cause code into a readable description", () => {
        const wrapped = errorWithCause("fetch failed", codeError("UND_ERR_SOCKET"));
        const details = getNetworkErrorDetails(wrapped);
        assert.ok(details.includes("fetch failed"), "keeps the top-level message");
        assert.ok(details.includes("Socket closed unexpectedly"), "adds the decoded description");
        assert.ok(details.includes("UND_ERR_SOCKET"), "includes the raw code");
    });

    test("falls back to the message when there is no cause", () => {
        assert.strictEqual(getNetworkErrorDetails(new Error("boom")), "boom");
    });
});

suite("networkRetry - parseRetryAfterMs", () => {
    test("parses delta-seconds", () => {
        assert.strictEqual(parseRetryAfterMs("5"), 5000);
    });

    test("parses an HTTP date in the future", () => {
        const future = new Date(Date.now() + 10_000).toUTCString();
        const ms = parseRetryAfterMs(future);
        assert.ok(ms !== undefined && ms > 5_000 && ms <= 10_000, `unexpected ms: ${ms}`);
    });

    test("returns undefined for missing/invalid values", () => {
        assert.strictEqual(parseRetryAfterMs(null), undefined);
        assert.strictEqual(parseRetryAfterMs(undefined), undefined);
        assert.strictEqual(parseRetryAfterMs("not-a-date"), undefined);
    });
});

suite("networkRetry - computeBackoffDelay", () => {
    test("grows exponentially within jitter bounds and respects the cap", () => {
        const base = 1000;
        const max = 30_000;
        for (let attempt = 0; attempt < 3; attempt++) {
            const expected = Math.min(base * Math.pow(3, attempt), max);
            const delay = computeBackoffDelay(attempt, base, max);
            assert.ok(delay >= expected / 2, `delay ${delay} below jitter floor for attempt ${attempt}`);
            assert.ok(delay <= expected, `delay ${delay} above ceiling for attempt ${attempt}`);
        }
    });

    test("never exceeds the max delay cap", () => {
        const delay = computeBackoffDelay(10, 1000, 5000);
        assert.ok(delay <= 5000, `delay ${delay} exceeded cap`);
    });

    test("honors a server Retry-After longer than the computed delay", () => {
        const delay = computeBackoffDelay(0, 1000, 30_000, 8000);
        assert.ok(delay >= 8000, `delay ${delay} ignored Retry-After`);
    });
});

suite("networkRetry - retryWithBackoff", () => {
    const fastOptions = { baseDelayMs: 1, maxDelayMs: 5 } as const;

    test("retries a transient failure then succeeds", async () => {
        let attempts = 0;
        const result = await retryWithBackoff(async () => {
            attempts++;
            if (attempts < 3) {
                throw codeError("ECONNRESET");
            }
            return "ok";
        }, "test transient", fastOptions);
        assert.strictEqual(result, "ok");
        assert.strictEqual(attempts, 3);
    });

    test("does not retry a non-retryable error", async () => {
        let attempts = 0;
        await assert.rejects(
            retryWithBackoff(async () => {
                attempts++;
                throw statusError(404);
            }, "test client error", fastOptions),
        );
        assert.strictEqual(attempts, 1);
    });

    test("gives up after maxRetries and rethrows the last error", async () => {
        let attempts = 0;
        await assert.rejects(
            retryWithBackoff(async () => {
                attempts++;
                throw codeError("ETIMEDOUT");
            }, "test exhaust", { ...fastOptions, maxRetries: 2 }),
            /ETIMEDOUT/,
        );
        assert.strictEqual(attempts, 3); // initial + 2 retries
    });

    test("throws immediately when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        let attempts = 0;
        await assert.rejects(
            retryWithBackoff(async () => {
                attempts++;
                return "unreachable";
            }, "test aborted", { ...fastOptions, signal: controller.signal }),
        );
        assert.strictEqual(attempts, 0);
    });
});

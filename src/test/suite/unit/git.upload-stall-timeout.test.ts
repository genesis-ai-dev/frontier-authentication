import * as assert from "assert";
import { fetchUploadWithStallTimeout } from "../../../git/GitService";

/**
 * Read every chunk from a request-body ReadableStream, pausing `delayMs`
 * between reads to simulate a slow-but-alive connection.
 */
const drainBody = async (init: any, delayMs: number): Promise<number> => {
    const reader = init.body.getReader();
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.length;
        if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    return total;
};

suite("GitService - fetchUploadWithStallTimeout", () => {
    let originalFetch: any;

    setup(() => {
        originalFetch = (globalThis as any).fetch;
    });

    teardown(() => {
        (globalThis as any).fetch = originalFetch;
    });

    test("sets an explicit Content-Length (fixed-length, not chunked)", async () => {
        const bytes = new Uint8Array(1000).fill(7);
        let seenContentLength: string | undefined;
        let seenTransferEncoding: string | undefined;

        (globalThis as any).fetch = async (_input: any, init: any) => {
            const headers = init.headers as Record<string, string>;
            seenContentLength = headers["Content-Length"];
            seenTransferEncoding = headers["Transfer-Encoding"];
            await drainBody(init, 0);
            return new Response("", { status: 200 });
        };

        const resp = await fetchUploadWithStallTimeout("https://lfs.example.com/up", bytes, {
            headers: { Authorization: "Bearer x" },
        });

        assert.strictEqual(resp.status, 200);
        assert.strictEqual(seenContentLength, String(bytes.length));
        assert.strictEqual(seenTransferEncoding, undefined);
    });

    test("does NOT abort a slow-but-progressing upload", async () => {
        // 8 chunks, ~30ms between each (~240ms total) with a 100ms stall window:
        // progress keeps resetting the timer so it must never fire.
        const bytes = new Uint8Array(8 * 256 * 1024).fill(1);
        let bytesReceived = 0;

        (globalThis as any).fetch = async (_input: any, init: any) => {
            bytesReceived = await drainBody(init, 30);
            return new Response("", { status: 200 });
        };

        const resp = await fetchUploadWithStallTimeout("https://lfs.example.com/up", bytes, {
            headers: {},
            stallTimeoutMs: 100,
            chunkSize: 256 * 1024,
        });

        assert.strictEqual(resp.status, 200);
        assert.strictEqual(bytesReceived, bytes.length);
    });

    test("aborts with a retryable TimeoutError when no progress is made", async () => {
        const bytes = new Uint8Array(1024).fill(1);

        // Never read the body; reject only when the stall timer aborts the signal.
        (globalThis as any).fetch = (_input: any, init: any) =>
            new Promise((_resolve, reject) => {
                init.signal.addEventListener("abort", () => reject(init.signal.reason), {
                    once: true,
                });
            });

        await assert.rejects(
            fetchUploadWithStallTimeout("https://lfs.example.com/up", bytes, {
                headers: {},
                stallTimeoutMs: 50,
            }),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.strictEqual((err as Error).name, "TimeoutError");
                return true;
            },
        );
    });

    test("reports cumulative byte progress via onProgress up to the total", async () => {
        const bytes = new Uint8Array(5 * 256).fill(3);
        (globalThis as any).fetch = async (_input: any, init: any) => {
            await drainBody(init, 0);
            return new Response("", { status: 200 });
        };

        const progress: number[] = [];
        const resp = await fetchUploadWithStallTimeout("https://lfs.example.com/up", bytes, {
            headers: {},
            chunkSize: 256,
            onProgress: (bytesSent, totalBytes) => {
                assert.strictEqual(totalBytes, bytes.length);
                progress.push(bytesSent);
            },
        });

        assert.strictEqual(resp.status, 200);
        assert.ok(progress.length > 0, "should emit progress");
        // Monotonically increasing and ending exactly at the total.
        for (let i = 1; i < progress.length; i++) {
            assert.ok(progress[i] > progress[i - 1], "progress must increase");
        }
        assert.strictEqual(progress[progress.length - 1], bytes.length);
    });

    test("reports a stall then recovery via onStallStateChange", async () => {
        // 4 small chunks. The consumer reads the first chunk, pauses long enough
        // for the warn timer to fire (stall=true), then resumes (stall=false).
        const bytes = new Uint8Array(4 * 256).fill(1);
        let pausedOnce = false;

        (globalThis as any).fetch = async (_input: any, init: any) => {
            const reader = init.body.getReader();
            for (;;) {
                const { done } = await reader.read();
                if (done) {
                    break;
                }
                if (!pausedOnce) {
                    pausedOnce = true;
                    await new Promise((r) => setTimeout(r, 120));
                }
            }
            return new Response("", { status: 200 });
        };

        const states: boolean[] = [];
        const resp = await fetchUploadWithStallTimeout("https://lfs.example.com/up", bytes, {
            headers: {},
            stallTimeoutMs: 5000,
            stallWarnMs: 30,
            chunkSize: 256,
            onStallStateChange: (stalled) => states.push(stalled),
        });

        assert.strictEqual(resp.status, 200);
        assert.ok(states.includes(true), "should report a stall");
        assert.strictEqual(states[states.length - 1], false, "should report recovery last");
    });

    test("rejects immediately if the external signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        let fetchCalled = false;
        (globalThis as any).fetch = async () => {
            fetchCalled = true;
            return new Response("", { status: 200 });
        };

        await assert.rejects(
            fetchUploadWithStallTimeout("https://lfs.example.com/up", new Uint8Array(10), {
                headers: {},
                signal: controller.signal,
            }),
        );
        assert.strictEqual(fetchCalled, false);
    });
});

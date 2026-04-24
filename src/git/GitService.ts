import * as dugiteGit from "./dugiteGit";
import { formatPointerInfo, buildPointerInfo } from "./lfsPointerUtils";
import * as fs from "fs";
import * as vscode from "vscode";
import * as path from "path";

import { StateManager, HEARTBEAT_INTERVAL } from "../state";
import { MediaFilesStrategy } from "../types/state";
import {
    UploadBlobsOptions,
    LFSBatchRequest,
    LFSBatchResponse,
    LfsPointerInfo,
} from "../types/lfs";

/** Retry and batching constants for LFS uploads */
const LFS_MAX_RETRIES = 3;
const LFS_RETRY_BASE_DELAY_MS = 1000;
const LFS_UPLOAD_BATCH_SIZE = 50;
/** Max simultaneous PUT uploads within a single batch */
const LFS_UPLOAD_CONCURRENCY = 10;

/** Default timeout for LFS API requests (60 s) */
const LFS_FETCH_TIMEOUT_MS = 60_000;
/** Timeout for lightweight health-check requests (10 s) */
const HEALTH_CHECK_TIMEOUT_MS = 10_000;

/**
 * Wrapper around `fetch` that aborts after `timeoutMs`.
 * If a caller-provided `signal` is already aborted, throws immediately.
 */
function fetchWithTimeout(
    input: string | URL | Request,
    init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
    const { timeoutMs = LFS_FETCH_TIMEOUT_MS, ...rest } = init ?? {};
    const controller = new AbortController();
    const externalSignal = rest.signal;

    if (externalSignal?.aborted) {
        return Promise.reject(externalSignal.reason ?? new DOMException("Aborted", "AbortError"));
    }

    const onExternalAbort = () => controller.abort(externalSignal!.reason);
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
    return fetch(input, { ...rest, signal: controller.signal }).finally(() => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onExternalAbort);
    });
}

/**
 * Determine whether an error is retryable (server-side / transient network errors).
 */
function isRetryableError(error: unknown): boolean {
    if (error && typeof error === "object" && "status" in error) {
        const status = (error as { status: number }).status;
        if (status >= 500) {
            return true;
        }
        // Known HTTP status below 500 (e.g. 4xx client errors) — not retryable.
        // Return early so message-based heuristics below don't produce false positives
        // (e.g. "limit: 500MB" matching /5\d{2}/, or "authentication timeout" matching /timeout/).
        if (typeof status === "number" && status > 0) {
            return false;
        }
    }
    const msg = error instanceof Error ? error.message : String(error);
    return (
        /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|timeout|abort|socket hang up/i.test(msg) ||
        /5\d{2}/i.test(msg)
    );
}

/**
 * Retry a function with exponential back-off (delay = base * 3^attempt).
 * Only retries when `isRetryableError` returns true.
 */
async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    label: string,
    maxRetries: number = LFS_MAX_RETRIES,
    baseDelayMs: number = LFS_RETRY_BASE_DELAY_MS,
    signal?: AbortSignal,
): Promise<T> {
    let hadFailure = false;
    for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) {
            throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        try {
            const result = await fn();
            if (hadFailure) {
                console.log(
                    `[LFS Retry] ${label} succeeded on attempt ${attempt + 1} after previous failure(s)`
                );
            }
            return result;
        } catch (error) {
            hadFailure = true;
            if (signal?.aborted) {
                throw signal.reason ?? new DOMException("Aborted", "AbortError");
            }
            if (attempt >= maxRetries || !isRetryableError(error)) {
                throw error;
            }
            const delay = baseDelayMs * Math.pow(3, attempt); // 1 s, 3 s, 9 s
            console.log(
                `[LFS Retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${error instanceof Error ? error.message : error}`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

/**
 * Run an array of async tasks with a concurrency limit.
 * Tasks are started in order; at most `concurrency` run at the same time.
 * If any task throws, the error propagates immediately (remaining queued
 * tasks are not started, but already-running tasks are awaited).
 */
async function runWithConcurrency(
    tasks: (() => Promise<void>)[],
    concurrency: number,
): Promise<void> {
    let nextIndex = 0;
    let firstError: unknown | undefined;

    const runWorker = async (): Promise<void> => {
        while (nextIndex < tasks.length && firstError === undefined) {
            const idx = nextIndex++;
            try {
                await tasks[idx]();
            } catch (err) {
                firstError = err;
                throw err;
            }
        }
    };

    const workerCount = Math.min(concurrency, tasks.length);
    const workers = Array.from({ length: workerCount }, () => runWorker());

    const results = await Promise.allSettled(workers);

    // Re-throw the first error encountered
    if (firstError !== undefined) {
        throw firstError;
    }
    // Safety: also check for unexpected rejections
    for (const r of results) {
        if (r.status === "rejected") {
            throw r.reason;
        }
    }
}

/**
 * Standalone debug logging function that checks VS Code configuration
 */
function debugLog(message: string, data?: any): void {
    const debugLogging = vscode.workspace
        .getConfiguration("frontier")
        .get("debugGitLogging", false);

    if (debugLogging) {
        if (data !== undefined) {
            console.log(message, JSON.stringify(data));
        } else {
            console.log(message);
        }
    }
}

export interface ConflictedFile {
    filepath: string;
    ours: string;
    theirs: string;
    base: string;
    isNew?: boolean;
    isDeleted?: boolean;
}

export interface SyncResult {
    hadConflicts: boolean;
    conflicts?: ConflictedFile[];
    offline?: boolean;
    skippedDueToLock?: boolean;
    uploadedLfsFiles?: string[]; // List of LFS files that were uploaded during this sync
    /**
     * Optional diagnostics to help clients validate whether remote changes were considered.
     * These are best-effort and primarily populated in the divergent-history conflict path.
     */
    allChangedFilePaths?: string[];
    remoteChangedFilePaths?: string[];
}

export enum RemoteBranchStatus {
    FOUND,
    NOT_FOUND,
    ERROR,
}

/**
 * Fixed validation function that properly handles GitLab LFS responses
 */
function isValidLFSInfoResponseData(val: unknown): val is LFSBatchResponse {
    try {
        // Check if response has the expected structure
        const maybe = val as Partial<LFSBatchResponse> | undefined;
        debugLog("[LFS Patch] isValidLFSInfoResponseData", { maybe });

        if (!maybe || !Array.isArray(maybe.objects)) {
            console.warn("[LFS Patch] Invalid response structure:", val);
            return false;
        }

        const obj = maybe.objects[0];
        if (!obj) {
            console.warn("[LFS Patch] No objects in response");
            return false;
        }

        // If there are no actions, it means the server already has the file
        if (!obj.actions) {
            debugLog("[LFS Patch] Server already has file (no actions needed)");
            return true;
        }

        // Check if upload action has required properties
        const uploadAction = obj.actions?.upload;
        if (!uploadAction) {
            console.warn("[LFS Patch] No upload action in response");
            return false;
        }

        // Check if href exists and is a string (the original bug was here)
        if (!uploadAction.href || typeof uploadAction.href !== "string") {
            console.warn(
                "[LFS Patch] Invalid or missing href in upload action:",
                uploadAction.href
            );
            return false;
        }

        debugLog("[LFS Patch] Response validation passed");
        return true;
    } catch (error) {
        // Re-throw rather than returning false — callers must distinguish
        // "structurally invalid response" (false) from "validation code itself crashed".
        throw new Error(
            `LFS response validation error: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
/**
 * replace @fetsorn/isogit-lfs uploadBlobs function with corrected validation
 */
type LfsFileStatus = {
    index: number;
    size: number;
    alreadyOnServer: boolean;
};

async function uploadBlobsToLFSBucket(
    {
        headers = {},
        url,
        auth,
        recovery,
    }: UploadBlobsOptions & { recovery?: { dir: string; filepaths: string[]; }; },
    contents: Uint8Array[],
    onFileStatus?: (status: LfsFileStatus) => void,
): Promise<LfsPointerInfo[]> {
    debugLog("[LFS Patch] Using patched uploadBlobs function");
    debugLog("[LFS Patch] URL:", url);
    debugLog("[LFS Patch] Auth object:", auth);

    // Local helpers for pointer/files mapping
    const isPointerPathLocal = (filepath: string): boolean => {
        const normalized = filepath.replace(/\\/g, "/");
        return normalized.includes(".project/attachments/pointers");
    };
    const getFilesPathForPointerLocal = (dir: string, pointerRelativePath: string): string => {
        const normalized = pointerRelativePath.replace(/\\/g, "/");
        const filesRelative = normalized
            .replace("/.project/attachments/pointers/", "/.project/attachments/files/")
            .replace(".project/attachments/pointers/", ".project/attachments/files/");
        return path.join(dir, filesRelative);
    };

    // Attempt recovery for empty contents using files dir; record unrecoverable as corrupted
    const skipIndices = new Set<number>();
    if (recovery && Array.isArray(recovery.filepaths)) {
        const dir = recovery.dir;
        const filesRoot = path.join(dir, ".project/attachments/files");
        const pointersRoot = path.join(dir, ".project/attachments/pointers");
        const recovered: Uint8Array[] = [];
        for (let i = 0; i < contents.length; i++) {
            const buf = contents[i];
            const filepath = recovery.filepaths[i];
            if (!filepath) {
                recovered.push(buf);
                continue;
            }
            if (buf.length > 0) {
                recovered.push(buf);
                continue;
            }
            let replaced: Uint8Array | null = null;
            let fileWasEmpty = false;
            try {
                if (isPointerPathLocal(filepath)) {
                    const filesAbs = getFilesPathForPointerLocal(dir, filepath);
                    try {
                        const rec = await fs.promises.readFile(filesAbs);
                        if (rec.length > 0) {
                            replaced = rec;
                            debugLog(
                                `[LFS Patch] Recovered empty pointer ${filepath} from files dir; proceeding with upload`
                            );
                        } else {
                            // The corresponding file exists but is empty as well
                            fileWasEmpty = true;
                        }
                    } catch {
                        // no recovered file
                    }
                }
                if (!replaced) {
                    // Pointer empty/corrupted → move it to files/corrupted/pointers and remove from pointers dir
                    let corruptedPointerAbs: string;
                    let corruptedFileAbs: string | undefined;
                    if (isPointerPathLocal(filepath)) {
                        const filesAbs = getFilesPathForPointerLocal(dir, filepath);
                        const pointerAbs = path.join(dir, filepath);
                        const relUnderPointers = path.relative(pointersRoot, pointerAbs);
                        const relUnderFiles = path.relative(filesRoot, filesAbs);
                        corruptedPointerAbs = path.join(
                            filesRoot,
                            "corrupted",
                            "pointers",
                            relUnderPointers
                        );
                        corruptedFileAbs = path.join(
                            filesRoot,
                            "corrupted",
                            "files",
                            relUnderFiles
                        );
                        await fs.promises.mkdir(path.dirname(corruptedPointerAbs), {
                            recursive: true,
                        });
                        try {
                            await fs.promises.rename(pointerAbs, corruptedPointerAbs);
                            debugLog(
                                `[LFS Patch] Moved corrupted pointer ${filepath} to: ${corruptedPointerAbs}`
                            );
                        } catch (renameErr) {
                            // Fallback: copy then unlink
                            try {
                                await fs.promises.writeFile(corruptedPointerAbs, buf);
                                await fs.promises.unlink(pointerAbs);
                                debugLog(
                                    `[LFS Patch] Copied then removed corrupted pointer ${filepath} to: ${corruptedPointerAbs}`
                                );
                            } catch (copyErr) {
                                console.warn(
                                    `[LFS Patch] Failed to move corrupted pointer ${filepath} to ${corruptedPointerAbs}:`,
                                    renameErr,
                                    copyErr
                                );
                            }
                        }

                        // If the corresponding files entry exists and is empty, move it to corrupted/files as well
                        if (fileWasEmpty) {
                            try {
                                await fs.promises.mkdir(path.dirname(corruptedFileAbs!), {
                                    recursive: true,
                                });
                                try {
                                    await fs.promises.rename(filesAbs, corruptedFileAbs!);
                                    debugLog(
                                        `[LFS Patch] Moved empty files entry for ${filepath} to: ${corruptedFileAbs}`
                                    );
                                } catch (renameFileErr) {
                                    // Fallback: write empty and unlink
                                    try {
                                        await fs.promises.writeFile(
                                            corruptedFileAbs!,
                                            new Uint8Array()
                                        );
                                        await fs.promises.unlink(filesAbs);
                                        debugLog(
                                            `[LFS Patch] Copied then removed empty files entry for ${filepath} to: ${corruptedFileAbs}`
                                        );
                                    } catch (copyFileErr) {
                                        console.warn(
                                            `[LFS Patch] Failed to move empty files entry for ${filepath} to ${corruptedFileAbs}:`,
                                            renameFileErr,
                                            copyFileErr
                                        );
                                    }
                                }
                            } catch (mkErr) {
                                console.warn(
                                    `[LFS Patch] Failed to prepare corrupted/files path for ${filepath}:`,
                                    mkErr
                                );
                            }
                        }
                    } else {
                        // Non-pointer empty file → record to files/corrupted but leave source in place
                        const normalized = filepath.replace(/\\/g, "/");
                        const corruptedAbs = path.join(filesRoot, "corrupted", normalized);
                        await fs.promises.mkdir(path.dirname(corruptedAbs), { recursive: true });
                        await fs.promises.writeFile(corruptedAbs, buf);
                        debugLog(
                            `[LFS Patch] Wrote empty file record to files/corrupted for ${filepath}: ${corruptedAbs}`
                        );
                    }
                    skipIndices.add(i);
                    recovered.push(buf);
                } else {
                    recovered.push(replaced);
                }
            } catch (e) {
                console.warn(`[LFS Patch] Error during empty-pointer recovery for ${filepath}:`, e);
                skipIndices.add(i);
                recovered.push(buf);
            }
        }
        contents = recovered;
    }

    const getAuthHeader = (_auth?: unknown): Record<string, string> => ({});

    // Filter out skipped indices before building pointer infos
    const effectiveContents: Uint8Array[] = contents.filter((_, i) => !skipIndices.has(i));
    const infos = (await Promise.all(
        effectiveContents.map((c: Uint8Array) => buildPointerInfo(c))
    )) as LfsPointerInfo[];

    // Build authentication headers - handle the auth object properly
    let authHeaders: Record<string, string> = {};
    if (auth) {
        if (auth.username && auth.password) {
            // Basic authentication
            const credentials = `${auth.username}:${auth.password}`;
            authHeaders.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
            debugLog("[LFS Patch] Using Basic auth for user:", auth.username);
        } else if (auth.token) {
            // Token authentication
            authHeaders.Authorization = `Bearer ${auth.token}`;
            debugLog("[LFS Patch] Using Bearer token auth");
        } else {
            // Try the library's getAuthHeader as fallback
            authHeaders = getAuthHeader(auth);
            debugLog("[LFS Patch] Using library's auth method");
        }
    } else {
        debugLog("[LFS Patch] No authentication provided");
    }

    // Request LFS transfer
    // If everything was skipped, return empty result
    if (effectiveContents.length === 0) {
        return [] as unknown as LfsPointerInfo[];
    }

    const lfsInfoRequestData: LFSBatchRequest = {
        operation: "upload",
        transfers: ["basic"],
        objects: infos.map((pi) => ({
            oid: String((pi as any).oid ?? pi["oid"]),
            size: Number((pi as any).size ?? 0),
        })),
    };

    debugLog("[LFS Patch] Making request to:", `${url}/info/lfs/objects/batch`);
    debugLog("[LFS Patch] Request data:", lfsInfoRequestData);
    debugLog("[LFS Patch] Auth headers:", Object.keys(authHeaders));

    const lfsInfoResponseData = await retryWithBackoff(async () => {
        const lfsInfoRes = await fetchWithTimeout(`${url}/info/lfs/objects/batch`, {
            method: "POST",
            headers: {
                ...headers,
                ...authHeaders,
                Accept: "application/vnd.git-lfs+json",
                "Content-Type": "application/vnd.git-lfs+json",
            },
            body: JSON.stringify(lfsInfoRequestData),
        });

        if (!lfsInfoRes.ok) {
            const errorText = await lfsInfoRes.text();
            const safeHeaders = Object.fromEntries(
                Object.entries({ ...headers, ...authHeaders }).map(([k, v]) =>
                    [k, /^authorization$/i.test(k) ? "[REDACTED]" : v]
                )
            );
            console.error("[LFS Patch] Request failed:");
            console.error("Status:", lfsInfoRes.status, lfsInfoRes.statusText);
            console.error("Response:", errorText);
            console.error("Request URL:", `${url}/info/lfs/objects/batch`);
            console.error("Request headers:", safeHeaders);
            const err = new Error(
                `LFS request failed with status ${lfsInfoRes.status}: ${lfsInfoRes.statusText}\nResponse: ${errorText}`
            );
            (err as any).status = lfsInfoRes.status;
            throw err;
        }

        return (await lfsInfoRes.json()) as unknown;
    }, "LFS batch API");

    debugLog("[LFS Patch] Server response:", lfsInfoResponseData);

    // Use our fixed validation
    if (!isValidLFSInfoResponseData(lfsInfoResponseData)) {
        console.error("[LFS Patch] Invalid response data:", lfsInfoResponseData);
        throw new Error("Unexpected JSON structure received for LFS upload request");
    }

    // Build a mapping from effectiveContents index → filepath for better logging.
    // recovery.filepaths aligns with the original contents array; after skip
    // filtering we need to re-index so logs show the actual filename.
    const effectiveFilepaths: string[] = [];
    if (recovery?.filepaths) {
        let effIdx = 0;
        for (let i = 0; i < contents.length; i++) {
            if (!skipIndices.has(i)) {
                effectiveFilepaths[effIdx++] = recovery.filepaths[i] ?? `<unknown index ${i}>`;
            }
        }
    }
    const fileLabel = (idx: number): string => {
        const name = effectiveFilepaths[idx];
        return name ? `file ${idx} (${name})` : `file ${idx}`;
    };

    // Upload each object (with per-file retry, concurrency-limited)
    const responseData = lfsInfoResponseData as LFSBatchResponse;
    const uploadTasks = responseData.objects.map((object, index: number) => async () => {
            const fileSize = effectiveContents[index]?.length ?? 0;

            // Server already has file
            if (!object.actions) {
                debugLog(`[LFS Patch] Server already has ${fileLabel(index)}`);
                onFileStatus?.({ index, size: fileSize, alreadyOnServer: true });
                return;
            }

            const { actions } = object;
            const upload = actions.upload;
            if (!upload?.href) {
                debugLog(`[LFS Patch] No upload action provided for ${fileLabel(index)}`);
                onFileStatus?.({ index, size: fileSize, alreadyOnServer: true });
                return;
            }

            debugLog(`[LFS Patch] Uploading ${fileLabel(index)} to:`, upload.href);
            // Use effectiveContents (not contents) so indices align after skip filtering
            const fileBytes = effectiveContents[index];
            debugLog(`[LFS Patch] File size:`, `${fileBytes.length} bytes`);

            // Build upload headers once (reused across retries)
            const uploadHeaders: Record<string, string> = {
                ...headers,
                ...(upload.header ?? {}),
                ...(upload.header?.["Content-Type"]
                    ? {}
                    : { "Content-Type": "application/octet-stream" }),
            };
            delete uploadHeaders["Transfer-Encoding"];
            delete uploadHeaders["Content-Length"];

            debugLog(`[LFS Patch] Final upload headers:`, uploadHeaders);

            // Upload with retry on transient/server errors
            await retryWithBackoff(async () => {
                try {
                    const resp = await fetchWithTimeout(upload.href, {
                        method: "PUT",
                        headers: uploadHeaders,
                        body: Buffer.from(fileBytes),
                        keepalive: false,
                        timeoutMs: 600_000,
                    });

                    if (!resp.ok) {
                        const errorText = await resp.text();
                        console.error(`[LFS Patch] Upload failed for ${fileLabel(index)}:`);
                        console.error("Status:", resp.status, resp.statusText);
                        console.error("Response:", errorText);
                        const err = new Error(
                            `Upload failed for ${fileLabel(index)}, HTTP ${resp.status}: ${resp.statusText}\nResponse: ${errorText}`
                        );
                        (err as any).status = resp.status;
                        throw err;
                    }

                    debugLog(`[LFS Patch] ${fileLabel(index)} uploaded successfully`);
                    onFileStatus?.({ index, size: fileSize, alreadyOnServer: false });
                } catch (fetchError: any) {
                    console.error(`[LFS Patch] Network error uploading ${fileLabel(index)}:`, fetchError);
                    console.error(`[LFS Patch] Error details:`, {
                        message: fetchError.message,
                        cause: fetchError.cause,
                        code: fetchError.code,
                    });

                    if (fetchError.cause) {
                        console.error(`[LFS Patch] Error cause details:`, {
                            message: fetchError.cause.message,
                            code: fetchError.cause.code,
                            errno: fetchError.cause.errno,
                            syscall: fetchError.cause.syscall,
                        });
                    }

                    // Rethrow with descriptive message; retryWithBackoff will decide whether to retry
                    if (
                        fetchError.message?.includes("certificate") ||
                        fetchError.message?.includes("SSL") ||
                        fetchError.message?.includes("TLS")
                    ) {
                        throw new Error(
                            `SSL/Certificate error uploading ${fileLabel(index)} to LFS storage. Original error: ${fetchError.message}`
                        );
                    } else if (
                        fetchError.message?.includes("ECONNREFUSED") ||
                        fetchError.message?.includes("ENOTFOUND")
                    ) {
                        throw new Error(
                            `Network connection error uploading ${fileLabel(index)} to LFS storage. Original error: ${fetchError.message}`
                        );
                    } else if (fetchError.message?.includes("timeout") || fetchError.name === "AbortError") {
                        throw new Error(
                            `Upload timeout for ${fileLabel(index)} to LFS storage. Original error: ${fetchError.message}`
                        );
                    } else if ((fetchError as any).status) {
                        // Already has status from our HTTP check above; re-throw as-is
                        throw fetchError;
                    } else {
                        throw new Error(
                            `Network error uploading ${fileLabel(index)} to LFS storage: ${fetchError.message}`
                        );
                    }
                }
            }, `LFS PUT ${fileLabel(index)}`);

            // Handle verification if required (also with retry)
            if (actions.verify) {
                debugLog(`[LFS Patch] Verifying ${fileLabel(index)}`);
                await retryWithBackoff(async () => {
                    const verificationResp = await fetchWithTimeout(actions.verify!.href, {
                        method: "POST",
                        headers: {
                            ...(actions.verify!.header ?? {}),
                            Accept: "application/vnd.git-lfs+json",
                            "Content-Type": "application/vnd.git-lfs+json",
                        },
                        body: JSON.stringify({
                            oid: String((infos[index] as any).oid ?? ""),
                            size: Number((infos[index] as any).size ?? 0),
                        }),
                        timeoutMs: 30_000,
                    });

                    if (!verificationResp.ok) {
                        await verificationResp.text().catch(() => {});
                        const err = new Error(
                            `Verification failed for ${fileLabel(index)}, HTTP ${verificationResp.status}: ${verificationResp.statusText}`
                        );
                        (err as any).status = verificationResp.status;
                        throw err;
                    }
                }, `LFS verify ${fileLabel(index)}`);
            }
    });
    await runWithConcurrency(uploadTasks, LFS_UPLOAD_CONCURRENCY);

    debugLog("[LFS Patch] Upload completed successfully");
    return infos;
}

/**
 * Download a single LFS object using the batch API and returned download action
 * Exported for use by FrontierAPI
 */
export async function downloadLFSObject(
    {
        headers = {},
        url,
        auth,
    }: {
        headers?: Record<string, string>;
        url: string;
        auth?: { username?: string; password?: string; token?: string; };
    },
    object: { oid: string; size: number; },
    options?: { maxPointerDepth?: number; }
): Promise<Uint8Array> {
    const authHeaders: Record<string, string> = {
        "User-Agent": "curl/7.54", // Helpful for certain servers [[memory:5628983]]
    };

    if (auth) {
        if (auth.username && auth.password) {
            const credentials = `${auth.username}:${auth.password}`;
            authHeaders.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
        } else if (auth.token) {
            authHeaders.Authorization = `Bearer ${auth.token}`;
        }
    }

    const batchBody: LFSBatchRequest = {
        operation: "download",
        transfers: ["basic"],
        objects: [
            {
                oid: object.oid,
                size: object.size,
            },
        ],
    };

    const batchResp = await fetchWithTimeout(`${url}/info/lfs/objects/batch`, {
        method: "POST",
        headers: {
            ...headers,
            ...authHeaders,
            Accept: "application/vnd.git-lfs+json",
            "Content-Type": "application/vnd.git-lfs+json",
        },
        body: JSON.stringify(batchBody),
    });

    if (!batchResp.ok) {
        const errorText = await batchResp.text();
        throw new Error(
            `LFS download batch failed: ${batchResp.status} ${batchResp.statusText}\nResponse: ${errorText}`
        );
    }

    const data = (await batchResp.json()) as LFSBatchResponse;
    const obj = data.objects?.[0];
    const download = obj?.actions?.download;
    if (!download?.href) {
        const code = (obj as any)?.error?.code;
        const msg = (obj as any)?.error?.message;
        const details = [code, msg].filter(Boolean).join(" ");
        const suffix = details ? ` (${details})` : "";
        throw new Error(
            `LFS download action missing in batch response for oid ${object.oid}${suffix}`
        );
    }

    const dlHeaders: Record<string, string> = {
        ...headers,
        ...(download.header ?? {}),
    };

    const fileResp = await fetchWithTimeout(download.href, {
        method: "GET",
        headers: dlHeaders,
        keepalive: false,
        timeoutMs: 600_000,
    });

    if (!fileResp.ok) {
        const errorText = await fileResp.text();
        throw new Error(
            `LFS object download failed: ${fileResp.status} ${fileResp.statusText}\nResponse: ${errorText}`
        );
    }

    const arr = new Uint8Array(await fileResp.arrayBuffer());

    // Detect accidental nested LFS pointers (pointer stored as LFS content). If so, follow once or twice.
    try {
        const maxDepth = options?.maxPointerDepth ?? 5;
        let depth = 0;
        let bytes = arr;
        // Only inspect small prefix as text to avoid heavy decode on large binaries
        while (depth < maxDepth) {
            const previewLength = Math.min(bytes.length, 600);
            const preview = new TextDecoder().decode(bytes.subarray(0, previewLength));
            // Quick check for LFS pointer signature
            if (!/git-lfs\.github\.com\/spec\/v1/.test(preview)) {
                break;
            }
            const oidMatch = preview.match(/\boid\s+sha256:([0-9a-f]{64})\b/i);
            const sizeMatch = preview.match(/\bsize\s+(\d+)\b/);
            if (!oidMatch || !sizeMatch) {
                break;
            }
            const nested = { oid: oidMatch[1], size: Number(sizeMatch[1]) };
            // Fetch the nested target
            bytes = new Uint8Array(
                await downloadLFSObject({ headers, url, auth }, nested, {
                    maxPointerDepth: 0,
                })
            );
            depth += 1;
        }
        return bytes;
    } catch {
        // If parsing or nested fetch fails, just return original bytes
        return arr;
    }
}

export class GitService {
    private stateManager: StateManager;
    private debugLogging: boolean = false;

    // Progress tracking for heartbeat
    private progressTracker?: {
        lastProgressUpdate: number;
        lastProgressValue: number;
        currentPhase: string;
    };
    private heartbeatFailureCount: number = 0;
    private progressCallback?: (
        phase: string,
        loaded?: number,
        total?: number,
        description?: string
    ) => void;

    constructor(stateManager: StateManager) {
        this.stateManager = stateManager;
        // Check VS Code configuration for debug logging setting
        this.debugLogging = vscode.workspace
            .getConfiguration("frontier")
            .get("debugGitLogging", false);
    }

    /**
     * Update sync progress for heartbeat and UI
     */
    private static readonly USER_FRIENDLY_PHASE: Record<string, string> = {
        pushing: "Uploading changes",
        fetching: "Downloading changes",
    };

    private static formatBytes(bytes: number): string {
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)} KB`;
        }
        if (bytes < 1024 * 1024 * 1024) {
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        }
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    private updateSyncProgress(
        phase: string,
        event: {
            loaded?: number;
            total?: number;
            phase?: string;
            transferInfo?: string;
        },
    ): void {
        const now = Date.now();
        const current = event.loaded || 0;
        const total = event.total || 0;

        // When event.phase comes from raw git stderr (e.g. "writing objects",
        // "receiving objects") replace it with a user-friendly label derived
        // from the high-level phase so end-users never see git internals.
        const friendly = GitService.USER_FRIENDLY_PHASE[phase];
        let description: string;
        if (event.phase && friendly) {
            const pct = total > 0 ? Math.round((current / total) * 100) : 0;
            // When all objects have been sent, the server is still processing;
            // show a distinct message so the UI doesn't appear stuck at 100%.
            if (pct >= 100 && phase === "pushing") {
                description = "Finishing upload...";
            } else {
                const sizePart = this.extractTransferSize(event.transferInfo);
                const details = [
                    total > 0 ? `${pct}%` : undefined,
                    sizePart,
                ].filter(Boolean).join(" — ");
                description = details ? `${friendly} (${details})` : friendly;
            }
        } else if (event.phase) {
            description = total > 0 ? `${event.phase}: ${current}/${total}` : event.phase;
        } else if (total > 0) {
            description = `${phase}: ${current}/${total}`;
        } else {
            description = phase;
        }

        // Track real progress
        if (this.progressTracker && current > this.progressTracker.lastProgressValue) {
            this.progressTracker.lastProgressUpdate = now;
            this.progressTracker.lastProgressValue = current;
        }

        // Update lock file with progress
        this.stateManager
            .updateLockHeartbeat({
                timestamp: now,
                lastProgress: this.progressTracker?.lastProgressUpdate || now,
                phase,
                progress: {
                    current,
                    total,
                    description,
                },
            })
            .catch((error) => {
                // Don't fail sync if heartbeat fails, just log
                this.debugLog(`[GitService] Failed to update progress: ${error}`);
            });

        // Call UI progress callback if provided
        if (this.progressCallback) {
            try {
                this.progressCallback(phase, current, total, description);
            } catch (error) {
                this.debugLog(`[GitService] Failed to call progress callback: ${error}`);
            }
        }
    }

    /**
     * Pull the cumulative transfer size from git's progress suffix and
     * normalise it to a human-readable string.
     *
     * Input examples: "1.20 MiB | 500.00 KiB/s", "1003 bytes", "256 bytes"
     * Output examples: "1.20 MiB", "1.0 KB", "256 B"
     */
    private extractTransferSize(transferInfo?: string): string | undefined {
        if (!transferInfo) {
            return undefined;
        }
        const sizePart = transferInfo.split("|")[0].trim();
        if (!sizePart) {
            return undefined;
        }

        const match = sizePart.match(/^([\d.]+)\s*(bytes?|[KMGT]i?B)$/i);
        if (!match) {
            return sizePart;
        }

        const value = parseFloat(match[1]);
        const unit = match[2].toLowerCase();

        if (unit === "byte" || unit === "bytes") {
            if (value < 1024) {
                return `${Math.round(value)} B`;
            }
            if (value < 1024 * 1024) {
                return `${(value / 1024).toFixed(1)} KB`;
            }
            return `${(value / (1024 * 1024)).toFixed(1)} MB`;
        }

        return sizePart;
    }

    /**
     * Reconcile pointers/files for the repository:
     * - For every path in status: if it's under pointers, and content is a pointer, ensure files dir has bytes.
     * - If under pointers but content is not pointer (blob), upload to LFS, rewrite as pointer, and write bytes to files dir.
     */
    private async reconcilePointersFilesystem(
        dir: string,
        auth: { username: string; password: string; }
    ): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "📂 ",
                cancellable: false,
            },
            async (progress) => {
                this.debugLog("[GitService] Starting reconcilePointersFilesystem", { dir });

                const remoteUrl = await this.getRemoteUrl(dir);
                if (!remoteUrl) {
                    this.debugLog("[GitService] No remote URL found, skipping reconciliation");
                    return;
                }

                const { cleanUrl, auth: embedded } = GitService.parseGitUrl(remoteUrl);
                const effectiveAuth = auth ?? embedded;
                const lfsBaseUrl = cleanUrl.endsWith(".git") ? cleanUrl : `${cleanUrl}.git`;
                this.debugLog("[GitService] Reconciliation config", {
                    cleanUrl,
                    lfsBaseUrl,
                    hasEmbeddedAuth: !!embedded,
                });

                // Respect per-repo media strategy for downloads:
                // - stream-only: no downloads
                // - stream-and-save: no bulk downloads (only convert local blobs); downloads happen on-demand in editor
                // - auto-download: allow downloads
                let enableDownloads = true;
                try {
                    const strategy = this.stateManager.getRepoStrategy(dir);
                    if (strategy === "stream-only") {
                        this.debugLog(
                            "[GitService] Stream-only mode: skipping reconciliation (no downloads, no conversions)"
                        );
                        return;
                    }
                    if (strategy === "stream-and-save") {
                        enableDownloads = false;
                        this.debugLog(
                            "[GitService] Stream-and-save mode: will skip bulk downloads; will still convert local blobs to pointers"
                        );
                    }
                } catch (strategyErr) {
                    console.warn("[GitService] Failed to read repo strategy, defaulting to auto-download:", strategyErr);
                }

                const status = await dugiteGit.statusMatrix(dir);
                const headOid = await dugiteGit.resolveRef(dir, "HEAD");
                this.debugLog("[GitService] Repository status", {
                    statusEntries: status.length,
                    headOid: headOid.substring(0, 8),
                });

                const pointerPaths = status.filter(([filepath]) => this.isPointerPath(filepath));
                const totalFiles = pointerPaths.length;

                if (totalFiles === 0) {
                    this.debugLog("[GitService] Completed reconcilePointersFilesystem");
                    return;
                }

                // Map of oid -> array of targets to write (deduplicates identical content)
                const oidToTargets = new Map<
                    string,
                    { filesAbs: string; filepath: string; size: number; }[]
                >();
                const readFailures: string[] = [];
                const conversionFailures: string[] = [];

                for (let i = 0; i < totalFiles; i++) {
                    const [filepath] = pointerPaths[i];
                    this.debugLog("[GitService] Processing pointer path", { filepath });

                    const absolutePathToFill = path.join(dir, filepath);
                    let text: string | undefined;
                    try {
                        const content = await fs.promises.readFile(absolutePathToFill, "utf8");
                        text = content;
                        this.debugLog("[GitService] Read file content", {
                            filepath,
                            contentLength: content.length,
                        });
                    } catch (error) {
                        console.warn("[GitService] Failed to read pointer file", { filepath, error });
                        readFailures.push(filepath);
                        continue;
                    }

                    const pointer = this.parseLfsPointer(text);
                    if (!pointer) {
                        // Blob placed in pointers dir → upload and rewrite pointer (local work, not a download)
                        this.debugLog("[GitService] File is not a pointer, converting to LFS", {
                            filepath,
                        });
                        try {
                            const bytes = await fs.promises.readFile(absolutePathToFill);
                            this.debugLog("[GitService] Read blob bytes", {
                                filepath,
                                size: bytes.length,
                            });

                            const infos = await uploadBlobsToLFSBucket(
                                {
                                    url: lfsBaseUrl,
                                    headers: {},
                                    auth: effectiveAuth,
                                    recovery: { dir, filepaths: [filepath] },
                                },
                                [bytes]
                            );

                            if (!infos || infos.length === 0) {
                                throw new Error(
                                    `LFS upload for ${filepath} returned no pointer info — the file may not have been uploaded`,
                                );
                            }

                            this.debugLog("[GitService] Uploaded blob to LFS", {
                                filepath,
                                oid: infos[0].oid,
                            });

                            const pointerBlob = formatPointerInfo(infos[0]);
                            await fs.promises.writeFile(
                                absolutePathToFill,
                                Buffer.from(pointerBlob)
                            );
                            await dugiteGit.add(dir, filepath);
                            this.debugLog("[GitService] Wrote pointer and staged", { filepath });

                            const filesAbs = this.getFilesPathForPointer(dir, filepath);
                            await fs.promises.mkdir(path.dirname(filesAbs), { recursive: true });
                            try {
                                await fs.promises.access(filesAbs, fs.constants.F_OK);
                                this.debugLog(
                                    `[GitService] Files dir already has ${filepath}, not overwriting`
                                );
                            } catch {
                                await fs.promises.writeFile(filesAbs, bytes);
                                this.debugLog("[GitService] Wrote bytes to files dir", {
                                    filesAbs,
                                });
                            }
                            this.debugLog(
                                `[GitService] Converted blob to pointer and wrote files dir for ${filepath}`
                            );
                        } catch (e) {
                            console.warn(
                                `[GitService] Failed to convert blob in pointers dir for ${filepath}:`,
                                e
                            );
                            conversionFailures.push(filepath);
                        }
                        continue;
                    }

                    // Pointer text present → ensure files dir has bytes (collect missing for batch download)
                    const filesAbs = this.getFilesPathForPointer(dir, filepath);
                    await fs.promises.mkdir(path.dirname(filesAbs), { recursive: true });
                    let present = true;
                    try {
                        await fs.promises.access(filesAbs, fs.constants.F_OK);
                        this.debugLog("[GitService] Files dir already has bytes", { filesAbs });
                    } catch {
                        present = false;
                        this.debugLog("[GitService] Files dir missing bytes, scheduling download", {
                            filesAbs,
                        });
                    }
                    if (!present) {
                        const targets = oidToTargets.get(pointer.oid) ?? [];
                        targets.push({ filesAbs, filepath, size: pointer.size });
                        oidToTargets.set(pointer.oid, targets);
                    }
                }

                // Surface any analysis-phase failures
                if (readFailures.length > 0 || conversionFailures.length > 0) {
                    const parts: string[] = [];
                    if (readFailures.length > 0) {
                        parts.push(
                            `${readFailures.length} pointer file(s) could not be read: ${readFailures.slice(0, 5).join(", ")}` +
                            (readFailures.length > 5 ? ` (+${readFailures.length - 5} more)` : "")
                        );
                    }
                    if (conversionFailures.length > 0) {
                        parts.push(
                            `${conversionFailures.length} blob-to-pointer conversion(s) failed: ${conversionFailures.slice(0, 5).join(", ")}` +
                            (conversionFailures.length > 5 ? ` (+${conversionFailures.length - 5} more)` : "")
                        );
                    }
                    console.warn(`[GitService] reconcilePointersFilesystem analysis issues: ${parts.join("; ")}`);
                    vscode.window.showWarningMessage(
                        `Some media files could not be processed and may be unavailable. Try syncing again.`
                    );
                }

                const oidsToDownload = enableDownloads ? Array.from(oidToTargets.keys()) : [];
                const totalToDownload = oidsToDownload.length;
                const alreadyDownloaded = totalFiles - totalToDownload;

                if (totalToDownload === 0) {
                    progress.report({ message: "✅ All files up to date" });
                    this.debugLog(
                        "[GitService] Completed reconcilePointersFilesystem (no downloads needed)"
                    );
                    return;
                }

                // Phase 2: single LFS batch request for all objects
                const authHeaders: Record<string, string> = { "User-Agent": "curl/7.54" };
                if (effectiveAuth) {
                    if ((effectiveAuth as any).username && (effectiveAuth as any).password) {
                        const credentials = `${(effectiveAuth as any).username}:${(effectiveAuth as any).password}`;
                        authHeaders.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
                    }
                }

                const batchBody: LFSBatchRequest = {
                    operation: "download",
                    transfers: ["basic"],
                    objects: oidsToDownload.map((oid) => ({
                        oid,
                        size: oidToTargets.get(oid)?.[0]?.size ?? 0,
                    })),
                };

                const batchResp = await fetchWithTimeout(`${lfsBaseUrl}/info/lfs/objects/batch`, {
                    method: "POST",
                    headers: {
                        ...authHeaders,
                        Accept: "application/vnd.git-lfs+json",
                        "Content-Type": "application/vnd.git-lfs+json",
                    },
                    body: JSON.stringify(batchBody),
                });

                if (!batchResp.ok) {
                    const errorText = await batchResp.text();
                    throw new Error(
                        `LFS download batch failed: ${batchResp.status} ${batchResp.statusText}\nResponse: ${errorText}`
                    );
                }

                const batchData = (await batchResp.json()) as LFSBatchResponse;
                const actionByOid = new Map<
                    string,
                    { href: string; header?: Record<string, string>; }
                >();
                for (const obj of batchData.objects ?? []) {
                    const dl = obj.actions?.download;
                    if (obj.oid && dl?.href) {
                        actionByOid.set(obj.oid, { href: dl.href, header: dl.header });
                    }
                }

                // Attempt healing for any missing download actions if we have local bytes (parallelized)
                const healConcurrency = vscode.workspace
                    .getConfiguration("frontier")
                    .get<number>("lfsHealConcurrency", 8);
                const healQueue = (batchData.objects ?? [])
                    .filter((obj) => obj.oid && !obj.actions?.download?.href)
                    .flatMap((obj) => {
                        const targets = oidToTargets.get(obj.oid!) ?? [];
                        return targets.map((t) => ({ oid: obj.oid!, target: t }));
                    });

                const runHealWorker = async () => {
                    for (; ;) {
                        const item = healQueue.shift();
                        if (!item) {
                            return;
                        }
                        const { oid, target } = item;
                        try {
                            this.stateManager.incrementMetric("lfsHealAttempted");
                            const exists = await fs.promises
                                .access(target.filesAbs, fs.constants.F_OK)
                                .then(() => true)
                                .catch(() => false);
                            if (!exists) {
                                continue;
                            }
                            const localBytes = await fs.promises.readFile(target.filesAbs);
                            if (localBytes.length === 0) {
                                continue;
                            }
                            this.debugLog(
                                `[GitService] Healing missing LFS object ${oid} by re-uploading from files dir`
                            );
                            await uploadBlobsToLFSBucket(
                                {
                                    url: lfsBaseUrl,
                                    headers: {},
                                    auth: effectiveAuth,
                                    recovery: { dir, filepaths: [target.filepath] },
                                },
                                [localBytes]
                            );
                            this.stateManager.incrementMetric("lfsHealSucceeded");
                        } catch (healErr) {
                            console.warn(
                                `[GitService] Failed to heal LFS object ${oid} for ${target.filepath}:`,
                                healErr
                            );
                            this.stateManager.incrementMetric("lfsHealFailed");
                        }
                    }
                };

                if (healQueue.length > 0) {
                    const workers = Array.from({ length: Math.max(1, healConcurrency) }, () =>
                        runHealWorker()
                    );
                    await Promise.allSettled(workers);
                }

                // After healing attempts, refetch download actions for previously missing OIDs
                const missingOids = oidsToDownload.filter((oid) => !actionByOid.has(oid));
                if (missingOids.length > 0) {
                    try {
                        const retryBody: LFSBatchRequest = {
                            operation: "download",
                            transfers: ["basic"],
                            objects: missingOids.map((oid) => ({
                                oid,
                                size: oidToTargets.get(oid)?.[0]?.size ?? 0,
                            })),
                        };
                        const retryResp = await fetchWithTimeout(`${lfsBaseUrl}/info/lfs/objects/batch`, {
                            method: "POST",
                            headers: {
                                ...authHeaders,
                                Accept: "application/vnd.git-lfs+json",
                                "Content-Type": "application/vnd.git-lfs+json",
                            },
                            body: JSON.stringify(retryBody),
                        });
                        if (retryResp.ok) {
                            const retryData = (await retryResp.json()) as LFSBatchResponse;
                            for (const obj of retryData.objects ?? []) {
                                const dl = obj.actions?.download;
                                if (obj.oid && dl?.href) {
                                    actionByOid.set(obj.oid, { href: dl.href, header: dl.header });
                                }
                            }
                        }
                    } catch (e) {
                        const detail = e instanceof Error ? e.message : String(e);
                        console.error(
                            `[GitService] Retry LFS batch request after healing failed: ${detail}. ` +
                            `${missingOids.length} OID(s) will remain unavailable for download.`,
                            e
                        );
                    }
                }

                // After retry, report any remaining missing OIDs with a single notification
                const stillMissing = oidsToDownload.filter((oid) => !actionByOid.has(oid));
                if (stillMissing.length > 0) {
                    const sampleTargets = stillMissing
                        .slice(0, 3)
                        .flatMap((oid) => (oidToTargets.get(oid) ?? []).map((t) => t.filepath))
                        .slice(0, 3);
                    const sampleText =
                        sampleTargets.length > 0 ? ` e.g. ${sampleTargets.join(", ")}` : "";
                    vscode.window.showWarningMessage(
                        `${stillMissing.length} media file(s) are missing on the server and couldn't be recovered${sampleText}. The original author may need to re-upload them.`
                    );
                }

                // Phase 3: concurrent downloads with progress and connection reuse by origin
                let completed = 0;
                let downloadFailureCount = 0;
                const downloadFailedOids: string[] = [];
                const concurrency = vscode.workspace
                    .getConfiguration("frontier")
                    .get<number>("lfsDownloadConcurrency", 12);

                // Show total context: already downloaded + remaining to download
                const downloadMessage =
                    alreadyDownloaded > 0
                        ? `📎 Resuming download: ${alreadyDownloaded} of ${totalFiles} already complete`
                        : `📎 Preparing to download ${totalToDownload} files`;
                progress.report({ message: downloadMessage });

                const queue = [...oidsToDownload];
                const runWorker = async () => {
                    for (;;) {
                        const oid = queue.shift();
                        if (!oid) {
                            return;
                        }
                        const action = actionByOid.get(oid);
                        if (!action?.href) {
                            this.debugLog(`[GitService] Missing download action for oid ${oid}`);
                            completed += 1;
                            const progressMessage =
                                alreadyDownloaded > 0
                                    ? `📎 Resuming: file ${alreadyDownloaded + completed} of ${totalFiles}`
                                    : `📎 Downloading file ${completed} of ${totalToDownload}`;
                            progress.report({
                                message: progressMessage,
                            });
                            continue;
                        }

                        try {
                            const dlHeaders: Record<string, string> = { ...(action.header ?? {}) };
                            const fileResp = await fetchWithTimeout(action.href, {
                                method: "GET",
                                headers: dlHeaders,
                                keepalive: false,
                                timeoutMs: 600_000,
                            });
                            if (!fileResp.ok) {
                                const errorText = await fileResp.text();
                                throw new Error(
                                    `LFS object download failed: ${fileResp.status} ${fileResp.statusText}\nResponse: ${errorText}`
                                );
                            }
                            const bytes = new Uint8Array(await fileResp.arrayBuffer());
                            const targets = oidToTargets.get(oid) ?? [];
                            await Promise.all(
                                targets.map(async (t) => {
                                    await fs.promises.mkdir(path.dirname(t.filesAbs), {
                                        recursive: true,
                                    });
                                    await fs.promises.writeFile(t.filesAbs, bytes);
                                })
                            );
                            this.debugLog("[GitService] Downloaded LFS object", {
                                oid,
                                size: bytes.length,
                                targetCount: (oidToTargets.get(oid) ?? []).length,
                            });
                        } catch (e) {
                            console.warn(`[GitService] Failed downloading oid ${oid}:`, e);
                            downloadFailureCount++;
                            if (downloadFailedOids.length < 10) {
                                const targets = oidToTargets.get(oid) ?? [];
                                downloadFailedOids.push(
                                    ...targets.map((t) => t.filepath)
                                );
                            }
                        } finally {
                            completed += 1;
                            const progressMessage =
                                alreadyDownloaded > 0
                                    ? `📎 Resuming: file ${alreadyDownloaded + completed} of ${totalFiles}`
                                    : `📎 Downloading file ${completed} of ${totalToDownload}`;
                            progress.report({
                                message: progressMessage,
                            });
                        }
                    }
                };

                const workers = Array.from({ length: Math.max(1, concurrency) }, () => runWorker());
                await Promise.all(workers);

                if (downloadFailureCount > 0) {
                    const fileList = downloadFailedOids.slice(0, 5).join(", ");
                    const msg =
                        `${downloadFailureCount} media file(s) could not be downloaded: ${fileList}` +
                        (downloadFailedOids.length > 5 ? ` (+${downloadFailedOids.length - 5} more)` : "") +
                        `. Try syncing again to retry.`;
                    console.warn(`[GitService] ${msg}`);
                    vscode.window.showWarningMessage(msg);
                    progress.report({ message: `📎 Download complete with ${downloadFailureCount} failure(s)` });
                } else {
                    progress.report({ message: "📎 File download complete" });
                }
                this.debugLog("[GitService] Completed reconcilePointersFilesystem");
            }
        );
    }
    /**
     * Enable or disable debug logging for git operations
     */
    setDebugLogging(enabled: boolean): void {
        this.debugLogging = enabled;
    }

    /**
     * Conditional debug logging - only logs if debug logging is enabled
     */
    private debugLog(message: string, data?: any): void {
        debugLog(message, data);
    }

    /**
     * Wraps git operations with a timeout to prevent hanging indefinitely.
     *
     * When an AbortController is provided, its signal is fired on timeout so
     * that dugite wrapper functions (fetch/push/clone) can SIGTERM the child
     * git process instead of leaving it running in the background.
     */
    private async withTimeout<T>(
        operation: Promise<T>,
        timeoutMs: number = 10 * 60 * 1000, // 10 minutes
        operationName: string = "Git operation",
        remoteUrl?: string,
        abortController?: AbortController,
    ): Promise<T> {
        const startTime = Date.now();
        this.debugLog(`[GitService] Starting ${operationName} with ${timeoutMs}ms timeout`);

        let timer: ReturnType<typeof setTimeout> | undefined;

        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                abortController?.abort();
                reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });

        try {
            const result = await Promise.race([operation, timeout]);
            const duration = Date.now() - startTime;
            this.debugLog(`[GitService] ${operationName} completed successfully in ${duration}ms`);
            return result as T;
        } catch (error) {
            const duration = Date.now() - startTime;

            if (error instanceof Error && error.message.includes("timed out")) {
                console.error(
                    `[GitService] TIMEOUT: ${operationName} timed out after ${duration}ms`
                );
                console.error(`[GitService] Timeout diagnostic info:`, {
                    operation: operationName,
                    timeoutMs,
                    actualDuration: duration,
                    timestamp: new Date().toISOString(),
                    platform: process.platform,
                    possibleCauses: [
                        "Network connectivity issues",
                        "Remote server unresponsive",
                        "Firewall/proxy blocking connection",
                        "Large repository data transfer",
                        "GIT_ASKPASS credential helper not responding",
                    ],
                });

                this.logNetworkDiagnostics(remoteUrl);

                throw new Error(
                    `${operationName} failed: Network timeout after ${duration}ms. Please check your connection and try again.`
                );
            }

            console.warn(`[GitService] ${operationName} failed after ${duration}ms:`, {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                operation: operationName,
                duration,
                timestamp: new Date().toISOString(),
            });

            throw error;
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }

    /**
     * Logs network diagnostic information to help debug connectivity issues.
     * @param remoteUrl Optional git remote URL — its host will be tested alongside standard endpoints.
     */
    private async logNetworkDiagnostics(remoteUrl?: string): Promise<void> {
        this.debugLog(`[GitService] Running network diagnostics...`);

        const diagnostics = {
            timestamp: new Date().toISOString(),
            platform: process.platform,
            arch: process.arch,
            connectionTests: {} as Record<
                string,
                { status: string; responseTime?: number; httpStatus?: number; error?: string; }
            >,
        };

        const testEndpoints = [
            { name: "GitLab", url: "https://gitlab.com", timeout: 5000 },
            { name: "Frontier API", url: "https://api.frontierrnd.com", timeout: 5000 },
            { name: "Cloudflare", url: "https://1.1.1.1", timeout: 3000 },
            { name: "Google DNS", url: "https://dns.google", timeout: 3000 },
            { name: "Cloudflare.com", url: "https://cloudflare.com", timeout: 3000 },
        ];

        if (remoteUrl) {
            try {
                const parsed = new URL(remoteUrl);
                const origin = parsed.origin;
                testEndpoints.unshift({ name: `Git Remote (${parsed.hostname})`, url: origin, timeout: 5000 });
            } catch {
                // URL parsing failed — skip
            }
        }

        for (const endpoint of testEndpoints) {
            try {
                const startTime = Date.now();
                const response = await Promise.race([
                    fetch(endpoint.url, { method: "HEAD", cache: "no-store" }),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error("timeout")), endpoint.timeout)
                    ),
                ]);
                const duration = Date.now() - startTime;

                diagnostics.connectionTests[endpoint.name] = {
                    status: "success",
                    responseTime: duration,
                    httpStatus: (response as Response).status,
                };
            } catch (error) {
                diagnostics.connectionTests[endpoint.name] = {
                    status: "failed",
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }

        console.error(`[GitService] Network diagnostics:`, diagnostics);
    }

    /**
     * Extract the HTTP status code from an isomorphic-git HttpError or
     * a dugite error message.  Returns `undefined` when not identifiable.
     */
    private static extractHttpStatus(error: unknown): number | undefined {
        if (error && typeof error === "object" && (error as any).code === "HttpError") {
            return (error as any).data?.statusCode as number | undefined;
        }
        const msg = error instanceof Error ? error.message : String(error);
        const match = msg.match(/\b(4\d{2}|5\d{2})\b/);
        return match ? parseInt(match[1], 10) : undefined;
    }

    /**
     * Detect whether a push error is a non-fast-forward rejection that can
     * be recovered by re-fetching and fast-forwarding before retrying.
     *
     * Native dugite surfaces this in stderr text; isomorphic-git throws a
     * PushRejectedError with `.code === "PushRejectedError"` and
     * `.data.reason === "not-fast-forward"`.  The `originalError` parameter
     * lets us check the structured code directly, surviving minification.
     */
    private static isNonFastForwardError(msg: string, originalError?: unknown): boolean {
        if (
            originalError &&
            typeof originalError === "object" &&
            (originalError as any).code === "PushRejectedError"
        ) {
            const reason = (originalError as any).data?.reason;
            return reason === "not-fast-forward" || reason === undefined;
        }
        return (
            msg.includes("non-fast-forward") ||
            msg.includes("rejected") ||
            msg.includes("One or more branches were not updated") ||
            msg.includes("failed to update ref")
        );
    }

    /**
     * Safe push operation with timeout, abort-on-timeout, and automatic
     * retry on non-fast-forward rejection (fetch + fast-forward + push).
     */
    private async safePush(
        dir: string,
        auth: { username: string; password: string; },
        options?: { ref?: string; timeoutMs?: number; }
    ): Promise<void> {
        const { ref, timeoutMs = 10 * 60 * 1000 } = options || {};
        const MAX_PUSH_RETRIES = 2;

        this.debugLog(`[GitService] Starting push operation:`, {
            directory: dir,
            ref: ref || "HEAD",
            timeoutMs,
            timestamp: new Date().toISOString(),
        });

        let remoteUrl: string | undefined;
        try {
            const branch = await dugiteGit.currentBranch(dir);
            remoteUrl = await this.getRemoteUrl(dir);
            this.debugLog(`[GitService] Push context:`, {
                currentBranch: branch,
                remoteUrl,
                hasAuth: !!auth.username,
            });
        } catch (contextError) {
            console.warn(`[GitService] Could not gather push context:`, contextError);
        }

        console.log(`[GitService] ⬆️  Pushing changes to origin${ref ? ` (${ref})` : ""}`);
        if (this.progressCallback) {
            this.progressCallback("pushing", 0, 0, "Uploading changes");
        }

        for (let attempt = 0; attempt <= MAX_PUSH_RETRIES; attempt++) {
            const pushController = new AbortController();
            const pushOperation = dugiteGit.push(dir, auth, {
                ...(ref && { ref }),
                signal: pushController.signal,
                onProgress: (phase, loaded, total) => {
                    console.log(
                        `[GitService] ⬆️  Push progress: ${phase || "uploading"} ${loaded || 0}/${total || 0}`
                    );
                    this.updateSyncProgress("pushing", { phase, loaded, total });
                },
            });

            try {
                await this.withTimeout(pushOperation, timeoutMs, "Push operation", remoteUrl, pushController);
                console.log("[GitService] ✓ Push completed successfully");
                this.debugLog(`[GitService] Push completed successfully`);
                if (this.progressCallback) {
                    this.progressCallback("pushing", 1, 1, "Upload complete");
                }
                return;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const gitStderr = (error as any)?.originalError?.gitStderr ?? (error as any)?.gitStderr ?? "";
                const fullMsg = `${errorMessage} ${gitStderr}`;

                // On non-fast-forward, fetch + fast-forward and retry the push
                if (GitService.isNonFastForwardError(fullMsg, error) && attempt < MAX_PUSH_RETRIES) {
                    const currentBranch = ref || (await dugiteGit.currentBranch(dir)) || "main";
                    console.warn(
                        `[GitService] Push rejected (non-fast-forward), attempt ${attempt + 1}/${MAX_PUSH_RETRIES + 1} — fetching and fast-forwarding before retry`,
                    );
                    try {
                        const retryFetchCtrl = new AbortController();
                        await this.withTimeout(
                            dugiteGit.fetchOrigin(dir, auth, undefined, retryFetchCtrl.signal),
                            2 * 60 * 1000,
                            "Push-retry fetch",
                            remoteUrl,
                            retryFetchCtrl,
                        );
                        const ffCtrl = new AbortController();
                        await this.withTimeout(
                            dugiteGit.fastForward(dir, currentBranch, auth, ffCtrl.signal),
                            2 * 60 * 1000,
                            "Push-retry fast-forward",
                            remoteUrl,
                            ffCtrl,
                        );
                        continue;
                    } catch (ffErr) {
                        this.debugLog("[GitService] Fast-forward during push retry failed — giving up:", {
                            error: ffErr instanceof Error ? ffErr.message : String(ffErr),
                        });
                    }
                }

                console.error(`[GitService] Push operation failed:`, {
                    error: errorMessage,
                    directory: dir,
                    ref: ref || "HEAD",
                    attempt: attempt + 1,
                    timestamp: new Date().toISOString(),
                });

                let userFriendlyMessage = "push failed";
                const httpStatus = GitService.extractHttpStatus(error);
                if (errorMessage.includes("ENOTFOUND") || errorMessage.includes("getaddrinfo")) {
                    userFriendlyMessage =
                        "push failed: Cannot reach server (check internet connection)";
                } else if (httpStatus === 401 || errorMessage.includes("401") || errorMessage.includes("authentication")) {
                    userFriendlyMessage =
                        "push failed: Authentication failed (try logging out and back in)";
                } else if (httpStatus === 403 || errorMessage.includes("403") || errorMessage.includes("forbidden")) {
                    userFriendlyMessage = "push failed: Access denied (check your project permissions)";
                } else if (errorMessage.includes("timeout") || errorMessage.includes("ETIMEDOUT")) {
                    userFriendlyMessage = "push failed: Connection timeout (server not responding)";
                } else if (GitService.isNonFastForwardError(fullMsg, error)) {
                    userFriendlyMessage =
                        "push failed: Remote has newer changes that could not be merged automatically. Please sync again.";
                } else if (httpStatus && httpStatus >= 500) {
                    userFriendlyMessage = `push failed: Server error (HTTP ${httpStatus})`;
                }

                const enhancedError = new Error(userFriendlyMessage);
                (enhancedError as any).originalError = error;
                throw enhancedError;
            }
        }
    }

    /**
     * Check if a sync operation is currently in progress
     */
    isSyncLocked(): boolean {
        return this.stateManager.isSyncLocked();
    }

    // Below is a simplified version. It commits if dirty, fetches remote changes, tries pulling (which will error on merge conflicts), and then either pushes or returns a list of files that differ.
    async syncChanges(
        dir: string,
        auth: { username: string; password: string; },
        author: { name: string; email: string; },
        options?: {
            commitMessage?: string;
            onProgress?: (
                phase: string,
                loaded?: number,
                total?: number,
                description?: string
            ) => void;
        }
    ): Promise<SyncResult> {
        // Check if sync is already in progress
        if (this.stateManager.isSyncLocked()) {
            this.debugLog("Sync already in progress, skipping this request");
            return { hadConflicts: false, skippedDueToLock: true };
        }

        // Try to acquire the sync lock
        const lockAcquired = await this.stateManager.acquireSyncLock(dir);
        if (!lockAcquired) {
            this.debugLog("Failed to acquire sync lock, skipping this request");
            return { hadConflicts: false, skippedDueToLock: true };
        }

        // Initialize progress tracker and callback
        this.progressTracker = {
            lastProgressUpdate: Date.now(),
            lastProgressValue: 0,
            currentPhase: "starting",
        };
        this.heartbeatFailureCount = 0;
        this.progressCallback = options?.onProgress;

        // Start heartbeat (updates every 15 seconds)
        const lockHeartbeat = setInterval(async () => {
            try {
                await this.stateManager.updateLockHeartbeat({
                    timestamp: Date.now(),
                    lastProgress: this.progressTracker?.lastProgressUpdate || Date.now(),
                    phase: this.progressTracker?.currentPhase || "syncing",
                });
                this.heartbeatFailureCount = 0; // Reset on success
                this.debugLog("[GitService] ✓ Heartbeat updated");
            } catch (error) {
                this.heartbeatFailureCount++;
                console.error(
                    `[GitService] ✗ Heartbeat failed (${this.heartbeatFailureCount}/3):`,
                    error
                );
                if (this.heartbeatFailureCount >= 3) {
                    console.error("[GitService] CRITICAL: 3 consecutive heartbeat failures!");
                }
            }
        }, HEARTBEAT_INTERVAL);

        // Track uploaded LFS files for post-sync cleanup
        let uploadedLfsFiles: string[] = [];

        try {
            const currentBranch = await dugiteGit.currentBranch(dir);
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            // 1. Commit local changes if needed
            this.progressTracker.currentPhase = "committing";
            const { isDirty, status: workingCopyStatusBeforeCommit } =
                await this.getWorkingCopyState(dir);
            if (isDirty) {
                // Count changed files for progress reporting
                const changedFiles = workingCopyStatusBeforeCommit.filter(
                    (entry) => entry[1] !== entry[2] || entry[2] !== entry[3]
                ).length;

                console.log(
                    `[GitService] 💾 Committing ${changedFiles} file${changedFiles !== 1 ? "s" : ""} to local repository`
                );
                this.debugLog(
                    `Working copy is dirty, committing ${changedFiles} file(s) (LFS-aware)`
                );
                if (this.progressCallback) {
                    const commitMsg =
                        changedFiles > 0
                            ? `Committing ${changedFiles} file${changedFiles !== 1 ? "s" : ""}`
                            : "Committing local changes";
                    this.progressCallback("committing", 0, changedFiles, commitMsg);
                }
                uploadedLfsFiles = await this.addAllWithLFS(dir, auth);
                if (uploadedLfsFiles.length > 0) {
                    this.debugLog(
                        `[GitService] Uploaded ${uploadedLfsFiles.length} LFS file(s) during commit:`,
                        uploadedLfsFiles
                    );
                }
                await this.commit(dir, options?.commitMessage || "Local changes", author);
                console.log(
                    `[GitService] ✓ Committed ${changedFiles} file${changedFiles !== 1 ? "s" : ""} successfully`
                );
                if (this.progressCallback) {
                    const committedMsg =
                        changedFiles > 0
                            ? `Committed ${changedFiles} file${changedFiles !== 1 ? "s" : ""}`
                            : "Local changes committed";
                    this.progressCallback("committing", changedFiles, changedFiles, committedMsg);
                }
            } else {
                console.log("[GitService] ✓ Working directory clean, no files to commit");
            }

            // 2. Check if we're online
            if (!(await this.isOnline())) {
                return { hadConflicts: false, offline: true, uploadedLfsFiles };
            }

            // 3. Fetch remote changes to get latest state
            this.progressTracker.currentPhase = "fetching";
            const remoteUrl = await this.getRemoteUrl(dir);
            console.log("[GitService] ⬇️  Fetching remote changes from origin");
            this.debugLog("[GitService] Fetching remote changes", { remoteUrl });
            if (this.progressCallback) {
                this.progressCallback("fetching", 0, 0, "Checking for remote changes");
            }
            try {
                const fetchController = new AbortController();
                await this.withTimeout(
                    dugiteGit.fetchOrigin(dir, auth, (phase, loaded, total, transferInfo) => {
                        console.log(
                            `[GitService] ⬇️  Fetch progress: ${phase || "downloading"} ${loaded || 0}/${total || 0}`
                        );
                        this.updateSyncProgress("fetching", { phase, loaded, total, transferInfo });
                    }, fetchController.signal),
                    2 * 60 * 1000,
                    "Fetch operation",
                    remoteUrl,
                    fetchController,
                );
                console.log("[GitService] ✓ Fetch completed successfully");
                this.debugLog("[GitService] Fetch completed successfully");
                if (this.progressCallback) {
                    this.progressCallback("fetching", 1, 1, "Remote check complete");
                }
            } catch (fetchError) {
                const errorMessage =
                    fetchError instanceof Error ? fetchError.message : String(fetchError);
                const gitStderr = (fetchError as any)?.gitStderr;
                console.error("[GitService] Fetch operation failed:", {
                    error: errorMessage,
                    gitStderr: gitStderr || "(not available — likely JS-level timeout)",
                    directory: dir,
                    remoteUrl,
                    hasAuth: !!auth.username,
                    platform: process.platform,
                    timestamp: new Date().toISOString(),
                });

                let userFriendlyMessage = "fetch failed";
                const fetchHttpStatus = GitService.extractHttpStatus(fetchError);
                if (errorMessage.includes("ENOTFOUND") || errorMessage.includes("getaddrinfo")) {
                    userFriendlyMessage =
                        "fetch failed: Cannot reach server (check internet connection)";
                } else if (
                    fetchHttpStatus === 401 ||
                    errorMessage.includes("401") ||
                    errorMessage.includes("authentication")
                ) {
                    userFriendlyMessage =
                        "fetch failed: Authentication failed (try logging out and back in)";
                } else if (fetchHttpStatus === 403 || errorMessage.includes("403") || errorMessage.includes("forbidden")) {
                    userFriendlyMessage =
                        "fetch failed: Access denied (check your project permissions)";
                } else if (
                    errorMessage.includes("could not read Username") ||
                    errorMessage.includes("could not read Password") ||
                    errorMessage.includes("terminal prompts disabled")
                ) {
                    userFriendlyMessage =
                        "fetch failed: Credential helper error (try logging out and back in)";
                } else if (errorMessage.includes("timeout") || errorMessage.includes("ETIMEDOUT")) {
                    userFriendlyMessage =
                        "fetch failed: Connection timeout (server not responding)";
                } else if (errorMessage.includes("ECONNREFUSED")) {
                    userFriendlyMessage = "fetch failed: Connection refused (server may be down)";
                } else if (errorMessage.includes("SSL") || errorMessage.includes("certificate")) {
                    userFriendlyMessage =
                        "fetch failed: SSL/certificate error (check system certificates)";
                } else if (fetchHttpStatus && fetchHttpStatus >= 500) {
                    userFriendlyMessage = `fetch failed: Server error (HTTP ${fetchHttpStatus})`;
                }

                const enhancedError = new Error(userFriendlyMessage);
                (enhancedError as any).originalError = fetchError;
                throw enhancedError;
            }

            // 4. Get references to current state
            let localHead = await dugiteGit.resolveRef(dir, "HEAD");
            let remoteHead;
            const remoteRef = `refs/remotes/origin/${currentBranch}`;

            // 5. Check if remote branch exists.
            // Native dugite signals a missing ref with exit code 128 ("bad revision").
            // The isomorphic-git fallback throws a NotFoundError instead.
            // Other failures (repo corruption, permission errors) must propagate
            // so they aren't silently hidden behind a blind push.
            try {
                remoteHead = await dugiteGit.resolveRef(dir, remoteRef);
            } catch (err) {
                const isRefNotFound =
                    (err instanceof dugiteGit.GitOperationError && err.exitCode === 128) ||
                    (err instanceof Error && (err as any).code === "NotFoundError");
                if (isRefNotFound) {
                    this.debugLog("Remote branch doesn't exist, pushing our changes");
                    await this.safePush(dir, auth);
                    return { hadConflicts: false, uploadedLfsFiles };
                }
                throw err;
            }

            // Get files changed in local HEAD (this doesn't need updating after refetch)
            const localStatusMatrix = await dugiteGit.statusMatrix(dir);

            this.debugLog("workingCopyStatusBeforeCommit:", workingCopyStatusBeforeCommit);
            this.debugLog("localStatusMatrix:", localStatusMatrix);

            // 6. If local and remote are identical, nothing to do
            if (localHead === remoteHead) {
                console.log("[GitService] ✓ Local and remote are already in sync");
                this.debugLog("Local and remote are already in sync");
                if (this.progressCallback) {
                    // Check if we need to download media files
                    const strategy = this.stateManager.getRepoStrategy(dir);
                    const needsMediaDownload = strategy === "auto-download";
                    const message = needsMediaDownload
                        ? "Project is up to date • Downloading media files for offline use"
                        : "Project is up to date";
                    this.progressCallback("syncing", 1, 1, message);
                }
                await this.reconcilePointersFilesystem(dir, auth);
                return { hadConflicts: false, uploadedLfsFiles };
            }

            // 7. Try fast-forward first (simplest case)
            try {
                console.log(
                    `[GitService] 🔀 Attempting fast-forward merge (${localHead.substring(0, 8)}..${remoteHead.substring(0, 8)})`
                );
                this.debugLog("[GitService] Attempting fast-forward merge");
                this.debugLog("[GitService] Fast-forward context:", {
                    localHead: localHead.substring(0, 8),
                    remoteHead: remoteHead.substring(0, 8),
                    currentBranch,
                    directory: dir,
                });

                if (this.progressCallback) {
                    this.progressCallback("merging", 0, 1, "Merging remote changes");
                }

                const ffController = new AbortController();
                await this.withTimeout(
                    dugiteGit.fastForward(dir, currentBranch, auth, ffController.signal),
                    2 * 60 * 1000,
                    "Fast-forward operation",
                    undefined,
                    ffController,
                );

                console.log("[GitService] ✓ Fast-forward merge completed successfully");
                if (this.progressCallback) {
                    this.progressCallback("merging", 1, 1, "Merge complete");
                }

                // Fast-forward worked, push any local changes
                this.debugLog("[GitService] Fast-forward successful, pushing any local changes");
                await this.safePush(dir, auth);

                // After integrating remote changes, reconcile pointers/files
                try {
                    await this.reconcilePointersFilesystem(dir, auth);
                } catch (e) {
                    console.warn(
                        "[GitService] Pointer reconciliation after fast-forward failed:",
                        e
                    );
                }

                return { hadConflicts: false, uploadedLfsFiles };
            } catch (err) {
                this.debugLog("[GitService] Fast-forward failed, analyzing conflicts:", {
                    error: err instanceof Error ? err.message : String(err),
                    localHead: localHead.substring(0, 8),
                    remoteHead: remoteHead.substring(0, 8),
                });
            }

            // 8. If we get here, we have divergent histories - check for conflicts
            // This can happen because:
            //   a) Fast-forward itself failed (divergent histories), OR
            //   b) Fast-forward succeeded but push failed (another user pushed concurrently)
            // In case (b), our local HEAD has already moved forward from the fast-forward,
            // so we must re-read it to get accurate merge base calculations.
            this.debugLog("Fast-forward failed or push rejected, need to handle conflicts");

            // Re-read local HEAD in case fast-forward succeeded but push failed.
            // Without this, the merge base calculation would use the stale pre-fast-forward
            // localHead, causing incorrect conflict detection and potentially losing data.
            const currentLocalHead = await dugiteGit.resolveRef(dir, "HEAD");
            if (currentLocalHead !== localHead) {
                this.debugLog("[GitService] Local HEAD moved (fast-forward succeeded, push failed):", {
                    before: localHead.substring(0, 8),
                    after: currentLocalHead.substring(0, 8),
                });
                // Update localHead for correct merge base calculation below
                localHead = currentLocalHead;
            }

            // Refetch to ensure we have the absolute latest remote state before analyzing conflicts
            this.debugLog("[GitService] Refetching remote changes before conflict analysis");
            try {
                const refetchController = new AbortController();
                await this.withTimeout(
                    dugiteGit.fetchOrigin(dir, auth, undefined, refetchController.signal),
                    2 * 60 * 1000,
                    "Pre-conflict-analysis fetch",
                    remoteUrl,
                    refetchController,
                );
                this.debugLog("[GitService] Pre-conflict-analysis fetch completed successfully");

                // After refetch, reconcile pointers/files
                try {
                    await this.reconcilePointersFilesystem(dir, auth);
                } catch (e) {
                    console.warn("[GitService] Pointer reconciliation after refetch failed:", e);
                }

                // Update remoteHead reference after the new fetch
                remoteHead = await dugiteGit.resolveRef(dir, remoteRef);
                this.debugLog(
                    "[GitService] Updated remote HEAD after refetch:",
                    remoteHead.substring(0, 8)
                );
            } catch (fetchError) {
                const detail = fetchError instanceof Error ? fetchError.message : String(fetchError);
                console.error("[GitService] Pre-conflict-analysis fetch failed:", {
                    error: detail,
                    directory: dir,
                    hasAuth: !!auth.username,
                    timestamp: new Date().toISOString(),
                });
                throw new Error(
                    `Cannot proceed with conflict analysis — failed to fetch latest remote state: ${detail}`
                );
            }

            // Recalculate merge base after potential refetch
            const updatedMergeBaseCommits = await dugiteGit.findMergeBase(dir, localHead, remoteHead);

            this.debugLog("Updated merge base commits after refetch:", updatedMergeBaseCommits);

            // Update status matrices with potentially new remote state
            const updatedRemoteStatusMatrix = await dugiteGit.statusMatrixAtRef(dir, remoteRef);
            const updatedMergeBaseStatusMatrix =
                updatedMergeBaseCommits.length > 0
                    ? await dugiteGit.statusMatrixAtRef(dir, updatedMergeBaseCommits[0])
                    : [];

            this.debugLog("updatedRemoteStatusMatrix:", updatedRemoteStatusMatrix);
            this.debugLog("updatedMergeBaseStatusMatrix:", updatedMergeBaseStatusMatrix);

            // Re-read local status matrix now. The original was captured before the fast-forward
            // attempt (step 7) and may be stale if fast-forward succeeded but push was rejected.
            let updatedLocalStatusMatrix: dugiteGit.StatusMatrixEntry[];
            try {
                updatedLocalStatusMatrix = await dugiteGit.statusMatrix(dir);
            } catch (statusErr) {
                console.warn(
                    "[GitService] statusMatrix failed during conflict analysis — using pre-fast-forward snapshot. " +
                    "Conflict detection may be slightly stale.",
                    statusErr,
                );
                updatedLocalStatusMatrix = localStatusMatrix;
            }

            // Convert status matrices to maps for easier lookup
            const localStatusMap = new Map(
                updatedLocalStatusMatrix.map((entry: any) => [entry[0], entry.slice(1)])
            );
            const remoteStatusMap = new Map(
                updatedRemoteStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );
            const mergeBaseStatusMap = new Map(
                updatedMergeBaseStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );

            // Get all unique filepaths across all three references
            const allFilepaths = new Set([
                ...localStatusMap.keys(),
                ...remoteStatusMap.keys(),
                ...mergeBaseStatusMap.keys(),
            ]);

            // Arrays to store categorized files
            const filesAddedLocally: string[] = [];
            const filesAddedOnRemote: string[] = [];
            const filesDeletedLocally: string[] = [];
            const filesDeletedOnRemote: string[] = [];
            const filesAddedInBothBranches: string[] = [];
            const filesModifiedAndTreatedAsPotentialConflict: string[] = [];

            // Analyze each file's status across all references
            for (const filepath of allFilepaths) {
                const localStatus = localStatusMap.get(filepath);
                const remoteStatus = remoteStatusMap.get(filepath);
                const mergeBaseStatus = mergeBaseStatusMap.get(filepath);

                const localExists = !!localStatus && (localStatus as any)[0] === 1;
                const remoteExists = !!remoteStatus && (remoteStatus as any)[0] === 1;
                const baseExists = !!mergeBaseStatus && (mergeBaseStatus as any)[0] === 1;

                // File exists in remote but not in local or merge base -> added on remote
                if (
                    remoteExists &&
                    !localExists &&
                    !baseExists
                ) {
                    filesAddedOnRemote.push(filepath);
                    continue;
                }

                // File exists in local but not in remote or merge base -> added locally
                if (
                    localExists &&
                    !remoteExists &&
                    !baseExists
                ) {
                    filesAddedLocally.push(filepath);
                    continue;
                }

                // File exists in both local and remote but not in merge base -> added in both branches
                // This can happen when both sides independently create the same path after diverging.
                // We must include it in conflict candidates so client-side merges (e.g., `.codex`)
                // can combine content instead of silently dropping one side.
                if (localExists && remoteExists && !baseExists) {
                    filesAddedInBothBranches.push(filepath);
                    continue;
                }

                // File exists in merge base and local but not in remote -> deleted on remote
                if (
                    baseExists &&
                    localExists &&
                    !remoteExists
                ) {
                    filesDeletedOnRemote.push(filepath);
                    continue;
                }

                // File exists in merge base and remote but not in local -> deleted locally
                if (
                    baseExists &&
                    remoteExists &&
                    !localExists
                ) {
                    filesDeletedLocally.push(filepath);
                    continue;
                }

                // File exists in all three but has different content
                if (
                    localExists &&
                    remoteExists &&
                    baseExists
                ) {
                    const localModified = (localStatus as any)[1] === 2; // workdir different from HEAD
                    const remoteModified = (remoteStatus as any)[1] === 2; // workdir different from HEAD
                    const mergeBaseModified = (mergeBaseStatus as any)[1] === 2; // merge base different from HEAD

                    // Treat all modified files as potential conflicts for simplicity
                    if (localModified || remoteModified || mergeBaseModified) {
                        filesModifiedAndTreatedAsPotentialConflict.push(filepath);
                    }
                }
            }

            this.debugLog("Files added locally:", filesAddedLocally);
            this.debugLog("Files deleted locally:", filesDeletedLocally);
            this.debugLog("Files added on remote:", filesAddedOnRemote);
            this.debugLog("Files deleted on remote:", filesDeletedOnRemote);
            this.debugLog("Files added in both branches:", filesAddedInBothBranches);
            this.debugLog(
                "Files modified and treated as potential conflict:",
                filesModifiedAndTreatedAsPotentialConflict
            );

            // All changed files for comprehensive conflict detection
            const allChangedFilePaths = [
                ...new Set([
                    ...filesAddedLocally,
                    ...filesModifiedAndTreatedAsPotentialConflict,
                    ...filesDeletedLocally,
                    ...filesAddedOnRemote,
                    ...filesDeletedOnRemote,
                    ...filesAddedInBothBranches,
                ]),
            ];

            this.debugLog("All changed files:", allChangedFilePaths);

            // Subset: file paths where remote differs from the merge base and should be applied to local.
            // NOTE: includes `filesAddedInBothBranches` because remote contains those paths.
            const remoteChangedFilePaths = [
                ...new Set([
                    ...filesAddedOnRemote,
                    ...filesDeletedOnRemote,
                    ...filesModifiedAndTreatedAsPotentialConflict,
                    ...filesAddedInBothBranches,
                ]),
            ];

            // 9. Get all files changed in either branch with enhanced conflict detection
            const conflictResults = await Promise.allSettled(
                allChangedFilePaths.map(async (filepath) => {
                    let localContent = "";
                    let remoteContent = "";
                    let baseContent = "";
                    let isNew = false;
                    let isDeleted = false;

                    // More precise determination of file status (commit existence vs merge base)
                    // Note: statusMap values are [head, workdir, stage] for the selected ref.
                    const localEntry = localStatusMap.get(filepath) as any;
                    const remoteEntry = remoteStatusMap.get(filepath) as any;
                    const baseEntry = mergeBaseStatusMap.get(filepath) as any;

                    const localExists = !!localEntry && localEntry[0] === 1;
                    const remoteExists = !!remoteEntry && remoteEntry[0] === 1;
                    const baseExists = !!baseEntry && baseEntry[0] === 1;

                    const isAddedLocally = localExists && !baseExists;
                    const isAddedRemotely = remoteExists && !baseExists;
                    const isDeletedLocally = baseExists && remoteExists && !localExists;
                    const isDeletedRemotely = baseExists && localExists && !remoteExists;

                    // Determine if this is a new file (added on either side)
                    isNew = isAddedLocally || isAddedRemotely;

                    // Determine if this should be considered deleted
                    isDeleted =
                        (isDeletedLocally && !isAddedRemotely) ||
                        (isDeletedRemotely && !isAddedLocally);

                    // Try to read local content if it exists in local HEAD
                    try {
                        if (!isDeletedLocally && !isAddedLocally) {
                            const lBlob = await dugiteGit.readBlobAtRef(dir, localHead, filepath);
                            localContent = new TextDecoder().decode(lBlob);
                        } else if (isAddedLocally) {
                            // For locally added files, read from working directory
                            try {
                                const fileContent = await fs.promises.readFile(
                                    path.join(dir, filepath),
                                    "utf8"
                                );
                                localContent = fileContent;
                            } catch (e) {
                                this.debugLog(`Error reading locally added file ${filepath}:`, e);
                            }
                        }
                    } catch (err) {
                        this.debugLog(`File ${filepath} doesn't exist in local HEAD`);
                    }

                    // Try to read remote content if it exists in remote HEAD
                    try {
                        if (!isDeletedRemotely && !isAddedRemotely) {
                            const rBlob = await dugiteGit.readBlobAtRef(dir, remoteHead, filepath);
                            remoteContent = new TextDecoder().decode(rBlob);
                        } else if (isAddedRemotely) {
                            try {
                                const rBlob = await dugiteGit.readBlobAtRef(dir, remoteHead, filepath);
                                remoteContent = new TextDecoder().decode(rBlob);
                            } catch (e) {
                                this.debugLog(`Error reading remotely added file ${filepath}:`, e);
                            }
                        }
                    } catch (err) {
                        this.debugLog(`File ${filepath} doesn't exist in remote HEAD`);
                    }

                    // Try to read base content if available
                    try {
                        if (updatedMergeBaseCommits.length > 0) {
                            const bBlob = await dugiteGit.readBlobAtRef(dir, updatedMergeBaseCommits[0], filepath);
                            baseContent = new TextDecoder().decode(bBlob);
                        }
                    } catch (err) {
                        this.debugLog(`File ${filepath} doesn't exist in merge base`);
                    }

                    // Special conflict cases handling
                    let isConflict = false;

                    // Case 1: File modified in both branches
                    if (filesModifiedAndTreatedAsPotentialConflict.includes(filepath)) {
                        isConflict = true;
                    }
                    // Case 2: Content differs between branches and at least one differs from base
                    else if (
                        localContent !== remoteContent &&
                        (localContent !== baseContent || remoteContent !== baseContent)
                    ) {
                        isConflict = true;
                    }
                    // Case 3: Added in both branches with different content
                    else if (isAddedLocally && isAddedRemotely && localContent !== remoteContent) {
                        isConflict = true;
                    }
                    // Case 4: Modified locally but deleted remotely
                    else if (
                        !isDeletedLocally &&
                        isDeletedRemotely &&
                        localContent !== baseContent
                    ) {
                        isConflict = true;
                    }
                    // Case 5: Modified remotely but deleted locally
                    else if (
                        isDeletedLocally &&
                        !isDeletedRemotely &&
                        remoteContent !== baseContent
                    ) {
                        isConflict = true;
                    }

                    if (isConflict) {
                        return {
                            filepath,
                            ours: localContent,
                            theirs: remoteContent,
                            base: baseContent,
                            isNew,
                            isDeleted,
                        };
                    }
                    return null;
                })
            );
            const conflictSettledFailures = conflictResults.filter(
                (r): r is PromiseRejectedResult => r.status === "rejected"
            );
            if (conflictSettledFailures.length > 0) {
                console.warn(
                    `[GitService] ${conflictSettledFailures.length} file(s) could not be analysed for conflicts:`,
                    conflictSettledFailures.map((f) => f.reason instanceof Error ? f.reason.message : String(f.reason))
                );
            }
            const conflicts = conflictResults
                .filter(
                    (r): r is PromiseFulfilledResult<{
                        filepath: string;
                        ours: string;
                        theirs: string;
                        base: string;
                        isNew: boolean;
                        isDeleted: boolean;
                    } | null> => r.status === "fulfilled"
                )
                .map((r) => r.value)
                .filter(
                    (v): v is {
                        filepath: string;
                        ours: string;
                        theirs: string;
                        base: string;
                        isNew: boolean;
                        isDeleted: boolean;
                    } => v !== null
                );

            this.debugLog(`Found ${conflicts.length} conflicts that need resolution`);
            return {
                hadConflicts: true,
                conflicts,
                uploadedLfsFiles,
                allChangedFilePaths,
                remoteChangedFilePaths,
            };
        } catch (err) {
            // Enhanced error logging for sync operations
            console.error(`[GitService] Sync operation failed:`, {
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                directory: dir,
                author: author.name,
                timestamp: new Date().toISOString(),
            });

            // Log additional context that might help with debugging
            try {
                const currentBranch = await dugiteGit.currentBranch(dir);
                const remoteUrl = await this.getRemoteUrl(dir);
                const status = await dugiteGit.statusMatrix(dir);

                console.error(`[GitService] Sync failure context:`, {
                    currentBranch,
                    remoteUrl,
                    statusMatrixSize: status.length,
                    dirtyFiles: status.filter(
                        (entry) => entry[1] !== entry[2] || entry[2] !== entry[3]
                    ).length,
                });
            } catch (contextError) {
                console.warn(`[GitService] Could not gather sync failure context:`, contextError);
            }

            throw err;
        } finally {
            // Clean up heartbeat, progress tracker, and callback
            if (lockHeartbeat) {
                clearInterval(lockHeartbeat);
            }
            this.progressTracker = undefined;
            this.heartbeatFailureCount = 0;
            this.progressCallback = undefined;

            // Always release the lock when done, regardless of success or failure
            await this.stateManager.releaseSyncLock();
        }
    }

    /**
     * Helper functions to identify file status from git status matrix
     * Each entry in status matrix is [filepath, head, workdir, stage]
     * - head: file exists in HEAD commit (1) or not (0)
     * - workdir: file is absent (0), identical to HEAD (1), or different from HEAD (2)
     * - stage: file is absent (0), identical to HEAD (1), identical to WORKDIR (2), or different from WORKDIR (3)
     */
    private fileStatus = {
        isNew: ([_, head, workdir]: [string, number, number, number]): boolean =>
            head === 0 && workdir === 1,

        isModified: ([_, head, workdir, stage]: [string, number, number, number]): boolean =>
            (head === 1 && workdir === 2) || // Modified compared to HEAD
            (head === 1 && workdir === 1 && workdir !== stage), // Same as HEAD but different in stage

        isDeleted: ([_, head, workdir]: [string, number, number, number]): boolean =>
            head === 1 && workdir === 0,

        hasStageChanges: ([_, head, _workdir, stage]: [string, number, number, number]): boolean =>
            stage !== head,

        hasWorkdirChanges: ([_, head, workdir]: [string, number, number, number]): boolean =>
            workdir !== head,

        isAnyChange: ([_, head, workdir, stage]: [string, number, number, number]): boolean =>
            this.fileStatus.isNew([_, head, workdir, stage]) ||
            this.fileStatus.isModified([_, head, workdir, stage]) ||
            this.fileStatus.isDeleted([_, head, workdir, stage]) ||
            this.fileStatus.hasStageChanges([_, head, workdir, stage]) ||
            this.fileStatus.hasWorkdirChanges([_, head, workdir, stage]),
    };

    /**
     * Check if the working copy has any changes
     */
    async getWorkingCopyState(dir: string): Promise<{ isDirty: boolean; status: any[]; }> {
        const status = await dugiteGit.statusMatrix(dir);
        this.debugLog(
            "Status before committing local changes:",
            JSON.stringify(
                status.filter(
                    (entry) => (entry as (string | number)[]).includes(0) || (entry as (string | number)[]).includes(2) || (entry as (string | number)[]).includes(3)
                )
            )
        );

        return { isDirty: status.some((entry) => this.fileStatus.isAnyChange(entry)), status };
    }

    /**
     * Complete a merge after conflicts have been resolved
     */
    async completeMerge(
        dir: string,
        auth: { username: string; password: string; },
        author: { name: string; email: string; },
        resolvedFiles: Array<{
            filepath: string;
            resolution: "deleted" | "created" | "modified";
        }>
    ): Promise<void> {
        // Check if sync is already in progress
        if (this.stateManager.isSyncLocked()) {
            this.debugLog("Sync already in progress, cannot complete merge");
            throw new Error("Sync operation already in progress. Please try again later.");
        }

        // Try to acquire the sync lock
        const lockAcquired = await this.stateManager.acquireSyncLock(dir);
        if (!lockAcquired) {
            this.debugLog("Failed to acquire sync lock, cannot complete merge");
            throw new Error("Failed to acquire sync lock. Please try again later.");
        }

        try {
            this.debugLog(
                "=== Starting completeMerge because client called and passed resolved files ==="
            );
            this.debugLog(`Resolved files: ${resolvedFiles.map((f) => f.filepath).join(", ")}`);

            const currentBranch = await dugiteGit.currentBranch(dir);
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            // Stage the resolved files based on their resolution type (LFS-aware).
            // Every resolved file MUST be staged successfully — if any fail, the
            // merge commit would be missing those resolutions, producing a commit
            // that silently reverts the user's conflict choices.
            const stagingFailures: Array<{ filepath: string; error: string }> = [];
            for (const { filepath, resolution } of resolvedFiles) {
                this.debugLog(
                    `Processing resolved file: ${filepath} with resolution: ${resolution}`
                );

                try {
                    if (resolution === "deleted") {
                        this.debugLog(`Removing file from git: ${filepath}`);
                        // Ensure the file is also removed from the working tree
                        // (the resolver should have done this already, but be safe).
                        const absPath = path.join(dir, filepath);
                        try {
                            await fs.promises.unlink(absPath);
                        } catch {
                            // Already gone — expected for orphaned / remote-only files
                        }
                        // --ignore-unmatch in dugiteGit.remove means this is a safe
                        // no-op when the file was never in the local index (e.g.
                        // orphaned files that only exist on the remote).
                        await dugiteGit.remove(dir, filepath);
                    } else {
                        this.debugLog(`Adding file to git (LFS-aware): ${filepath}`);
                        await this.stageResolvedFileWithLFS(dir, filepath, auth);
                    }
                } catch (stageErr) {
                    const detail = stageErr instanceof Error ? stageErr.message : String(stageErr);
                    console.error(
                        `[GitService] Failed to stage resolved file ${filepath}:`,
                        stageErr,
                    );
                    stagingFailures.push({ filepath, error: detail });
                }
            }

            if (stagingFailures.length > 0) {
                const fileList = stagingFailures
                    .map(({ filepath, error }) => `  • ${filepath}: ${error}`)
                    .join("\n");
                throw new Error(
                    `Merge aborted: ${stagingFailures.length} resolved file(s) could not be staged.\n` +
                    `${fileList}\n` +
                    `No merge commit was created — the conflict resolutions are still on disk and can be retried.`,
                );
            }

            // Fetch latest changes to ensure we have the most recent remote state
            // BEFORE we read local/remote heads to build the merge commit. This avoids
            // creating a merge commit against a stale remote head, which would cause
            // the subsequent push to be rejected as a non-fast-forward update.
            this.debugLog("[GitService] Fetching latest changes before merge completion");
            const mergeRemoteUrl = await this.getRemoteUrl(dir);
            const mergeFetchController = new AbortController();
            await this.withTimeout(
                dugiteGit.fetchOrigin(dir, auth, undefined, mergeFetchController.signal),
                2 * 60 * 1000,
                "Pre-merge fetch operation",
                mergeRemoteUrl,
                mergeFetchController,
            );

            // Get the current state AFTER fetch so our merge commit reflects the latest
            // remote tip. This guarantees that the resulting merge commit will be a
            // fast-forward of the remote (barring a race where someone pushes again
            // between this fetch and our push).
            let localHead: string;
            let remoteHead: string;
            try {
                localHead = await dugiteGit.resolveRef(dir, currentBranch);
            } catch (refErr) {
                throw new Error(
                    `Cannot resolve local branch '${currentBranch}': ${refErr instanceof Error ? refErr.message : String(refErr)}. ` +
                    `The merge was not completed — no changes have been pushed.`
                );
            }
            const remoteRef = this.getRemoteRef(currentBranch);
            try {
                remoteHead = await dugiteGit.resolveRef(dir, remoteRef);
            } catch (refErr) {
                throw new Error(
                    `Cannot resolve remote ref '${remoteRef}': the remote branch may have been deleted. ` +
                    `${refErr instanceof Error ? refErr.message : String(refErr)}. ` +
                    `The merge was not completed — no changes have been pushed.`
                );
            }
            const commitMessage = `Merge branch 'origin/${currentBranch}'`;
            this.debugLog(`Creating merge commit with message: ${commitMessage}`);

            try {
                await dugiteGit.mergeCommit(dir, commitMessage, { name: author.name, email: author.email }, [localHead, remoteHead]);
            } catch (commitError) {
                // A single-parent fallback would silently drop the remote parent
                // from the merge history, making it look like those changes never
                // existed. Instead, surface the real error so the sync layer can
                // retry or the user can investigate.
                const detail = commitError instanceof Error ? commitError.message : String(commitError);
                console.error(
                    `[GitService] mergeCommit failed (local=${localHead.substring(0, 8)}, remote=${remoteHead.substring(0, 8)}):`,
                    commitError,
                );
                throw new Error(
                    `Failed to create merge commit: ${detail}. ` +
                    `Local HEAD: ${localHead.substring(0, 8)}, Remote HEAD: ${remoteHead.substring(0, 8)}. ` +
                    `The merge was not completed — no changes have been pushed.`,
                );
            }

            // Push the merge commit with a more robust approach
            this.debugLog("Pushing merge commit");
            try {
                // Try normal push first
                await this.safePush(dir, auth, { ref: currentBranch });
                this.debugLog("Successfully pushed merge commit");

                // After successful merge and push, check for newly created files that might be LFS pointers
                this.debugLog("Reconciling pointers/files after merge");
                await this.reconcilePointersFilesystem(dir, auth);
            } catch (pushError) {
                console.error("Error pushing merge commit:", pushError);
                throw new Error(
                    `Failed to push merge commit: ${pushError instanceof Error ? pushError.message : String(pushError)}`
                );
            }

            this.debugLog("=== completeMerge completed successfully ===");
        } catch (error) {
            console.error("Complete merge error:", error);
            throw new Error(
                `Complete merge operation failed: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            // Always release the lock when done, regardless of success or failure
            await this.stateManager.releaseSyncLock();
        }
    }

    /**
     * Stage all changes in the working directory
     */
    async addAll(dir: string): Promise<void> {
        const status = await dugiteGit.statusMatrix(dir);

        // Handle deletions
        const deletedFiles = status
            .filter((entry) => this.fileStatus.isDeleted(entry))
            .map(([filepath]) => filepath);

        await dugiteGit.removeMany(dir, deletedFiles);

        // Handle modifications and additions
        const modifiedFiles = status
            .filter(
                (entry) =>
                    this.fileStatus.isNew(entry) ||
                    (this.fileStatus.hasWorkdirChanges(entry) && !this.fileStatus.isDeleted(entry))
            )
            .map(([filepath]) => filepath);

        await dugiteGit.addMany(dir, modifiedFiles);
    }

    /**
     * Stage all changes, routing LFS-tracked files through LFS upload.
     * This preserves the working tree's original binary content after staging.
     */
    async addAllWithLFS(
        dir: string,
        auth: { username: string; password: string; }
    ): Promise<string[]> {
        const status = await dugiteGit.statusMatrix(dir);
        const uploadedLfsFiles: string[] = [];

        // Handle deletions
        const deletedFiles = status
            .filter((entry) => this.fileStatus.isDeleted(entry))
            .map(([filepath]) => filepath);

        await dugiteGit.removeMany(dir, deletedFiles);

        // Handle modifications and additions
        const modifiedFiles = status
            .filter(
                (entry) =>
                    this.fileStatus.isNew(entry) ||
                    (this.fileStatus.hasWorkdirChanges(entry) && !this.fileStatus.isDeleted(entry))
            )
            .map(([filepath]) => filepath);

        // Resolve remote URL and auth once (avoids per-file lookups)
        const remoteUrl = await this.getRemoteUrl(dir);
        let lfsBaseUrl: string | undefined;
        let effectiveAuth: { username: string; password: string } | undefined;
        if (remoteUrl) {
            const { cleanUrl, auth: embeddedAuth } = GitService.parseGitUrl(remoteUrl);
            effectiveAuth = auth ?? embeddedAuth;
            lfsBaseUrl = cleanUrl.endsWith(".git") ? cleanUrl : `${cleanUrl}.git`;
        }

        // ── Phase 1: Categorise every modified file ──────────────────────
        // Files with raw bytes that must be uploaded and converted to pointers
        const rawBytesFiles: { filepath: string; bytes: Buffer }[] = [];
        // Existing pointers whose backing bytes need uploading to the new repo
        const existingPointerUploads: { filepath: string; bytes: Buffer }[] = [];
        // Non-LFS files collected for batch staging
        const nonLfsFilesToAdd: string[] = [];

        for (const filepath of modifiedFiles) {
            // Non-LFS → collect for batch add
            if (!(await this.isLfsTracked(dir, filepath))) {
                nonLfsFilesToAdd.push(filepath);
                continue;
            }

            // Unchanged LFS → skip
            if (await this.isLfsWorktreeEquivalentToHeadPointer(dir, filepath)) {
                continue;
            }

            // No remote / auth → cannot upload LFS content; staging as a regular blob
            // would permanently embed the binary in Git history, so we must abort.
            if (!remoteUrl || !lfsBaseUrl || !effectiveAuth) {
                throw new Error(
                    `Cannot stage LFS-tracked file "${filepath}" — no remote URL or credentials available. ` +
                    `Staging it as a regular Git blob would permanently bloat the repository. ` +
                    `Ensure the project has a configured remote and valid authentication before committing LFS files.`
                );
            }

            const absolutePath = path.join(dir, filepath);
            const buf = await fs.promises.readFile(absolutePath);

            // ── Already an LFS pointer? ──
            // Only catch parsing errors — if the file IS a pointer but handling
            // fails, that error must propagate (not fall through to raw upload).
            let existingPointer: ReturnType<typeof this.parseLfsPointer> | undefined;
            try {
                const asText = buf.toString("utf8");
                if (asText.length === 0) {
                    this.debugLog(
                        `[GitService] ${filepath} is empty; delegating recovery to upload helper`
                    );
                }
                existingPointer = this.parseLfsPointer(asText);
            } catch {
                existingPointer = undefined;
            }
            if (existingPointer) {
                    this.debugLog(
                        `[GitService] ${filepath} is already an LFS pointer; staging without upload`
                    );
                    // Normalize and stage the pointer
                    const canonicalPointer = formatPointerInfo({
                        oid: existingPointer.oid,
                        size: existingPointer.size,
                    } as any);
                    await fs.promises.writeFile(absolutePath, Buffer.from(canonicalPointer));
                    await dugiteGit.add(dir, filepath);

                    if (this.isPointerPath(filepath)) {
                        // Check if files/ dir has real bytes we should upload to the new repo
                        const filesAbs = this.getFilesPathForPointer(dir, filepath);
                        let blobBytes: Buffer | undefined;
                        try {
                            blobBytes = await fs.promises.readFile(filesAbs);
                        } catch {
                            blobBytes = undefined;
                        }

                        if (blobBytes && blobBytes.length > 0) {
                            const maybePointer = this.parseLfsPointer(blobBytes.toString("utf8"));
                            if (!maybePointer) {
                                // buildPointerInfo is now imported from lfsPointerUtils
                                const info = buildPointerInfo
                                    ? await buildPointerInfo(blobBytes)
                                    : null;
                                const oid = String((info as any)?.oid ?? "");
                                const size = Number((info as any)?.size ?? 0);

                                if (
                                    oid &&
                                    size &&
                                    (oid !== existingPointer.oid ||
                                        size !== existingPointer.size)
                                ) {
                                    console.warn(
                                        `[GitService] Skipping LFS upload for ${filepath}: bytes do not match pointer`,
                                        { pointer: existingPointer, computed: { oid, size } }
                                    );
                                } else {
                                    existingPointerUploads.push({ filepath, bytes: blobBytes });
                                }
                            }
                        }

                        // Ensure files/ dir has bytes — download if missing
                        await fs.promises.mkdir(path.dirname(filesAbs), { recursive: true });
                        let hasFile = true;
                        try {
                            await fs.promises.access(filesAbs, fs.constants.F_OK);
                        } catch {
                            hasFile = false;
                        }
                        if (!hasFile) {
                            try {
                                const bytes = await downloadLFSObject(
                                    { url: lfsBaseUrl, headers: {}, auth: effectiveAuth },
                                    { oid: existingPointer.oid, size: existingPointer.size }
                                );
                                await fs.promises.writeFile(filesAbs, bytes);
                                this.debugLog(
                                    `[GitService] Downloaded missing LFS bytes for ${filepath} into files dir`
                                );
                            } catch (e) {
                                console.warn(
                                    `[GitService] Failed to download bytes for existing pointer ${filepath}:`,
                                    e
                                );
                            }
                        }
                    }
                continue; // pointer already staged — nothing more to do
            }

            // Raw bytes — needs upload + pointer creation.
            // If the file is empty and sits in the pointers path, try to recover
            // real bytes from the parallel files/ directory so the OID we compute
            // locally matches what uploadBlobsToLFSBucket will actually upload.
            let uploadBytes = buf;
            if (buf.length === 0 && this.isPointerPath(filepath)) {
                const filesAbs = this.getFilesPathForPointer(dir, filepath);
                try {
                    const recovered = await fs.promises.readFile(filesAbs);
                    if (recovered.length > 0) {
                        uploadBytes = recovered;
                        this.debugLog(
                            `[GitService] Recovered empty pointer ${filepath} from files dir for batched upload`
                        );
                    }
                } catch { /* no recovery available — corruption handled by uploadBlobsToLFSBucket */ }
            }
            rawBytesFiles.push({ filepath, bytes: uploadBytes });
        }

        // ── Phase 1b: Batch-stage all non-LFS files in one call ──────────
        if (nonLfsFilesToAdd.length > 0) {
            this.debugLog(
                `[GitService] Batch-staging ${nonLfsFilesToAdd.length} non-LFS file(s)`
            );
            await dugiteGit.addMany(dir, nonLfsFilesToAdd);
        }

        // ── Phase 2: Batch-upload raw-bytes files ────────────────────────
        if (rawBytesFiles.length > 0 && lfsBaseUrl && effectiveAuth) {
            const totalBatches = Math.ceil(rawBytesFiles.length / LFS_UPLOAD_BATCH_SIZE);
            const totalLfsBytes = rawBytesFiles.reduce((sum, f) => sum + f.bytes.length, 0);
            this.debugLog(
                `[GitService] Batch-uploading ${rawBytesFiles.length} raw LFS files in ${totalBatches} batch(es) of up to ${LFS_UPLOAD_BATCH_SIZE}`
            );

            if (this.progressCallback) {
                this.progressCallback(
                    "uploading_lfs",
                    0,
                    totalLfsBytes,
                    `Uploading media (${GitService.formatBytes(totalLfsBytes)})`,
                );
            }

            let processedBytes = 0;
            let skippedBytes = 0;
            let skippedCount = 0;
            const skippedLfsFiles: string[] = [];

            for (let i = 0; i < rawBytesFiles.length; i += LFS_UPLOAD_BATCH_SIZE) {
                const batch = rawBytesFiles.slice(i, i + LFS_UPLOAD_BATCH_SIZE);
                const batchNum = Math.floor(i / LFS_UPLOAD_BATCH_SIZE) + 1;
                this.debugLog(
                    `[GitService] Uploading batch ${batchNum}/${totalBatches} (${batch.length} files)`
                );

                const pointerInfos = await uploadBlobsToLFSBucket(
                    {
                        url: lfsBaseUrl,
                        headers: {},
                        auth: effectiveAuth,
                        recovery: { dir, filepaths: batch.map((f) => f.filepath) },
                    },
                    batch.map((f) => f.bytes),
                    (status) => {
                        processedBytes += status.size;
                        if (status.alreadyOnServer) {
                            skippedBytes += status.size;
                            skippedCount++;
                        }
                        if (this.progressCallback) {
                            const pct = totalLfsBytes > 0
                                ? Math.round((processedBytes / totalLfsBytes) * 100)
                                : 100;
                            const skippedPart = skippedBytes > 0
                                ? ` — ${GitService.formatBytes(skippedBytes)} already synced`
                                : "";
                            this.progressCallback(
                                "uploading_lfs",
                                processedBytes,
                                totalLfsBytes,
                                `Uploading media (${pct}% — ${GitService.formatBytes(processedBytes)} of ${GitService.formatBytes(totalLfsBytes)}${skippedPart})`,
                            );
                        }
                    },
                );

                // uploadBlobsToLFSBucket may skip corrupted/empty files, so the
                // returned infos may be shorter than the batch.  Match by OID.
                const resultByOid = new Map<string, LfsPointerInfo>();
                for (const pi of pointerInfos) {
                    resultByOid.set(String((pi as any).oid ?? ""), pi);
                }

                for (let j = 0; j < batch.length; j++) {
                    const { filepath, bytes } = batch[j];

                    // Compute local OID to match against upload results
                    const localInfo = buildPointerInfo
                        ? await buildPointerInfo(bytes)
                        : null;
                    const localOid = localInfo
                        ? String((localInfo as any).oid ?? "")
                        : "";
                    const matchedInfo = localOid
                        ? resultByOid.get(localOid)
                        : undefined;

                    if (!matchedInfo) {
                        console.warn(
                            `[GitService] LFS upload skipped for "${filepath}" — file may be empty or corrupted. ` +
                            `It will NOT be included in this commit.`
                        );
                        skippedLfsFiles.push(filepath);
                        continue;
                    }

                    // Write pointer file and stage
                    const pointerBlob = formatPointerInfo(matchedInfo);
                    const absolutePath = path.join(dir, filepath);
                    await fs.promises.writeFile(absolutePath, Buffer.from(pointerBlob));
                    await dugiteGit.add(dir, filepath);

                    // Ensure files/ dir has the raw bytes
                    if (this.isPointerPath(filepath)) {
                        const filesAbs = this.getFilesPathForPointer(dir, filepath);
                        await fs.promises.mkdir(path.dirname(filesAbs), { recursive: true });
                        try {
                            await fs.promises.access(filesAbs, fs.constants.F_OK);
                            this.debugLog(
                                `[GitService] Files dir already has ${filepath}, not overwriting`
                            );
                        } catch {
                            await fs.promises.writeFile(filesAbs, bytes);
                        }
                    }

                    uploadedLfsFiles.push(filepath);
                }
            }

            if (skippedCount > 0) {
                this.debugLog(
                    `[GitService] ${skippedCount} LFS file(s) already on server (${GitService.formatBytes(skippedBytes)} skipped)`
                );
            }

            if (skippedLfsFiles.length > 0) {
                console.warn(
                    `[GitService] ${skippedLfsFiles.length} LFS file(s) could not be uploaded (empty or corrupted) ` +
                    `and were excluded from the commit: ${skippedLfsFiles.join(", ")}. ` +
                    `Check these files and try again.`,
                );
            }
        }

        // ── Phase 3: Batch-upload existing-pointer bytes (fork publish) ──
        if (existingPointerUploads.length > 0 && lfsBaseUrl && effectiveAuth) {
            this.debugLog(
                `[GitService] Batch-uploading ${existingPointerUploads.length} existing pointer byte(s)`
            );
            for (let i = 0; i < existingPointerUploads.length; i += LFS_UPLOAD_BATCH_SIZE) {
                const batch = existingPointerUploads.slice(i, i + LFS_UPLOAD_BATCH_SIZE);
                try {
                    await uploadBlobsToLFSBucket(
                        {
                            url: lfsBaseUrl,
                            headers: {},
                            auth: effectiveAuth,
                            recovery: {
                                dir,
                                filepaths: batch.map((f) => f.filepath),
                            },
                        },
                        batch.map((f) => f.bytes)
                    );
                    this.debugLog(
                        `[GitService] Uploaded batch of ${batch.length} existing pointer byte(s)`
                    );
                } catch (e) {
                    const detail = e instanceof Error ? e.message : String(e);
                    throw new Error(
                        `Failed to upload existing LFS pointer bytes (batch starting at index ${i}, ` +
                        `${batch.length} file(s): ${batch.map((f) => f.filepath).join(", ")}). ` +
                        `These pointers would reference objects missing from the server. ` +
                        `Error: ${detail}`
                    );
                }
            }
        }

        return uploadedLfsFiles;
    }

    /**
     * Prepare LFS bytes for publish when stream-only or stream-and-save is active.
     * Temporarily switches to auto-download to allow LFS downloads, then returns the original strategy.
     */
    public async prepareLfsBytesForPublish(
        dir: string,
        auth: { username: string; password: string; }
    ): Promise<MediaFilesStrategy | undefined> {
        const originalStrategy = this.stateManager.getRepoStrategy(dir);
        if (originalStrategy !== "stream-only" && originalStrategy !== "stream-and-save") {
            return undefined;
        }

        await this.stateManager.setRepoStrategy(dir, "auto-download");
        try {
            await this.reconcilePointersFilesystem(dir, auth);
        } catch (error) {
            await this.stateManager.setRepoStrategy(dir, originalStrategy);
            throw error;
        }

        return originalStrategy;
    }

    /**
     * Restore the original media strategy after publish.
     * For stream-only/stream-and-save, repopulate files with pointers.
     */
    public async restoreMediaStrategyAfterPublish(
        dir: string,
        originalStrategy?: MediaFilesStrategy
    ): Promise<void> {
        if (!originalStrategy) return;

        await this.stateManager.setRepoStrategy(dir, originalStrategy);
        if (originalStrategy === "stream-only" || originalStrategy === "stream-and-save") {
            await this.populateFilesWithPointers(dir);
        }
    }

    /**
     * Download LFS objects for pointers using a provided LFS base URL.
     * This is used during publish when the new repo lacks LFS objects
     * but we can fetch bytes from the source repo's LFS endpoint.
     */
    public async downloadLfsObjectsForPublish(
        dir: string,
        auth: { username: string; password: string; },
        lfsBaseUrl: string
    ): Promise<number> {
        try {
            const pointersDir = path.join(dir, ".project", "attachments", "pointers");
            if (!fs.existsSync(pointersDir)) {
                return 0;
            }

            const pointerFiles = await this.findAllFilesRecursively(pointersDir);
            let downloadedCount = 0;

            for (const pointerFilePath of pointerFiles) {
                try {
                    const relativePath = path.relative(pointersDir, pointerFilePath);
                    const filesAbs = path.join(
                        dir,
                        ".project",
                        "attachments",
                        "files",
                        relativePath
                    );

                    // If files/ already has real bytes, skip
                    let needsDownload = true;
                    try {
                        const fileBuf = await fs.promises.readFile(filesAbs);
                        const maybePointer = this.parseLfsPointer(fileBuf.toString("utf8"));
                        if (!maybePointer) {
                            needsDownload = false;
                        }
                    } catch {
                        // missing file -> download
                    }

                    if (!needsDownload) continue;

                    const pointerText = await fs.promises.readFile(pointerFilePath, "utf8");
                    const pointer = this.parseLfsPointer(pointerText);
                    if (!pointer) {
                        continue;
                    }

                    const bytes = await downloadLFSObject(
                        { url: lfsBaseUrl, headers: {}, auth },
                        { oid: pointer.oid, size: pointer.size }
                    );

                    await fs.promises.mkdir(path.dirname(filesAbs), { recursive: true });
                    await fs.promises.writeFile(filesAbs, bytes);
                    downloadedCount++;
                } catch (e) {
                    console.warn("[GitService] Failed to download LFS bytes for publish:", e);
                }
            }

            return downloadedCount;
        } catch (e) {
            console.warn("[GitService] downloadLfsObjectsForPublish failed:", e);
            return 0;
        }
    }

    /**
     * Create a commit with the given message
     */
    async commit(
        dir: string,
        message: string,
        author: { name: string; email: string; }
    ): Promise<string> {
        return dugiteGit.commit(dir, message, { name: author.name, email: author.email });
    }

    // ========== UTILITY METHODS ==========

    async clone(
        url: string,
        dir: string,
        auth?: { username: string; password: string; },
        mediaStrategy?: "auto-download" | "stream-and-save" | "stream-only"
    ): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Downloading project...",
                cancellable: false,
            },
            async (progress) => {
                try {
                    // Ensure the directory exists
                    const dirUri = vscode.Uri.file(dir);
                    await vscode.workspace.fs.createDirectory(dirUri);

                    const cloneCtrl = new AbortController();
                    await this.withTimeout(
                        dugiteGit.clone(url, dir, auth ?? undefined, (phase, loaded, total) => {
                            if (phase === "receiving objects") {
                                const percent = total ? Math.round(((loaded ?? 0) / total) * 100) : 0;
                                progress.report({
                                    message: `${percent}% complete`,
                                    increment: ((loaded ?? 0) / (total || 1)) * 100,
                                });
                            }
                        }, cloneCtrl.signal),
                        15 * 60 * 1000,
                        "Clone",
                        url,
                        cloneCtrl,
                    );
                } catch (error) {
                    console.error("Clone error:", error);
                    throw new Error(
                        `Failed to download project: ${error instanceof Error ? error.message : "Unknown error"}`
                    );
                }
            }
        );

        // Handle media files (LFS) based on strategy
        if (auth) {
            const strategy = mediaStrategy || "auto-download";

            switch (strategy) {
                case "auto-download":
                    // Background — don't block project open, but notify on failure
                    this.reconcilePointersFilesystem(dir, auth).catch((e: unknown) => {
                        const detail = e instanceof Error ? e.message : String(e);
                        console.error("[GitService] Background media download failed:", e);
                        vscode.window.showWarningMessage(
                            `Some media files couldn't be downloaded. They may be unavailable until the next sync.`
                        );
                    });
                    break;

                case "stream-and-save":
                    // Populate is CRITICAL for consistency — let errors propagate
                    this.debugLog(
                        "[GitService] Media strategy set to stream-and-save - populating files folder with pointers"
                    );
                    await this.populateFilesWithPointers(dir);
                    break;

                case "stream-only":
                    // Populate is CRITICAL for consistency — let errors propagate
                    this.debugLog(
                        "[GitService] Media strategy set to stream-only - populating files folder with pointers"
                    );
                    await this.populateFilesWithPointers(dir);
                    break;

                default:
                    await this.reconcilePointersFilesystem(dir, auth);
            }
        }
    }

    /**
     * Populate files folder with pointers from pointers folder
     * This is critical for stream-only and stream-and-save modes to maintain consistency
     * @param dir - Project directory
     */
    private async populateFilesWithPointers(dir: string): Promise<void> {
        try {
            const pointersDir = path.join(dir, ".project", "attachments", "pointers");
            const filesDir = path.join(dir, ".project", "attachments", "files");

            // Check if pointers directory exists
            if (!fs.existsSync(pointersDir)) {
                this.debugLog("[populateFilesWithPointers] No pointers directory found, skipping");
                return;
            }

            // Find all pointer files recursively
            const pointerFiles = await this.findAllFilesRecursively(pointersDir);
            this.debugLog(
                `[populateFilesWithPointers] Found ${pointerFiles.length} pointer files to copy`
            );

            // Copy each pointer file to files directory
            let copiedCount = 0;
            const copyFailures: string[] = [];
            for (const pointerFilePath of pointerFiles) {
                try {
                    // Get relative path from pointers directory
                    const relativePath = path.relative(pointersDir, pointerFilePath);
                    const targetPath = path.join(filesDir, relativePath);

                    // Create parent directory
                    const targetDir = path.dirname(targetPath);
                    if (!fs.existsSync(targetDir)) {
                        await fs.promises.mkdir(targetDir, { recursive: true });
                    }

                    // Copy pointer file
                    await fs.promises.copyFile(pointerFilePath, targetPath);
                    copiedCount++;
                } catch (error) {
                    const rel = path.relative(pointersDir, pointerFilePath);
                    console.error(`[populateFilesWithPointers] Failed to copy ${rel}:`, error);
                    copyFailures.push(rel);
                }
            }

            this.debugLog(
                `[populateFilesWithPointers] Copied ${copiedCount} pointer files to files folder`
            );

            if (copyFailures.length > 0) {
                throw new Error(
                    `populateFilesWithPointers: ${copyFailures.length} of ${pointerFiles.length} ` +
                    `pointer file(s) could not be copied to the files directory. ` +
                    `Media references will be broken for: ${copyFailures.slice(0, 10).join(", ")}` +
                    (copyFailures.length > 10 ? ` (and ${copyFailures.length - 10} more)` : "")
                );
            }
        } catch (error) {
            console.error("[populateFilesWithPointers] Error:", error);
            throw error;
        }
    }

    /**
     * Recursively find all files in a directory
     * @param dir - Directory to search
     * @returns Array of file paths
     */
    private async findAllFilesRecursively(dir: string, maxDepth: number = 50): Promise<string[]> {
        const files: string[] = [];
        const stack: Array<{ dirPath: string; depth: number }> = [{ dirPath: dir, depth: 0 }];

        while (stack.length > 0) {
            const { dirPath, depth } = stack.pop()!;
            if (depth > maxDepth) {
                this.debugLog(`[findAllFilesRecursively] Max depth exceeded at ${dirPath}`);
                continue;
            }
            try {
                const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name);
                    if (entry.isDirectory()) {
                        stack.push({ dirPath: fullPath, depth: depth + 1 });
                    } else if (entry.isFile()) {
                        files.push(fullPath);
                    }
                }
            } catch (error) {
                this.debugLog(`[findAllFilesRecursively] Error reading ${dirPath}:`, error);
            }
        }

        return files;
    }

    async add(dir: string, filepath: string): Promise<void> {
        await dugiteGit.add(dir, filepath);
    }

    async init(dir: string): Promise<void> {
        try {
            await dugiteGit.init(dir);
        } catch (error) {
            console.error("Init error:", error);
            throw new Error(
                `Failed to set up project: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    async getRemoteUrl(dir: string): Promise<string | undefined> {
        try {
            const remotes = await dugiteGit.listRemotes(dir);
            const origin = remotes.find((remote) => remote.remote === "origin");
            return origin?.url;
            // const sanitizedUrl = this.stripCredentialsFromUrl(origin?.url || "");
            // return sanitizedUrl;
        } catch (error) {
            console.error("Error getting remote URL:", error);
            return undefined;
        }
    }

    async getRemotes(dir: string): Promise<Array<{ remote: string; url: string; }>> {
        return dugiteGit.listRemotes(dir);
    }

    async addRemote(dir: string, name: string, url: string): Promise<void> {
        try {
            await dugiteGit.addRemote(dir, name, url);
        } catch (error) {
            const isAlreadyExists =
                (error instanceof Error && error.message.includes("already exists")) ||
                (error && typeof error === "object" && (error as any).code === "AlreadyExistsError");
            if (isAlreadyExists) {
                const existingRemotes = await dugiteGit.listRemotes(dir);
                const oldUrl = existingRemotes.find((r) => r.remote === name)?.url;
                await dugiteGit.deleteRemote(dir, name);
                try {
                    await dugiteGit.addRemote(dir, name, url);
                } catch (readdError) {
                    if (oldUrl) {
                        try {
                            await dugiteGit.addRemote(dir, name, oldUrl);
                        } catch {
                            // Best-effort restore
                        }
                    }
                    throw readdError;
                }
            } else {
                throw error;
            }
        }
    }

    async hasGitRepository(dir: string): Promise<boolean> {
        try {
            await dugiteGit.resolveRef(dir, "HEAD");
            return true;
        } catch (error) {
            return false;
        }
    }

    async configureAuthor(dir: string, name: string, email: string): Promise<void> {
        await this.setConfig(dir, "user.name", name);
        await this.setConfig(dir, "user.email", email);
    }

    async setConfig(dir: string, path: string, value: string): Promise<void> {
        await dugiteGit.setConfig(dir, path, value);
    }

    async push(
        dir: string,
        auth: { username: string; password: string; },
        options?: {}
    ): Promise<void> {
        await this.safePush(dir, auth, options);
    }

    private async ensureSingleLfsPointerHasMatchingFile(
        dir: string,
        filepath: string,
        auth: { username: string; password: string; }
    ): Promise<void> {
        const remoteUrl = await this.getRemoteUrl(dir);
        if (!remoteUrl) {
            return;
        }
        const { cleanUrl, auth: embedded } = GitService.parseGitUrl(remoteUrl);
        const effectiveAuth = auth ?? embedded;
        const lfsBaseUrl = cleanUrl.endsWith(".git") ? cleanUrl : `${cleanUrl}.git`;

        const headPointer = await this.readHeadPointerInfo(dir, filepath);
        if (!headPointer) {
            return;
        }

        try {
            if (this.isPointerPath(filepath)) {
                // Write to parallel files directory only
                const filesAbs = this.getFilesPathForPointer(dir, filepath);
                const attemptDownload = async () => {
                    const bytes = await downloadLFSObject(
                        { url: lfsBaseUrl, headers: {}, auth: effectiveAuth },
                        { oid: headPointer.oid, size: headPointer.size }
                    );
                    await fs.promises.mkdir(path.dirname(filesAbs), { recursive: true });
                    // Only write if the file doesn't already exist in files directory
                    try {
                        await fs.promises.access(filesAbs, fs.constants.F_OK);
                        this.debugLog(
                            `[GitService] Files dir already has ${filepath}, not overwriting`
                        );
                    } catch {
                        await fs.promises.writeFile(filesAbs, bytes);
                    }
                };

                try {
                    await attemptDownload();
                    return;
                } catch (err) {
                    console.warn(
                        `[GitService] Failed to download LFS object for ${filepath}:`,
                        err
                    );
                    const message = err instanceof Error ? err.message : String(err);
                    // If batch response omitted download action (missing on server), try to heal from local files dir
                    if (/LFS download action missing/i.test(message)) {
                        try {
                            this.stateManager.incrementMetric("lfsHealAttempted");
                            const localFilesAbs = this.getFilesPathForPointer(dir, filepath);
                            const exists = await fs.promises
                                .access(localFilesAbs, fs.constants.F_OK)
                                .then(() => true)
                                .catch(() => false);
                            if (exists) {
                                const localBytes = await fs.promises.readFile(localFilesAbs);
                                if (localBytes.length > 0) {
                                    this.debugLog(
                                        `[GitService] Healing LFS object by re-uploading from files dir for ${filepath}`
                                    );
                                    await uploadBlobsToLFSBucket(
                                        {
                                            url: lfsBaseUrl,
                                            headers: {},
                                            auth: effectiveAuth,
                                            recovery: { dir, filepaths: [filepath] },
                                        },
                                        [localBytes]
                                    );
                                    // Retry once after healing
                                    await attemptDownload();
                                    this.debugLog(
                                        `[GitService] Healed and re-downloaded LFS object for ${filepath}`
                                    );
                                    this.stateManager.incrementMetric("lfsHealSucceeded");
                                    return;
                                }
                            }
                            // If not in files/, try to download from source repo (swap/migration scenario)
                            const sourceUrl = await this.readLocalLfsSourceUrl(dir);
                            if (sourceUrl) {
                                const sourceLfsBaseUrl = sourceUrl.endsWith(".git")
                                    ? sourceUrl
                                    : `${sourceUrl}.git`;
                                const sourceBytes = await downloadLFSObject(
                                    { url: sourceLfsBaseUrl, headers: {}, auth: effectiveAuth },
                                    { oid: headPointer.oid, size: headPointer.size }
                                );
                                await fs.promises.mkdir(path.dirname(filesAbs), { recursive: true });
                                await fs.promises.writeFile(filesAbs, sourceBytes);
                                await uploadBlobsToLFSBucket(
                                    {
                                        url: lfsBaseUrl,
                                        headers: {},
                                        auth: effectiveAuth,
                                        recovery: { dir, filepaths: [filepath] },
                                    },
                                    [sourceBytes]
                                );
                                await attemptDownload();
                                this.stateManager.incrementMetric("lfsHealSucceeded");
                                return;
                            }
                            vscode.window.showWarningMessage(
                                `Media file "${path.basename(filepath)}" is missing. The original author may need to re-upload it.`
                            );
                            this.stateManager.incrementMetric("lfsHealFailed");
                        } catch (healErr) {
                            console.warn(
                                `[GitService] Healing attempt failed for ${filepath}:`,
                                healErr
                            );
                            vscode.window.showWarningMessage(
                                `Couldn't recover media file "${path.basename(filepath)}". Please re-upload the original file.`
                            );
                            this.stateManager.incrementMetric("lfsHealFailed");
                        }
                    }
                }
            } else {
                // Non-pointer path: do nothing (no smudging)
            }
        } catch (err) {
            console.warn(`[GitService] Failed to ensure LFS content for ${filepath}:`, err);
            vscode.window.showWarningMessage(
                `Media file "${path.basename(filepath)}" could not be loaded. It may become available after the next sync.`
            );
        }
    }

    private async readLocalLfsSourceUrl(dir: string): Promise<string | undefined> {
        try {
            const settingsPath = path.join(dir, ".project", "localProjectSettings.json");
            const content = await fs.promises.readFile(settingsPath, "utf8");
            const settings = JSON.parse(content);
            return settings.lfsSourceRemoteUrl;
        } catch {
            return undefined;
        }
    }

    /** Stage a resolved file in an LFS-aware way for merge completion */
    private async stageResolvedFileWithLFS(
        dir: string,
        filepath: string,
        auth: { username: string; password: string; }
    ): Promise<void> {
        // If HEAD blob is a pointer and this is a pointers path, ensure files dir has bytes; no smudging into pointer path
        const headPointer = await this.readHeadPointerInfo(dir, filepath);
        if (headPointer && this.isPointerPath(filepath)) {
            // Ensure pointer has bytes in files dir
            await this.ensureSingleLfsPointerHasMatchingFile(dir, filepath, auth);
            return;
        }

        // Otherwise, if file should be tracked by LFS, add via LFS to stage pointer and ensure real bytes are in files dir when applicable
        if (await this.isLfsTracked(dir, filepath)) {
            await this.addWithLFS(dir, filepath, auth);
            return;
        }

        // Fallback: regular add — verify the file exists first so we get a
        // clear error rather than a cryptic git exit-code if the resolver
        // failed to write the file (or it was removed between resolution
        // and staging).
        const absPath = path.join(dir, filepath);
        try {
            await fs.promises.access(absPath);
        } catch {
            throw new Error(
                `Cannot stage ${filepath}: file does not exist on disk. ` +
                `It may have been removed between conflict resolution and staging.`
            );
        }
        await dugiteGit.add(dir, filepath);
    }

    async isOnline(): Promise<boolean> {
        try {
            // Check internet connectivity by making HEAD requests and checking response codes
            const userIsOnline = await fetchWithTimeout("https://gitlab.com", {
                method: "HEAD",
                cache: "no-store",
                timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
            })
                .then(async (res) => { await res.text().catch(() => {}); return res.status === 200; })
                .catch(() => false);

            const apiEndpoint = vscode.workspace.getConfiguration("frontier").get<string>("apiEndpoint") || "https://api.frontierrnd.com/api/v1";
            const baseUrl = apiEndpoint.replace(/\/api\/v1\/?$/, "");

            const apiIsOnline = await fetchWithTimeout(baseUrl, { timeoutMs: HEALTH_CHECK_TIMEOUT_MS })
                .then(async (res) => { await res.text().catch(() => {}); return res.status === 200; })
                .catch(() => false);

            if (!userIsOnline) {
                vscode.window.showWarningMessage(
                    "You are offline. Please connect to the internet to sync changes."
                );
            }
            if (!apiIsOnline) {
                vscode.window.showWarningMessage(
                    "The server is currently unavailable. Please try again later. Your local changes are saved and will sync when the connection is restored."
                );
            }
            return userIsOnline && apiIsOnline;
        } catch (error) {
            return false;
        }
    }

    /**
     * Helper method to get the short reference to a remote branch
     * @param branch The branch name
     * @returns The short reference to the remote branch
     */
    private getShortRemoteRef(branch: string): string {
        return `origin/${branch}`;
    }

    /**
     * Helper method to get the full reference to a remote branch
     * @param branch The branch name
     * @returns The full reference to the remote branch
     */
    private getRemoteRef(branch: string): string {
        return `refs/remotes/origin/${branch}`;
    }

    /**
     * Parse .gitattributes and return globs that have filter=lfs
     */
    private async getLfsGlobs(dir: string): Promise<string[]> {
        try {
            const attrsPath = path.join(dir, ".gitattributes");
            const text = await fs.promises.readFile(attrsPath, "utf8");
            const globs: string[] = [];

            for (const rawLine of text.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line || line.startsWith("#")) {
                    continue;
                }

                // naive split: "<pattern> attr[=val] attr[=val] ..."
                const [pattern, ...attrs] = line.split(/\s+/);
                if (!pattern) {
                    continue;
                }

                // explicitly contain "filter=lfs"
                const hasLfs = attrs.some((a) => /^filter\s*=\s*lfs$/i.test(a));
                if (hasLfs) {
                    globs.push(pattern);
                }
            }
            return globs;
        } catch {
            // No .gitattributes is fine
            return [];
        }
    }

    /**
     * Very small glob -> RegExp converter supporting "*", "?", and "**"
     */
    private globToRegExp(glob: string): RegExp {
        // Escape regex specials except *, ?, which we'll handle separately
        let s = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");

        // Handle ** first (multi-segment match including path separators)
        s = s.replace(/\*\*/g, "§DOUBLESTAR§");

        // Handle remaining single * (match anything except path separator)
        s = s.replace(/\*/g, "[^/]*");

        // Handle ? (match single char except path separator)
        s = s.replace(/\?/g, "[^/]");

        // Restore ** replacement
        s = s.replace(/§DOUBLESTAR§/g, ".*");

        return new RegExp("^" + s + "$");
    }

    /** Returns true if a repo-relative path is inside the pointers directory */
    private isPointerPath(filepath: string): boolean {
        const normalized = filepath.replace(/\\/g, "/");
        return normalized.includes(".project/attachments/pointers");
    }

    /** Maps a repo-relative pointers path to its files counterpart absolute path */
    private getFilesPathForPointer(dir: string, pointerRelativePath: string): string {
        const normalized = pointerRelativePath.replace(/\\/g, "/");
        // Replace both with and without a leading slash
        const filesRelative = normalized
            .replace("/.project/attachments/pointers/", "/.project/attachments/files/")
            .replace(".project/attachments/pointers/", ".project/attachments/files/");
        return path.join(dir, filesRelative);
    }

    private async isLfsTracked(dir: string, filepath: string): Promise<boolean> {
        const globs = await this.getLfsGlobs(dir);
        // console.log(`[GitService] ${filepath} is LFS-tracked: ${globs.length > 0}`);
        // console.log(`[GitService] ${filepath} globs: ${globs}`);
        if (globs.length === 0) {
            return false;
        }

        // Normalize to forward slashes relative to repo root
        const rel = filepath.replace(/\\/g, "/");
        // console.log(`[GitService] ${filepath} rel: ${rel}`);
        for (const g of globs) {
            const re = this.globToRegExp(g);
            // console.log(`[GitService] ${filepath} re: ${re}`);
            // If the pattern contains a path separator, test against the full relative path.
            // Otherwise, test against the basename so patterns like "*.webm" match in any folder.
            const subject = g.includes("/") ? rel : path.posix.basename(rel);
            if (re.test(subject)) {
                // console.log(`[GitService] ${filepath} re.test(rel) true`);
                return true;
            }
        }
        this.debugLog(`[GitService] ${filepath} re.test(rel) false`);
        return false;
    }

    /** Parse LFS pointer text into { oid, size } */
    private parseLfsPointer(pointerText: string): { oid: string; size: number; } | null {
        try {
            // Strip possible UTF-8 BOM and normalize
            if (pointerText && pointerText.charCodeAt(0) === 0xfeff) {
                pointerText = pointerText.slice(1);
            }
            const lines = pointerText
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            const text = lines.join("\n");
            // Be permissive: require only oid and size; version line can vary
            const oidMatch = text.match(/\boid\s+sha256:([0-9a-f]{64})\b/i);
            const sizeMatch = text.match(/\bsize\s+(\d+)\b/);
            if (!oidMatch || !sizeMatch) {
                return null;
            }
            return { oid: oidMatch[1], size: Number(sizeMatch[1]) };
        } catch {
            return null;
        }
    }

    /** Compute { oid, size } for current worktree bytes using LFS pointer algorithm */
    private async buildWorktreePointerInfo(
        dir: string,
        filepath: string
    ): Promise<{ oid: string; size: number; } | null> {
        try {
            const absPath = path.join(dir, filepath);
            const bytes = await fs.promises.readFile(absPath);
            // buildPointerInfo is now imported from lfsPointerUtils
            if (!buildPointerInfo) {
                return null;
            }
            const info = await buildPointerInfo(bytes);
            const oid = String((info as any).oid ?? "");
            const size = Number((info as any).size ?? 0);
            if (!oid) {
                return null;
            }
            return { oid, size };
        } catch {
            return null;
        }
    }

    /** Read pointer from HEAD for a file, if the HEAD blob is a valid LFS pointer */
    private async readHeadPointerInfo(
        dir: string,
        filepath: string
    ): Promise<{ oid: string; size: number; } | null> {
        try {
            const headOid = await dugiteGit.resolveRef(dir, "HEAD");
            const blob = await dugiteGit.readBlobAtRef(dir, headOid, filepath);
            const text = new TextDecoder().decode(blob);
            return this.parseLfsPointer(text);
        } catch {
            return null;
        }
    }

    /** Determine if LFS-tracked file's worktree bytes match the HEAD pointer */
    private async isLfsWorktreeEquivalentToHeadPointer(
        dir: string,
        filepath: string
    ): Promise<boolean> {
        if (this.isPointerPath(filepath)) {
            return false;
        }
        // Must be LFS-tracked, otherwise this equivalence does not apply
        if (!(await this.isLfsTracked(dir, filepath))) {
            return false;
        }

        const worktreePointer = await this.buildWorktreePointerInfo(dir, filepath);
        if (!worktreePointer) {
            return false;
        }

        const headPointer = await this.readHeadPointerInfo(dir, filepath);
        if (!headPointer) {
            return false;
        }

        const equal =
            headPointer.oid === worktreePointer.oid && headPointer.size === worktreePointer.size;
        if (!equal) {
            this.debugLog("LFS pointer mismatch:", {
                filepath,
                headPointer,
                worktreePointer,
            });
        }
        return equal;
    }

    /**
     * Upload a file to LFS and get pointer info
     */

    public static parseGitUrl(url: string): {
        cleanUrl: string;
        auth?: { username: string; password: string; };
    } {
        try {
            const urlObj = new URL(url);

            // Check if URL has embedded credentials
            if (urlObj.username || urlObj.password) {
                const auth = {
                    username: decodeURIComponent(urlObj.username),
                    password: decodeURIComponent(urlObj.password),
                };

                // Remove credentials from URL
                urlObj.username = "";
                urlObj.password = "";

                return { cleanUrl: urlObj.toString(), auth };
            }

            return { cleanUrl: url };
        } catch (error) {
            // If URL parsing fails, return as-is
            console.warn("[LFS] Could not parse URL, using as-is:", error);
            return { cleanUrl: url };
        }
    }

    /**
     * For a given path: if tracked by LFS, upload to LFS, stage pointer,
     * then restore the original content in the working tree so the user can keep working.
     */
    private async addWithLFS(
        dir: string,
        filepath: string,
        authFromCaller?: { username: string; password: string; }
    ): Promise<boolean> {
        // Verify file exists before attempting to stage it.
        // A missing file here usually means the resolver failed to write it or
        // it was removed between conflict resolution and staging (TOCTOU).
        const absolutePathToPointerFill = path.join(dir, filepath);
        try {
            await fs.promises.access(absolutePathToPointerFill);
        } catch {
            throw new Error(
                `Cannot stage ${filepath}: file does not exist on disk. ` +
                `It may have been removed between conflict resolution and staging.`
            );
        }

        // If not LFS-tracked, do normal add
        if (!(await this.isLfsTracked(dir, filepath))) {
            this.debugLog(`[GitService] ${filepath} is not LFS-tracked; adding as normal`);
            await dugiteGit.add(dir, filepath);
            return false;
        }
        this.debugLog(`[GitService] ${filepath} is LFS-tracked; adding as LFS`);
        // Read original bytes
        let buf = await fs.promises.readFile(absolutePathToPointerFill);

        // Resolve remote URL
        const remoteUrl = await this.getRemoteUrl(dir);
        if (!remoteUrl) {
            // Fall back: just add as normal if we have no remote yet
            console.warn(`[GitService] No remote URL; adding ${filepath} without LFS`);
            await dugiteGit.add(dir, filepath);
            return false;
        }
        const { cleanUrl, auth } = GitService.parseGitUrl(remoteUrl);
        // Prefer caller-provided auth over embedded auth to avoid stale embedded credentials
        const effectiveAuth = authFromCaller ?? auth;

        // Ensure repo URL includes .git to hit correct LFS endpoints on some servers
        const lfsBaseUrl = cleanUrl.endsWith(".git") ? cleanUrl : `${cleanUrl}.git`;

        this.debugLog(`[GitService] LFS base URL: ${lfsBaseUrl}`);
        this.debugLog(
            `[GitService] Using ${auth ? "embedded" : authFromCaller ? "provided" : "no"} auth for LFS`
        );

        if (!effectiveAuth) {
            console.warn(`[GitService] No auth; adding ${filepath} without LFS`);
            await dugiteGit.add(dir, filepath);
            return false;
        }

        // If the worktree file already contains an LFS pointer, avoid re-uploading.
        // Only catch parsing errors — if the file IS a pointer but handling
        // fails, that error must propagate (not fall through to raw upload).
        let existingPointer: ReturnType<typeof this.parseLfsPointer> | undefined;
        try {
            const asText = buf.toString("utf8");
            if (asText.length === 0) {
                this.debugLog(
                    `[GitService] ${filepath} is empty; delegating recovery/corruption handling to upload helper`
                );
            }
            existingPointer = this.parseLfsPointer(asText);
        } catch {
            existingPointer = undefined;
        }
        if (existingPointer) {
                this.debugLog(
                    `[GitService] ${filepath} is already an LFS pointer; staging without upload`
                );
                // Normalize pointer content and stage
                const canonicalPointer = formatPointerInfo({
                    oid: existingPointer.oid,
                    size: existingPointer.size,
                } as any);
                await fs.promises.writeFile(
                    absolutePathToPointerFill,
                    Buffer.from(canonicalPointer)
                );
                await dugiteGit.add(dir, filepath);

                if (this.isPointerPath(filepath)) {
                    // If files dir has real bytes, attempt to upload so the new repo has LFS objects
                    const absolutePathToBlobFill = this.getFilesPathForPointer(dir, filepath);
                    let blobBytes: Buffer | undefined;
                    try {
                        blobBytes = await fs.promises.readFile(absolutePathToBlobFill);
                    } catch {
                        blobBytes = undefined;
                    }

                    if (blobBytes && blobBytes.length > 0) {
                        // If files/ contains another pointer stub, skip upload
                        const maybePointer = this.parseLfsPointer(blobBytes.toString("utf8"));
                        if (!maybePointer) {
                            try {
                                // Verify bytes match the pointer OID/size before uploading
                                // buildPointerInfo is now imported from lfsPointerUtils
                                const info = buildPointerInfo ? await buildPointerInfo(blobBytes) : null;
                                const oid = String((info as any)?.oid ?? "");
                                const size = Number((info as any)?.size ?? 0);

                                if (oid && size && (oid !== existingPointer.oid || size !== existingPointer.size)) {
                                    console.warn(
                                        `[GitService] Skipping LFS upload for ${filepath}: bytes do not match pointer`,
                                        { pointer: existingPointer, computed: { oid, size } }
                                    );
                                } else {
                                    await uploadBlobsToLFSBucket(
                                        {
                                            url: lfsBaseUrl,
                                            headers: {},
                                            auth: effectiveAuth,
                                            recovery: { dir, filepaths: [filepath] },
                                        },
                                        [blobBytes]
                                    );
                                    this.debugLog(
                                        `[GitService] Uploaded LFS bytes for existing pointer ${filepath}`
                                    );
                                }
                            } catch (e) {
                                console.warn(
                                    `[GitService] Failed to upload LFS bytes for existing pointer ${filepath}:`,
                                    e
                                );
                            }
                        }
                    }

                    // Ensure parallel files directory has the real bytes; download if missing
                    await fs.promises.mkdir(path.dirname(absolutePathToBlobFill), {
                        recursive: true,
                    });
                    let hasFile = true;
                    try {
                        await fs.promises.access(absolutePathToBlobFill, fs.constants.F_OK);
                        this.debugLog(
                            `[GitService] Files dir already has ${filepath}, not overwriting`
                        );
                    } catch {
                        hasFile = false;
                    }
                    if (!hasFile) {
                        try {
                            const bytes = await downloadLFSObject(
                                { url: lfsBaseUrl, headers: {}, auth: effectiveAuth },
                                { oid: existingPointer.oid, size: existingPointer.size }
                            );
                            await fs.promises.writeFile(absolutePathToBlobFill, bytes);
                            this.debugLog(
                                `[GitService] Downloaded missing LFS bytes for ${filepath} into files dir`
                            );
                        } catch (e) {
                            console.warn(
                                `[GitService] Failed to download bytes for existing pointer ${filepath}:`,
                                e
                            );
                        }
                    }
                }
            return false; // exit early if the file is already an LFS pointer (no upload needed)
        }
        // Upload to LFS via our helper (handles batch, upload, verify and x-http-method)
        this.debugLog(`[GitService] Uploading ${filepath} to LFS`);
        const pointerInfos = await uploadBlobsToLFSBucket(
            {
                url: lfsBaseUrl,
                headers: {},
                auth: effectiveAuth, // Pass credentials (embedded or provided)
                recovery: { dir, filepaths: [filepath] },
            },
            [buf]
        );
        if (!pointerInfos || pointerInfos.length === 0) {
            this.debugLog(
                `[GitService] Upload skipped or produced no pointer (likely empty/unrecoverable) for ${filepath}`
            );
            return false;
        }
        const pointerBlob = formatPointerInfo(pointerInfos[0]);

        // Write pointer and stage it
        await fs.promises.writeFile(absolutePathToPointerFill, Buffer.from(pointerBlob));
        await dugiteGit.add(dir, filepath);
        // If the pointer lives under pointers directory, ensure materialized bytes exist in files directory
        if (this.isPointerPath(filepath)) {
            const filesAbs = this.getFilesPathForPointer(dir, filepath);
            await fs.promises.mkdir(path.dirname(filesAbs), { recursive: true });
            try {
                await fs.promises.access(filesAbs, fs.constants.F_OK);
                this.debugLog(`[GitService] Files dir already has ${filepath}, not overwriting`);
            } catch {
                await fs.promises.writeFile(filesAbs, buf);
            }
        } else {
            // Non-pointer path: do nothing (no smudging)
        }
        return true; // File was uploaded to LFS
    }
}

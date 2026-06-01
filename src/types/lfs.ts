// Types for Git LFS batch API and upload flow

export interface LfsAuth {
    username?: string;
    password?: string;
    token?: string;
}

export interface UploadBlobsOptions {
    headers?: Record<string, string>;
    url: string;
    auth?: LfsAuth;
    // Optional context for empty-pointer recovery and corrupted-record creation
    recovery?: {
        dir: string;
        filepaths: string[];
    };
}

export interface LFSAction {
    href: string;
    header?: Record<string, string>;
    expires_at?: string;
    expires_in?: number;
}

export interface LFSObject {
    oid: string;
    size: number;
    actions?: {
        upload?: LFSAction;
        download?: LFSAction;
        verify?: LFSAction;
    };
    error?: {
        code: number;
        message: string;
    };
}

export interface LFSBatchRequest {
    operation: "download" | "upload";
    transfers: string[];
    objects: Array<{ oid: string; size: number }>;
}

export interface LFSBatchResponse {
    transfer?: string;
    objects: LFSObject[];
}

// Minimal shape accepted by lfs.formatPointerInfo
export interface LfsPointerInfo {
    oid: string;
    size: number;
    // Allow library-specific extras without forcing any
    [key: string]: unknown;
}

/** Fired when a single file's upload fails transiently and is about to retry. */
export interface LfsUploadRetryEvent {
    index: number;
    label?: string;
    /** 1-based count of the retry about to happen (1 = first retry). */
    retry: number;
    /** Total number of retries that will be attempted. */
    maxRetries: number;
    /** Delay before the retry fires. */
    delayMs: number;
    /** Decoded, human-readable reason for the failure. */
    reason: string;
}

/** Fired when an in-flight upload stalls (no progress) or recovers. */
export interface LfsUploadStallEvent {
    index: number;
    label?: string;
    stalled: boolean;
}

/** Fired as a single file's bytes are streamed to the server. */
export interface LfsUploadBytesEvent {
    index: number;
    label?: string;
    /** Bytes of this file handed to the socket so far. */
    bytesSent: number;
    /** Total size of this file. */
    totalBytes: number;
}

/** Optional observers for live upload visibility (progress, retries, stalls). */
export interface LfsUploadEvents {
    onRetry?: (event: LfsUploadRetryEvent) => void;
    onStallStateChange?: (event: LfsUploadStallEvent) => void;
    onBytes?: (event: LfsUploadBytesEvent) => void;
}

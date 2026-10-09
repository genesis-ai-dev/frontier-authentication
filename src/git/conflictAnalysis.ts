/**
 * Conflict analysis for divergent histories (step 9 of GitService.syncChanges).
 *
 * Reads the local, remote and merge-base versions of every changed path and
 * decides which ones the client has to resolve. Two rules keep this safe:
 *
 * 1. Reads run with bounded concurrency. In native mode every read is a
 *    `git show` process; launching one per changed file exhausted the per-user
 *    process limit (4000 on macOS) on large remote updates (issue #40).
 * 2. A read that fails where the file is known to exist aborts the analysis
 *    with a BLOB_READ_FAILED: error. It is never treated as empty content:
 *    empty-equals-empty made remote additions vanish from the conflict list,
 *    after which the client refused to merge.
 */

/**
 * Prefix of errors thrown when a blob needed for conflict analysis could not
 * be read. codex-editor matches this exact string (by prefix) to retry the
 * sync; keep it in lock-step with
 * codex-editor/src/projectManager/utils/merge/transientSyncError.ts.
 */
export const BLOB_READ_FAILED_PREFIX = "BLOB_READ_FAILED:";

/**
 * Maximum number of files analysed at the same time. Reads are bound by
 * process spawning, not I/O: 5,247 reads took 16s at 8 workers and 14.5s at
 * both 16 and 32, so 16 keeps the process count small at no cost in speed.
 */
export const CONFLICT_ANALYSIS_CONCURRENCY = 16;

export interface FileExistence {
    /** Present in the local commit being merged. */
    local: boolean;
    /** Present in the remote commit being merged. */
    remote: boolean;
    /** Present in the merge base of the two commits. */
    base: boolean;
}

/** Everything the analysis needs from Git, injectable so it can be unit-tested. */
export interface ConflictAnalysisDeps {
    existence(filepath: string): FileExistence;
    readLocalBlob(filepath: string): Promise<string>;
    readWorkingFile(filepath: string): Promise<string>;
    readRemoteBlob(filepath: string): Promise<string>;
    readBaseBlob(filepath: string): Promise<string>;
}

export interface ConflictAnalysisOptions {
    /** Every path that differs between local, remote and merge base. */
    filepaths: readonly string[];
    /** Paths present in all three commits whose content differs; always conflicts. */
    modifiedInBoth: Iterable<string>;
    /** Defaults to CONFLICT_ANALYSIS_CONCURRENCY. */
    concurrency?: number;
}

export interface AnalyzedConflict {
    filepath: string;
    ours: string;
    theirs: string;
    base: string;
    isNew: boolean;
    isDeleted: boolean;
}

/**
 * Map `items` through `fn` with at most `concurrency` calls in flight.
 * Results keep the input order. The first rejection is re-thrown once the
 * calls already in flight have settled; no further calls are started.
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    let failure: { error: unknown } | undefined;

    const worker = async (): Promise<void> => {
        while (nextIndex < items.length && failure === undefined) {
            const index = nextIndex++;
            try {
                results[index] = await fn(items[index], index);
            } catch (error) {
                failure = failure ?? { error };
            }
        }
    };

    const requested = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
    const workerCount = Math.max(1, Math.min(requested, items.length));
    await Promise.all(Array.from({ length: workerCount }, worker));

    if (failure !== undefined) {
        throw failure.error;
    }
    return results;
}

function blobReadFailed(source: string, filepath: string, cause: unknown): Error {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(
        `${BLOB_READ_FAILED_PREFIX} could not read ${source} content of ${filepath}: ${detail}`
    );
    (error as Error & { cause?: unknown }).cause = cause;
    return error;
}

async function readOrFail(
    source: string,
    filepath: string,
    read: (filepath: string) => Promise<string>
): Promise<string> {
    try {
        return await read(filepath);
    } catch (cause) {
        throw blobReadFailed(source, filepath, cause);
    }
}

/**
 * Locally added files are read from the working tree, which is what the
 * client will merge on disk. The committed blob is the fallback: it holds
 * the same content and must exist whenever the status matrix says so.
 */
async function readLocallyAdded(deps: ConflictAnalysisDeps, filepath: string): Promise<string> {
    try {
        return await deps.readWorkingFile(filepath);
    } catch {
        return readOrFail("local", filepath, deps.readLocalBlob);
    }
}

async function analyzeFile(
    filepath: string,
    deps: ConflictAnalysisDeps,
    modifiedInBoth: ReadonlySet<string>
): Promise<AnalyzedConflict | null> {
    const { local: localExists, remote: remoteExists, base: baseExists } = deps.existence(filepath);

    const isAddedLocally = localExists && !baseExists;
    const isAddedRemotely = remoteExists && !baseExists;
    const isDeletedLocally = baseExists && remoteExists && !localExists;
    const isDeletedRemotely = baseExists && localExists && !remoteExists;

    const isNew = isAddedLocally || isAddedRemotely;
    const isDeleted =
        (isDeletedLocally && !isAddedRemotely) || (isDeletedRemotely && !isAddedLocally);

    // Only read versions that exist. Reading a ref where the file is absent
    // used to be a guaranteed failure that was indistinguishable from a real
    // one, and each attempt was a wasted git process.
    let localContent = "";
    if (isAddedLocally) {
        localContent = await readLocallyAdded(deps, filepath);
    } else if (localExists) {
        localContent = await readOrFail("local", filepath, deps.readLocalBlob);
    }

    let remoteContent = "";
    if (remoteExists) {
        remoteContent = await readOrFail("remote", filepath, deps.readRemoteBlob);
    }

    let baseContent = "";
    if (baseExists) {
        baseContent = await readOrFail("merge-base", filepath, deps.readBaseBlob);
    }

    let isConflict = false;
    if (modifiedInBoth.has(filepath)) {
        // Case 1: file modified in both branches
        isConflict = true;
    } else if (
        localContent !== remoteContent &&
        (localContent !== baseContent || remoteContent !== baseContent)
    ) {
        // Case 2: content differs between branches and at least one differs from base
        isConflict = true;
    } else if (isAddedLocally && isAddedRemotely && localContent !== remoteContent) {
        // Case 3: added in both branches with different content
        isConflict = true;
    } else if (!isDeletedLocally && isDeletedRemotely && localContent !== baseContent) {
        // Case 4: modified locally but deleted remotely
        isConflict = true;
    } else if (isDeletedLocally && !isDeletedRemotely && remoteContent !== baseContent) {
        // Case 5: modified remotely but deleted locally
        isConflict = true;
    }

    if (!isConflict) {
        return null;
    }
    return {
        filepath,
        ours: localContent,
        theirs: remoteContent,
        base: baseContent,
        isNew,
        isDeleted,
    };
}

/**
 * Decide which of `filepaths` the client must resolve. Rejects with a
 * BLOB_READ_FAILED: error if any version that should exist cannot be read,
 * so a partial conflict list is never returned.
 */
export async function analyzeConflicts(
    deps: ConflictAnalysisDeps,
    options: ConflictAnalysisOptions
): Promise<AnalyzedConflict[]> {
    const modifiedInBoth = new Set(options.modifiedInBoth);
    const concurrency = options.concurrency ?? CONFLICT_ANALYSIS_CONCURRENCY;
    const results = await mapWithConcurrency(options.filepaths, concurrency, (filepath) =>
        analyzeFile(filepath, deps, modifiedInBoth)
    );
    return results.filter((result): result is AnalyzedConflict => result !== null);
}

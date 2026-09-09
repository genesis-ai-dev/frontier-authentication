import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as dugiteGit from "./dugiteGit";

export interface SyncHeads {
    localHead: string;
    remoteHead: string;
}

/** Verify disk bytes as well as committed identity; never skip missing/local edits. */
async function worktreeMatchesBlob(
    dir: string,
    filepath: string,
    blob: dugiteGit.GitBlobEntry,
): Promise<boolean> {
    try {
        const absolutePath = path.join(dir, filepath);
        const entry = await fs.promises.lstat(absolutePath);
        if (!entry.isFile()) { return false; }
        const handle = await fs.promises.open(absolutePath, "r");
        try {
            const before = await handle.stat();
            if (!before.isFile()) { return false; }
            const executable = (before.mode & 0o111) !== 0;
            if (process.platform !== "win32" && executable !== (blob.mode === 0o100755)) {
                return false;
            }
            const hash = createHash(blob.oid.length === 64 ? "sha256" : "sha1");
            hash.update(`blob ${before.size}\0`);
            for await (const chunk of handle.createReadStream({ autoClose: false })) {
                hash.update(chunk);
            }
            const after = await handle.stat();
            const current = await fs.promises.lstat(absolutePath);
            return current.isFile() && current.ino === before.ino && current.dev === before.dev &&
                before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs &&
                current.size === after.size && current.mtimeMs === after.mtimeMs && current.ctimeMs === after.ctimeMs &&
                hash.digest("hex") === blob.oid;
        } finally {
            await handle.close();
        }
    } catch {
        // A missing/unreadable/replaced file must stay in conflict recovery.
        return false;
    }
}

/**
 * Exclude files present identically in BOTH commits, the index and on disk.
 * Tree OIDs avoid two Git processes per identical pointer. File hashing is
 * bounded and byte based, including for binary content and unusual filenames.
 */
export async function findUnchangedSyncFiles(
    dir: string,
    snapshot: SyncHeads,
    status: dugiteGit.StatusMatrixEntry[]
): Promise<Set<string>> {
    const [local, remote] = await Promise.all([
        dugiteGit.blobEntriesAtRef(dir, snapshot.localHead),
        dugiteGit.blobEntriesAtRef(dir, snapshot.remoteHead),
    ]);
    const candidates = status.filter(([filepath, head, workdir, stage]) => {
        if (head !== 1 || workdir !== 1 || stage !== 1) { return false; }
        const ours = local.get(filepath);
        const theirs = remote.get(filepath);
        return ours !== undefined && theirs !== undefined && ours.oid === theirs.oid &&
            ours.mode === theirs.mode && (ours.mode === 0o100644 || ours.mode === 0o100755);
    });
    const unchanged = new Set<string>();
    for (let i = 0; i < candidates.length; i += 8) {
        await Promise.all(candidates.slice(i, i + 8).map(async ([filepath]) => {
            if (await worktreeMatchesBlob(dir, filepath, local.get(filepath)!)) {
                unchanged.add(filepath);
            }
        }));
    }
    return unchanged;
}

/**
 * Find files absent from the local commit whose current bytes already match
 * the fetched remote commit. A staged entry is accepted only when its blob and
 * mode also match remote, so recovery never discards different staged work.
 */
export async function findRemoteEquivalentAdditions(
    dir: string,
    snapshot: SyncHeads,
    status: dugiteGit.StatusMatrixEntry[],
): Promise<Set<string>> {
    const [local, remote, index] = await Promise.all([
        dugiteGit.blobEntriesAtRef(dir, snapshot.localHead),
        dugiteGit.blobEntriesAtRef(dir, snapshot.remoteHead),
        dugiteGit.blobEntriesAtIndex(dir),
    ]);
    const candidates = status.filter(([filepath, head, workdir, stage]) => {
        if (head !== 0 || workdir === 0 || local.has(filepath)) { return false; }
        const theirs = remote.get(filepath);
        if (!theirs || (theirs.mode !== 0o100644 && theirs.mode !== 0o100755)) { return false; }
        const staged = index.get(filepath);
        if (stage === 0) { return staged === undefined; }
        return staged !== undefined && staged.oid === theirs.oid && staged.mode === theirs.mode;
    });
    const equivalent = new Set<string>();
    for (let i = 0; i < candidates.length; i += 8) {
        await Promise.all(candidates.slice(i, i + 8).map(async ([filepath]) => {
            if (await worktreeMatchesBlob(dir, filepath, remote.get(filepath)!)) {
                equivalent.add(filepath);
            }
        }));
    }
    return equivalent;
}

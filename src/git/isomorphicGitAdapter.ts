/**
 * isomorphicGitAdapter.ts — Pure-JS git implementation using isomorphic-git.
 *
 * Implements the same API surface as the native dugiteGit functions so the
 * routing layer can delegate transparently when the dugite binary is
 * unavailable.  Used when the downloaded git binary is missing or the user
 * selects "builtin" mode.
 */

import git, { type GitProgressEvent } from "isomorphic-git";
import http from "isomorphic-git/http/node";
import * as fs from "fs";
import * as path from "path";

import type { ProgressCallback, StatusMatrixEntry, LogEntry } from "./dugiteGitNative";
export type { ProgressCallback, StatusMatrixEntry, LogEntry } from "./dugiteGitNative";

// Re-export error class so the routing layer can catch uniformly
export { GitOperationError } from "./dugiteGitNative";

// ---------------------------------------------------------------------------
// Binary-path stubs (no-ops — only meaningful for native dugite)
// ---------------------------------------------------------------------------

export function setGitBinaryPath(_localGitDir: string, _execPath: string): void {
    // no-op
}

export function setAskpassPath(_scriptPath: string): void {
    // no-op
}

export function useEmbeddedGitBinary(): void {
    // no-op
}

export function isGitBinaryConfigured(): boolean {
    return false;
}

export function getGitBinaryPaths(): { localGitDir: string; execPath: string } | undefined {
    return undefined;
}

// ---------------------------------------------------------------------------
// Progress helper
// ---------------------------------------------------------------------------

function mapProgress(onProgress?: ProgressCallback): ((event: GitProgressEvent) => void) | undefined {
    if (!onProgress) return undefined;
    return (event: GitProgressEvent) => {
        onProgress(event.phase, event.loaded, event.total);
    };
}

// ---------------------------------------------------------------------------
// Git operations — Repository setup
// ---------------------------------------------------------------------------

export async function init(dir: string): Promise<void> {
    await git.init({ fs, dir, defaultBranch: "main" });
}

export async function setConfig(dir: string, key: string, value: string): Promise<void> {
    await git.setConfig({ fs, dir, path: key, value });
}

export async function disableLfsFilters(dir: string): Promise<void> {
    await setConfig(dir, "filter.lfs.process", "");
    await setConfig(dir, "filter.lfs.clean", "cat");
    await setConfig(dir, "filter.lfs.smudge", "cat");
    await setConfig(dir, "filter.lfs.required", "false");
}

// ---------------------------------------------------------------------------
// Git operations — References
// ---------------------------------------------------------------------------

export async function resolveRef(dir: string, ref: string): Promise<string> {
    return git.resolveRef({ fs, dir, ref });
}

export async function currentBranch(dir: string): Promise<string | null> {
    const branch = await git.currentBranch({ fs, dir, fullname: false });
    return branch ?? null;
}

export async function findMergeBase(dir: string, oid1: string, oid2: string): Promise<string[]> {
    const visited1 = new Set<string>();
    const visited2 = new Set<string>();

    const queue1: string[] = [oid1];
    const queue2: string[] = [oid2];

    // BFS from both sides simultaneously; the first OID seen from both
    // directions is the merge base.
    while (queue1.length > 0 || queue2.length > 0) {
        if (queue1.length > 0) {
            const current = queue1.shift()!;
            if (visited1.has(current)) continue;
            visited1.add(current);
            if (visited2.has(current)) return [current];
            try {
                const { commit: c } = await git.readCommit({ fs, dir, oid: current });
                queue1.push(...c.parent);
            } catch {
                // Invalid OID or shallow boundary
            }
        }
        if (queue2.length > 0) {
            const current = queue2.shift()!;
            if (visited2.has(current)) continue;
            visited2.add(current);
            if (visited1.has(current)) return [current];
            try {
                const { commit: c } = await git.readCommit({ fs, dir, oid: current });
                queue2.push(...c.parent);
            } catch {
                // Invalid OID or shallow boundary
            }
        }
    }
    return [];
}

// ---------------------------------------------------------------------------
// Git operations — Remotes
// ---------------------------------------------------------------------------

export async function listRemotes(dir: string): Promise<Array<{ remote: string; url: string }>> {
    const remotes = await git.listRemotes({ fs, dir });
    return remotes.map(({ remote, url }) => ({ remote, url }));
}

export async function addRemote(dir: string, name: string, url: string): Promise<void> {
    await git.addRemote({ fs, dir, remote: name, url });
}

export async function deleteRemote(dir: string, name: string): Promise<void> {
    await git.deleteRemote({ fs, dir, remote: name });
}

// ---------------------------------------------------------------------------
// Git operations — Staging & committing
// ---------------------------------------------------------------------------

export async function add(dir: string, filepath: string): Promise<void> {
    try {
        await fs.promises.access(path.join(dir, filepath));
        await git.add({ fs, dir, filepath });
    } catch {
        await git.remove({ fs, dir, filepath });
    }
}

export async function addMany(
    dir: string,
    filepaths: string[],
    _options?: { batchSize?: number; maxRetries?: number },
): Promise<void> {
    for (const filepath of filepaths) {
        await add(dir, filepath);
    }
}

export async function addAll(dir: string): Promise<void> {
    const statusRows = await git.statusMatrix({ fs, dir });
    for (const [file, , workdirStatus, stageStatus] of statusRows) {
        if (workdirStatus !== stageStatus) {
            if (workdirStatus === 0) {
                await git.remove({ fs, dir, filepath: file });
            } else {
                await git.add({ fs, dir, filepath: file });
            }
        }
    }
}

export async function remove(dir: string, filepath: string): Promise<void> {
    try {
        await git.remove({ fs, dir, filepath });
    } catch {
        // Ignore errors for files not in the index (matches --ignore-unmatch)
    }
}

export async function removeMany(
    dir: string,
    filepaths: string[],
    _options?: { batchSize?: number; maxRetries?: number },
): Promise<void> {
    for (const filepath of filepaths) {
        await remove(dir, filepath);
    }
}

export async function commit(
    dir: string,
    message: string,
    author: { name: string; email: string },
): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const timezoneOffset = new Date().getTimezoneOffset();
    const authorInfo = { name: author.name, email: author.email, timestamp, timezoneOffset };
    const oid = await git.commit({
        fs,
        dir,
        message,
        author: authorInfo,
        committer: authorInfo,
    });
    return oid;
}

export async function mergeCommit(
    dir: string,
    message: string,
    author: { name: string; email: string },
    parents: string[],
): Promise<string> {
    // Write the current index as a tree
    // isomorphic-git doesn't expose write-tree directly; we create a commit
    // with explicit parents using the low-level API.
    const timestamp = Math.floor(Date.now() / 1000);
    const timezoneOffset = new Date().getTimezoneOffset();
    const authorInfo = { name: author.name, email: author.email, timestamp, timezoneOffset };

    // Stage everything first to ensure the index matches the working tree
    const oid = await git.commit({
        fs,
        dir,
        message,
        author: authorInfo,
        committer: authorInfo,
        parent: parents,
    });
    return oid;
}

// ---------------------------------------------------------------------------
// Git operations — Remote operations (fetch, push, clone)
// ---------------------------------------------------------------------------

function onAuth(auth?: { username: string; password: string }) {
    if (!auth) return undefined;
    return () => auth;
}

export async function fetchOrigin(
    dir: string,
    auth: { username: string; password: string },
    onProgress?: ProgressCallback,
    _signal?: AbortSignal,
): Promise<void> {
    await git.fetch({
        fs,
        http,
        dir,
        remote: "origin",
        prune: true,
        onProgress: mapProgress(onProgress),
        onAuth: onAuth(auth),
    });
}

export async function fastForward(
    dir: string,
    branch: string,
    _auth: { username: string; password: string },
    _signal?: AbortSignal,
): Promise<void> {
    // Update the local branch ref to match origin/<branch>
    const remoteOid = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` });
    await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: remoteOid, force: true });

    // Checkout to update the working tree
    await git.checkout({ fs, dir, ref: branch, force: true });
}

export async function push(
    dir: string,
    auth: { username: string; password: string },
    options?: { ref?: string; onProgress?: ProgressCallback; signal?: AbortSignal },
): Promise<void> {
    const branch = options?.ref || (await currentBranch(dir)) || "main";
    await git.push({
        fs,
        http,
        dir,
        remote: "origin",
        ref: branch,
        remoteRef: branch,
        onProgress: mapProgress(options?.onProgress),
        onAuth: onAuth(auth),
    });
}

export async function clone(
    url: string,
    dir: string,
    auth?: { username: string; password: string },
    onProgressCb?: ProgressCallback,
    _signal?: AbortSignal,
): Promise<void> {
    await fs.promises.mkdir(dir, { recursive: true });
    await git.clone({
        fs,
        http,
        dir,
        url,
        singleBranch: false,
        onProgress: mapProgress(onProgressCb),
        onAuth: onAuth(auth),
    });
}

// ---------------------------------------------------------------------------
// Git operations — Status
// ---------------------------------------------------------------------------

export async function statusMatrix(dir: string): Promise<StatusMatrixEntry[]> {
    const rows = await git.statusMatrix({ fs, dir });
    return rows as StatusMatrixEntry[];
}

export async function statusMatrixAtRef(
    dir: string,
    ref: string,
): Promise<StatusMatrixEntry[]> {
    // List files at the given ref
    const refTree = await listTreeRecursive(dir, ref);
    // List files at HEAD
    let headTree: Map<string, string>;
    try {
        headTree = await listTreeRecursive(dir, "HEAD");
    } catch {
        headTree = new Map();
    }

    const allFiles = new Set([...refTree.keys(), ...headTree.keys()]);
    const entries: StatusMatrixEntry[] = [];

    for (const filepath of allFiles) {
        const inRef = refTree.has(filepath);
        const inHead = headTree.has(filepath);
        const refStatus: 0 | 1 = inRef ? 1 : 0;

        let workdir: 0 | 1 | 2 = 1;
        if (inHead && !inRef) {
            workdir = 0; // deleted in ref
        } else if (!inHead && inRef) {
            workdir = 2; // added in ref
        } else if (inHead && inRef) {
            const headOid = headTree.get(filepath);
            const refOid = refTree.get(filepath);
            workdir = headOid === refOid ? 1 : 2;
        }

        entries.push([filepath, refStatus, workdir, workdir]);
    }

    return entries;
}

async function listTreeRecursive(dir: string, ref: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const commitOid = await git.resolveRef({ fs, dir, ref });

    await git.walk({
        fs,
        dir,
        trees: [git.TREE({ ref: commitOid })],
        map: async (filepath, [entry]) => {
            if (!entry || filepath === ".") return undefined;
            const type = await entry.type();
            if (type === "blob") {
                const oid = await entry.oid();
                files.set(filepath, oid);
            }
            return undefined;
        },
    });

    return files;
}

// ---------------------------------------------------------------------------
// Git operations — Log
// ---------------------------------------------------------------------------

export async function log(
    dir: string,
    options?: { depth?: number; ref?: string },
): Promise<LogEntry[]> {
    try {
        const commits = await git.log({
            fs,
            dir,
            depth: options?.depth,
            ref: options?.ref ?? "HEAD",
        });
        return commits.map((entry) => ({
            oid: entry.oid,
            message: entry.commit.message.split("\n")[0],
            author: {
                name: entry.commit.author.name,
                email: entry.commit.author.email,
                timestamp: entry.commit.author.timestamp,
            },
        }));
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Git operations — Blob reading
// ---------------------------------------------------------------------------

export async function readBlobAtRef(
    dir: string,
    ref: string,
    filepath: string,
): Promise<Buffer> {
    const refCandidates = [ref, `refs/remotes/${ref}`, `refs/heads/${ref}`, `refs/tags/${ref}`];
    let oid: string | undefined;
    for (const candidate of refCandidates) {
        try {
            oid = await git.resolveRef({ fs, dir, ref: candidate });
            break;
        } catch {
            // try next
        }
    }
    if (!oid) oid = ref;
    const { blob } = await git.readBlob({ fs, dir, oid, filepath });
    return Buffer.from(blob);
}

// ---------------------------------------------------------------------------
// Convenience / compatibility helpers
// ---------------------------------------------------------------------------

export async function hasGitRepository(dir: string): Promise<boolean> {
    try {
        await fs.promises.access(path.join(dir, ".git"), fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

export async function status(dir: string, filepath: string): Promise<string | undefined> {
    const result = await git.status({ fs, dir, filepath });
    if (result === "unmodified" || result === "absent") {
        return undefined;
    }
    return result;
}

export async function updateRef(dir: string, ref: string, value: string): Promise<void> {
    await git.writeRef({ fs, dir, ref, value, force: true });
}

export async function checkout(dir: string, ref: string, force = false): Promise<void> {
    await git.checkout({ fs, dir, ref, force });
}

export function parseGitProgress(_data: string, _onProgress?: ProgressCallback): void {
    // no-op: isomorphic-git uses its own progress events
}

export async function mv(dir: string, oldPath: string, newPath: string): Promise<void> {
    const absOld = path.join(dir, oldPath);
    const absNew = path.join(dir, newPath);
    await fs.promises.mkdir(path.dirname(absNew), { recursive: true });
    await fs.promises.rename(absOld, absNew);
    await git.remove({ fs, dir, filepath: oldPath });
    await git.add({ fs, dir, filepath: newPath });
}

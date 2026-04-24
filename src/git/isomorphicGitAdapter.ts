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
    try {
        const oids = await git.findMergeBase({ fs, dir, oids: [oid1, oid2] });
        return oids;
    } catch {
        return [];
    }
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
    let fileExists = true;
    try {
        await fs.promises.access(path.join(dir, filepath));
    } catch {
        fileExists = false;
    }

    if (fileExists) {
        await git.add({ fs, dir, filepath });
    } else {
        await git.remove({ fs, dir, filepath });
    }
}

export async function addMany(
    dir: string,
    filepaths: string[],
    options?: { batchSize?: number; maxRetries?: number },
): Promise<void> {
    const maxRetries = options?.maxRetries ?? 3;
    for (const filepath of filepaths) {
        let lastError: Error | undefined;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                await add(dir, filepath);
                lastError = undefined;
                break;
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt < maxRetries) {
                    await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
                }
            }
        }
        if (lastError) throw lastError;
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
    } catch (err) {
        // Only ignore "not in index" errors (matches dugite's --ignore-unmatch).
        // Propagate real failures (corrupt index, permissions, etc.).
        const isNotInIndex =
            err && typeof err === "object" && (err as any).code === "NotFoundError";
        if (!isNotInIndex) throw err;
    }
}

export async function removeMany(
    dir: string,
    filepaths: string[],
    options?: { batchSize?: number; maxRetries?: number },
): Promise<void> {
    const maxRetries = options?.maxRetries ?? 3;
    for (const filepath of filepaths) {
        let lastError: Error | undefined;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                await remove(dir, filepath);
                lastError = undefined;
                break;
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt < maxRetries) {
                    await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
                }
            }
        }
        if (lastError) throw lastError;
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
    const localOid = await git.resolveRef({ fs, dir, ref: `refs/heads/${branch}` });
    const remoteOid = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` });

    if (localOid === remoteOid) {
        return;
    }

    const bases = await git.findMergeBase({ fs, dir, oids: [localOid, remoteOid] });

    // Local is ahead of remote — already up to date, nothing to fast-forward.
    // Matches native git's `merge --ff-only` "Already up to date" behavior.
    if (bases.length > 0 && bases[0] === remoteOid) {
        return;
    }

    // Remote is ahead of local — fast-forward local branch to remote.
    if (bases.length > 0 && bases[0] === localOid) {
        await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: remoteOid, force: true });
        await git.checkout({ fs, dir, ref: branch, force: true });
        return;
    }

    // Diverged histories — cannot fast-forward, fall through to auto-resolution.
    throw new Error(
        `Not possible to fast-forward: local (${localOid.substring(0, 8)}) is not an ancestor of remote (${remoteOid.substring(0, 8)})`,
    );
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

    let hasGitDir = false;
    try {
        await fs.promises.access(path.join(dir, ".git"));
        hasGitDir = true;
    } catch {
        // .git doesn't exist yet
    }

    if (hasGitDir) {
        // Recovery path: directory already has .git (e.g., retry after a failed clone).
        // Mirrors dugiteGitNative's init+fetch+checkout approach.
        const remotes = await git.listRemotes({ fs, dir });
        if (!remotes.some((r) => r.remote === "origin")) {
            await git.addRemote({ fs, dir, remote: "origin", url });
        }
        await git.fetch({
            fs,
            http,
            dir,
            remote: "origin",
            onProgress: mapProgress(onProgressCb),
            onAuth: onAuth(auth),
        });
        const branches = await git.listBranches({ fs, dir, remote: "origin" });
        const defaultBranch = branches.includes("main")
            ? "main"
            : branches.includes("master")
              ? "master"
              : branches.filter((b) => b !== "HEAD")[0];
        if (defaultBranch) {
            await git.checkout({ fs, dir, ref: defaultBranch, force: true });
        }
    } else {
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
    let refTree: Map<string, string>;
    try {
        refTree = await listTreeRecursive(dir, ref);
    } catch {
        return [];
    }
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

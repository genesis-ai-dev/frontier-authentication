/**
 * dugiteGit.ts — Typed wrapper around dugite's exec() for all git operations.
 *
 * This module replaces isomorphic-git by delegating to a real native git binary
 * downloaded at runtime by gitBinaryManager.ts.  Every function maps one or more
 * `git` CLI invocations to a typed async result.
 *
 * The binary path is set once during extension activation via setGitBinaryPath().
 */

import { exec, type IGitExecutionOptions, type IGitResult } from "dugite";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Binary path resolution
// ---------------------------------------------------------------------------

let gitEnvOverrides: Record<string, string> = {};
let askpassScriptPath: string | undefined;

/**
 * Point dugite at the runtime-downloaded git binary.
 * Called once during extension activation after gitBinaryManager has ensured
 * the binary exists.
 */
export function setGitBinaryPath(localGitDir: string, execPath: string): void {
    gitEnvOverrides = {
        LOCAL_GIT_DIRECTORY: localGitDir,
        GIT_EXEC_PATH: execPath,
    };
}

/**
 * Set the path to the askpass helper script used for credential injection.
 * Creates a shell wrapper to ensure the script is invocable regardless of
 * file permissions (VSIX extraction doesn't preserve +x).
 */
export function setAskpassPath(scriptPath: string): void {
    askpassScriptPath = scriptPath;

    // Create a shell wrapper that invokes the script with node.
    // GIT_ASKPASS requires an executable; the JS file may lack +x after VSIX install.
    const wrapperDir = path.dirname(scriptPath);
    const wrapperPath = path.join(wrapperDir, "askpass-wrapper.sh");
    try {
        const wrapperContent = `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`;
        fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
        askpassScriptPath = wrapperPath;
    } catch {
        // Fall back to the JS file directly (will work if it has +x)
    }
}

/** Returns true when a binary path has been configured. */
export function isGitBinaryConfigured(): boolean {
    return Object.keys(gitEnvOverrides).length > 0;
}

/** Returns the current resolved paths (for sharing with codex-editor). */
export function getGitBinaryPaths(): { localGitDir: string; execPath: string } | undefined {
    if (!isGitBinaryConfigured()) {
        return undefined;
    }
    return {
        localGitDir: gitEnvOverrides.LOCAL_GIT_DIRECTORY,
        execPath: gitEnvOverrides.GIT_EXEC_PATH,
    };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Config flags prepended to every git invocation to prevent native git from
 * invoking git-lfs filter processes.  We handle all LFS operations manually
 * (upload, download, pointer creation), so the built-in filter must stay out
 * of the way — especially because dugite's bundled git binary does not ship
 * with git-lfs.
 */
const LFS_OVERRIDE_FLAGS = [
    "-c", "filter.lfs.process=",
    "-c", "filter.lfs.clean=cat",
    "-c", "filter.lfs.smudge=cat",
    "-c", "filter.lfs.required=false",
];

/**
 * Low-level exec wrapper that injects the binary path env vars into every call
 * and disables git-lfs filters via one-shot `-c` flags.
 */
async function gitExec(
    args: string[],
    dir: string,
    options?: IGitExecutionOptions,
): Promise<IGitResult> {
    return exec([...LFS_OVERRIDE_FLAGS, ...args], dir, {
        ...options,
        env: { ...gitEnvOverrides, ...options?.env },
    });
}

/** Git exec helper that merges auth env vars for remote operations. */
function authEnv(auth: { username: string; password: string }): Record<string, string> {
    if (!askpassScriptPath) {
        throw new Error(
            "[dugiteGit] askpass script path not set. Call setAskpassPath() during activation.",
        );
    }
    return {
        GIT_ASKPASS: askpassScriptPath,
        FRONTIER_GIT_USERNAME: auth.username,
        FRONTIER_GIT_PASSWORD: auth.password,
        GIT_TERMINAL_PROMPT: "0",
    };
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export class GitOperationError extends Error {
    public readonly exitCode: number;
    public readonly gitStderr: string;
    public readonly operation: string;

    constructor(operation: string, result: IGitResult) {
        const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8");
        super(`git ${operation} failed (exit ${result.exitCode}): ${stderr.trim()}`);
        this.name = "GitOperationError";
        this.exitCode = result.exitCode;
        this.gitStderr = stderr;
        this.operation = operation;
    }
}

function assertSuccess(operation: string, result: IGitResult): void {
    if (result.exitCode !== 0) {
        throw new GitOperationError(operation, result);
    }
}

function stdout(result: IGitResult): string {
    return typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
}

function stderr(result: IGitResult): string {
    return typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8");
}

// ---------------------------------------------------------------------------
// Progress parsing
// ---------------------------------------------------------------------------

export type ProgressCallback = (
    phase: string,
    loaded?: number,
    total?: number,
    description?: string,
) => void;

/**
 * Parse native git progress lines from stderr.
 * Format: "Receiving objects:  45% (123/273), 1.20 MiB | 500.00 KiB/s"
 */
export function parseGitProgress(data: string, onProgress?: ProgressCallback): void {
    if (!onProgress) {
        return;
    }
    const lines = data.split(/\r?\n|\r/);
    for (const line of lines) {
        const match = line.match(
            /([\w\s]+?):\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s*(.+))?/,
        );
        if (match) {
            const [, phase, , current, total, transferInfo] = match;
            onProgress(
                phase.trim().toLowerCase(),
                parseInt(current, 10),
                parseInt(total, 10),
                transferInfo?.trim(),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Git operations — Repository setup
// ---------------------------------------------------------------------------

/** Initialize a new git repository with default branch "main". */
export async function init(dir: string): Promise<void> {
    const result = await gitExec(["init", "-b", "main"], dir);
    assertSuccess("init", result);
}

/** Set a git config value. */
export async function setConfig(dir: string, key: string, value: string): Promise<void> {
    const result = await gitExec(["config", key, value], dir);
    assertSuccess("config", result);
}

/**
 * Persist LFS filter overrides into the repo's .git/config so that any
 * git invocation (even outside dugiteGit) skips git-lfs filters.
 *
 * Note: gitExec() already passes ephemeral `-c` overrides on every call,
 * so this is only needed when external tools may touch the repo.
 */
export async function disableLfsFilters(dir: string): Promise<void> {
    await setConfig(dir, "filter.lfs.process", "");
    await setConfig(dir, "filter.lfs.clean", "cat");
    await setConfig(dir, "filter.lfs.smudge", "cat");
    await setConfig(dir, "filter.lfs.required", "false");
}

// ---------------------------------------------------------------------------
// Git operations — References
// ---------------------------------------------------------------------------

/** Resolve a ref to its SHA. Returns the full 40-char OID. */
export async function resolveRef(dir: string, ref: string): Promise<string> {
    const result = await gitExec(["rev-parse", ref], dir);
    assertSuccess("rev-parse", result);
    return stdout(result).trim();
}

/** Get the current branch name, or null if detached HEAD. */
export async function currentBranch(dir: string): Promise<string | null> {
    const result = await gitExec(["branch", "--show-current"], dir);
    assertSuccess("branch --show-current", result);
    const branch = stdout(result).trim();
    return branch || null;
}

/** Find the merge base of two commits. Returns array of OIDs. */
export async function findMergeBase(dir: string, oid1: string, oid2: string): Promise<string[]> {
    const result = await gitExec(["merge-base", oid1, oid2], dir);
    if (result.exitCode !== 0) {
        // No common ancestor — not necessarily an error
        return [];
    }
    return stdout(result)
        .trim()
        .split("\n")
        .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Git operations — Remotes
// ---------------------------------------------------------------------------

/** List all remotes. Returns array of { remote, url }. */
export async function listRemotes(dir: string): Promise<Array<{ remote: string; url: string }>> {
    const result = await gitExec(["remote", "-v"], dir);
    assertSuccess("remote -v", result);
    const remotes = new Map<string, string>();
    for (const line of stdout(result).split("\n")) {
        const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
        if (match) {
            remotes.set(match[1], match[2]);
        }
    }
    return Array.from(remotes.entries()).map(([remote, url]) => ({ remote, url }));
}

/** Add a remote. */
export async function addRemote(dir: string, name: string, url: string): Promise<void> {
    const result = await gitExec(["remote", "add", name, url], dir);
    assertSuccess("remote add", result);
}

/** Delete a remote. */
export async function deleteRemote(dir: string, name: string): Promise<void> {
    const result = await gitExec(["remote", "remove", name], dir);
    assertSuccess("remote remove", result);
}

// ---------------------------------------------------------------------------
// Git operations — Staging & committing
// ---------------------------------------------------------------------------

/** Stage a single file. */
export async function add(dir: string, filepath: string): Promise<void> {
    const result = await gitExec(["add", "--", filepath], dir);
    assertSuccess("add", result);
}

/**
 * Stage multiple files in batched git add calls.
 * Splits into batches to avoid OS argument length limits (~200KB on most systems).
 * Retries failed batches up to maxRetries times.
 */
export async function addMany(
    dir: string,
    filepaths: string[],
    options?: { batchSize?: number; maxRetries?: number },
): Promise<void> {
    if (filepaths.length === 0) {
        return;
    }
    if (filepaths.length === 1) {
        return add(dir, filepaths[0]);
    }

    const batchSize = options?.batchSize ?? 100;
    const maxRetries = options?.maxRetries ?? 3;

    for (let i = 0; i < filepaths.length; i += batchSize) {
        const batch = filepaths.slice(i, i + batchSize);
        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const result = await gitExec(["add", "--", ...batch], dir);
                assertSuccess("add (batch)", result);
                lastError = undefined;
                break;
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt < maxRetries) {
                    console.warn(
                        `[dugiteGit] git add batch ${Math.floor(i / batchSize) + 1} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying: ${lastError.message}`,
                    );
                    await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
                }
            }
        }

        if (lastError) {
            throw lastError;
        }
    }
}

/** Stage all changes (new, modified, deleted). */
export async function addAll(dir: string): Promise<void> {
    const result = await gitExec(["add", "-A"], dir);
    assertSuccess("add -A", result);
}

/** Remove a file from the index (unstage / mark for deletion). */
export async function remove(dir: string, filepath: string): Promise<void> {
    const result = await gitExec(["rm", "--cached", "--", filepath], dir);
    assertSuccess("rm --cached", result);
}

/**
 * Remove multiple files from the index in batched calls.
 * Retries failed batches.
 */
export async function removeMany(
    dir: string,
    filepaths: string[],
    options?: { batchSize?: number; maxRetries?: number },
): Promise<void> {
    if (filepaths.length === 0) {
        return;
    }
    if (filepaths.length === 1) {
        return remove(dir, filepaths[0]);
    }

    const batchSize = options?.batchSize ?? 100;
    const maxRetries = options?.maxRetries ?? 3;

    for (let i = 0; i < filepaths.length; i += batchSize) {
        const batch = filepaths.slice(i, i + batchSize);
        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const result = await gitExec(["rm", "--cached", "--", ...batch], dir);
                assertSuccess("rm --cached (batch)", result);
                lastError = undefined;
                break;
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt < maxRetries) {
                    await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
                }
            }
        }

        if (lastError) {
            throw lastError;
        }
    }
}

/** Create a commit. Returns the new commit OID. */
export async function commit(
    dir: string,
    message: string,
    author: { name: string; email: string },
): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const tzOffset = new Date().getTimezoneOffset();
    const tzSign = tzOffset <= 0 ? "+" : "-";
    const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, "0");
    const tzMins = String(Math.abs(tzOffset) % 60).padStart(2, "0");
    const dateStr = `${timestamp} ${tzSign}${tzHours}${tzMins}`;

    const result = await gitExec(
        [
            "-c", `user.name=${author.name}`,
            "-c", `user.email=${author.email}`,
            "commit",
            "--allow-empty",
            "-m", message,
            "--date", dateStr,
        ],
        dir,
        {
            env: {
                GIT_AUTHOR_NAME: author.name,
                GIT_AUTHOR_EMAIL: author.email,
                GIT_AUTHOR_DATE: dateStr,
                GIT_COMMITTER_NAME: author.name,
                GIT_COMMITTER_EMAIL: author.email,
                GIT_COMMITTER_DATE: dateStr,
            },
        },
    );
    assertSuccess("commit", result);

    // Extract the commit OID from stdout
    const oidResult = await gitExec(["rev-parse", "HEAD"], dir);
    assertSuccess("rev-parse HEAD", oidResult);
    return stdout(oidResult).trim();
}

/**
 * Create a merge commit with explicit parent OIDs.
 * This uses git's low-level plumbing: write-tree + commit-tree + update-ref.
 */
export async function mergeCommit(
    dir: string,
    message: string,
    author: { name: string; email: string },
    parents: string[],
): Promise<string> {
    // 1. Write the current index as a tree
    const treeResult = await gitExec(["write-tree"], dir);
    assertSuccess("write-tree", treeResult);
    const treeOid = stdout(treeResult).trim();

    // 2. Create the commit object with explicit parents
    const parentArgs = parents.flatMap((p) => ["-p", p]);
    const commitTreeResult = await gitExec(
        ["commit-tree", treeOid, ...parentArgs, "-m", message],
        dir,
        {
            env: {
                GIT_AUTHOR_NAME: author.name,
                GIT_AUTHOR_EMAIL: author.email,
                GIT_COMMITTER_NAME: author.name,
                GIT_COMMITTER_EMAIL: author.email,
            },
        },
    );
    assertSuccess("commit-tree", commitTreeResult);
    const commitOid = stdout(commitTreeResult).trim();

    // 3. Update HEAD to point to the new commit
    const branch = await currentBranch(dir);
    const ref = branch ? `refs/heads/${branch}` : "HEAD";
    const updateResult = await gitExec(["update-ref", ref, commitOid], dir);
    assertSuccess("update-ref", updateResult);

    return commitOid;
}

// ---------------------------------------------------------------------------
// Git operations — Remote operations (fetch, push, clone)
// ---------------------------------------------------------------------------

/** Fetch from origin with auth and optional progress reporting. */
export async function fetchOrigin(
    dir: string,
    auth: { username: string; password: string },
    onProgress?: ProgressCallback,
): Promise<void> {
    const result = await gitExec(["fetch", "--progress", "origin"], dir, {
        env: authEnv(auth),
        processCallback: onProgress
            ? (cp) => {
                cp.stderr?.on("data", (data: Buffer) => {
                    parseGitProgress(data.toString(), onProgress);
                });
            }
            : undefined,
    });
    assertSuccess("fetch", result);
}

/** Fast-forward merge to the remote tracking branch. */
export async function fastForward(
    dir: string,
    branch: string,
    auth: { username: string; password: string },
): Promise<void> {
    const result = await gitExec(
        ["merge", "--ff-only", `origin/${branch}`],
        dir,
        { env: authEnv(auth) },
    );
    assertSuccess("merge --ff-only", result);
}

/** Push the current branch to origin, setting upstream if needed. */
export async function push(
    dir: string,
    auth: { username: string; password: string },
    options?: { ref?: string; onProgress?: ProgressCallback },
): Promise<void> {
    const branch = options?.ref || (await currentBranch(dir)) || "main";
    const args = ["push", "-u", "--progress", "origin", branch];
    const result = await gitExec(args, dir, {
        env: authEnv(auth),
        processCallback: options?.onProgress
            ? (cp) => {
                cp.stderr?.on("data", (data: Buffer) => {
                    parseGitProgress(data.toString(), options.onProgress);
                });
            }
            : undefined,
    });
    assertSuccess("push", result);
}

/** Clone a repository. */
export async function clone(
    url: string,
    dir: string,
    auth?: { username: string; password: string },
    onProgress?: ProgressCallback,
): Promise<void> {
    const envOverrides = auth ? authEnv(auth) : {};
    const progressCallback = onProgress
        ? (cp: import("child_process").ChildProcess) => {
            cp.stderr?.on("data", (data: Buffer) => {
                parseGitProgress(data.toString(), onProgress);
            });
        }
        : undefined;

    // Check if target directory already exists (caller may pre-create it).
    // Native git clone fails if the directory exists and is not empty.
    // isomorphic-git allowed cloning into existing directories, so we
    // replicate that with init + fetch + checkout when needed.
    let dirExists = false;
    try {
        const stat = await fs.promises.stat(dir);
        dirExists = stat.isDirectory();
    } catch {
        // Doesn't exist
    }

    if (dirExists) {
        // Directory exists — use init + fetch + checkout flow
        const hasGit = await fs.promises.stat(path.join(dir, ".git")).then(() => true).catch(() => false);
        if (!hasGit) {
            await init(dir);
        }

        // Add remote if not already present
        const remotes = await listRemotes(dir);
        if (!remotes.some((r) => r.remote === "origin")) {
            await addRemote(dir, "origin", url);
        }

        // Fetch all branches
        const fetchResult = await gitExec(["fetch", "--progress", "origin"], dir, {
            env: envOverrides,
            processCallback: progressCallback,
        });
        assertSuccess("fetch", fetchResult);

        // Checkout the default branch (try main, then master)
        for (const branch of ["main", "master"]) {
            try {
                const checkoutResult = await gitExec(
                    ["checkout", "-B", branch, `origin/${branch}`],
                    dir,
                );
                if (checkoutResult.exitCode === 0) {
                    // Set upstream tracking
                    await gitExec(
                        ["branch", "--set-upstream-to", `origin/${branch}`, branch],
                        dir,
                    );
                    return;
                }
            } catch {
                // Branch doesn't exist on remote, try next
            }
        }
    } else {
        // Directory doesn't exist — use normal git clone
        const parentDir = path.dirname(dir);
        const dirName = path.basename(dir);
        await fs.promises.mkdir(parentDir, { recursive: true });

        const args = ["clone", "--progress", url, dirName];
        const result = await gitExec(args, parentDir, {
            env: envOverrides,
            processCallback: progressCallback,
        });
        assertSuccess("clone", result);
    }
}

// ---------------------------------------------------------------------------
// Git operations — Status
// ---------------------------------------------------------------------------

/**
 * Status matrix entry, matching isomorphic-git's format:
 * [filepath, HEAD_status, WORKDIR_status, STAGE_status]
 *
 * Values:
 *   0 = absent
 *   1 = present/identical
 *   2 = modified/different
 */
export type StatusMatrixEntry = [string, 0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];

/**
 * Get the status matrix for the working directory.
 * Combines `git status --porcelain=v2` with `git diff --cached --name-status`
 * to produce isomorphic-git-compatible status entries.
 */
export async function statusMatrix(dir: string): Promise<StatusMatrixEntry[]> {
    const result = await gitExec(
        ["status", "--porcelain=v2", "--untracked-files=all"],
        dir,
    );
    assertSuccess("status", result);

    const entries = new Map<string, StatusMatrixEntry>();

    for (const line of stdout(result).split("\n")) {
        if (!line) {
            continue;
        }

        if (line.startsWith("?")) {
            // Untracked: ? <path>
            const filepath = line.substring(2);
            // HEAD=0 (absent), WORKDIR=2 (present), STAGE=0 (not staged)
            entries.set(filepath, [filepath, 0, 2, 0]);
            continue;
        }

        if (line.startsWith("!")) {
            // Ignored — skip
            continue;
        }

        if (line.startsWith("1") || line.startsWith("2")) {
            // Changed entry format (porcelain v2):
            // 1 XY sub mH mI mW hH hI <path>
            //   (8 fixed space-separated fields, then the path which may contain spaces)
            // 2 XY sub mH mI mW hH hI X<score> <path>\t<origPath>
            //   (9 fixed fields before tab, then path\torigPath)
            const parts = line.split("\t");
            const fields = parts[0].split(" ");
            const xy = fields[1]; // Two-char status: X=index, Y=workdir

            // For type 2 (rename/copy), path is after the tab
            // For type 1, path is fields 8+ joined (may contain spaces)
            let filepath: string;
            if (line.startsWith("2")) {
                filepath = parts[1];
            } else {
                // Type 1 has 8 fixed fields (indices 0-7), path is everything from field 8 onward
                filepath = fields.slice(8).join(" ");
            }

            const indexStatus = xy[0]; // X: staged status
            const workdirStatus = xy[1]; // Y: workdir status

            // HEAD status: 1 if file existed at HEAD, 0 if new
            const headStatus: 0 | 1 = indexStatus === "A" ? 0 : 1;

            // Workdir status relative to index
            let workdir: 0 | 1 | 2;
            if (workdirStatus === ".") {
                workdir = 1; // unchanged
            } else if (workdirStatus === "D") {
                workdir = 0; // deleted in workdir
            } else {
                workdir = 2; // modified/added in workdir
            }

            // Stage status relative to HEAD
            let stage: 0 | 1 | 2;
            if (indexStatus === ".") {
                stage = 1; // unchanged in index
            } else if (indexStatus === "D") {
                stage = 0; // deleted in index
            } else {
                stage = 2; // modified/added in index (M, A, R, C, T)
            }

            // When the file is staged for deletion (index='D'), it is absent
            // from the index and typically from the working tree as well.
            // Override workdir to 0 for semantic consistency with isomorphic-git.
            if (indexStatus === "D") {
                workdir = 0;
            }

            entries.set(filepath, [filepath, headStatus, workdir, stage]);
            continue;
        }

        if (line.startsWith("u")) {
            // Unmerged entry: u XY sub m1 m2 m3 mW h1 h2 h3 <path>
            const fields = line.split(" ");
            const filepath = fields[fields.length - 1];
            entries.set(filepath, [filepath, 1, 2, 2]);
            continue;
        }
    }

    // Also include tracked, unmodified files for full matrix
    // (isomorphic-git's statusMatrix returns all tracked files)
    const lsResult = await gitExec(["ls-files", "--cached"], dir);
    if (lsResult.exitCode === 0) {
        for (const filepath of stdout(lsResult).split("\n")) {
            if (filepath && !entries.has(filepath)) {
                // Tracked, unmodified: HEAD=1, WORKDIR=1, STAGE=1
                entries.set(filepath, [filepath, 1, 1, 1]);
            }
        }
    }

    return Array.from(entries.values());
}

/**
 * Get status of files at a specific ref compared to HEAD.
 * Used for conflict detection where we need to compare local vs remote vs base.
 *
 * Returns entries in the same format as statusMatrix, but comparing
 * the given ref against the working directory.
 */
export async function statusMatrixAtRef(
    dir: string,
    ref: string,
): Promise<StatusMatrixEntry[]> {
    // List all files at the given ref
    const lsRefResult = await gitExec(["ls-tree", "-r", "--name-only", ref], dir);
    if (lsRefResult.exitCode !== 0) {
        return [];
    }

    const filesAtRef = new Set(
        stdout(lsRefResult)
            .split("\n")
            .filter((f) => f.length > 0),
    );

    // List all files at HEAD
    const lsHeadResult = await gitExec(["ls-tree", "-r", "--name-only", "HEAD"], dir);
    const filesAtHead = new Set(
        lsHeadResult.exitCode === 0
            ? stdout(lsHeadResult)
                .split("\n")
                .filter((f) => f.length > 0)
            : [],
    );

    // Get diff between HEAD and the ref
    const diffResult = await gitExec(
        ["diff", "--name-status", "HEAD", ref],
        dir,
    );
    const diffs = new Map<string, string>();
    if (diffResult.exitCode === 0) {
        for (const line of stdout(diffResult).split("\n")) {
            if (!line) {
                continue;
            }
            const [status, ...pathParts] = line.split("\t");
            const filepath = pathParts[0];
            if (filepath) {
                diffs.set(filepath, status);
            }
        }
    }

    const entries: StatusMatrixEntry[] = [];
    const allFiles = new Set([...filesAtRef, ...filesAtHead]);

    for (const filepath of allFiles) {
        const inHead = filesAtHead.has(filepath);
        const inRef = filesAtRef.has(filepath);
        const diffStatus = diffs.get(filepath);

        // The first element indicates whether the file exists at the
        // *target ref* (not HEAD).  Callers use entry[0] to determine
        // whether a file is present at the reference being inspected.
        const refStatus: 0 | 1 = inRef ? 1 : 0;

        let workdir: 0 | 1 | 2 = 1;
        if (diffStatus === "D") {
            workdir = 0; // deleted
        } else if (diffStatus === "A" || diffStatus === "M" || diffStatus?.startsWith("R")) {
            workdir = 2; // modified/added
        } else if (!inHead && inRef) {
            workdir = 2; // added in ref
        } else if (inHead && !inRef) {
            workdir = 0; // deleted in ref
        }

        entries.push([filepath, refStatus, workdir, workdir]);
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Git operations — Log
// ---------------------------------------------------------------------------

export interface LogEntry {
    oid: string;
    message: string;
    author: {
        name: string;
        email: string;
        timestamp: number;
    };
}

/** Get commit log. */
export async function log(
    dir: string,
    options?: { depth?: number; ref?: string },
): Promise<LogEntry[]> {
    const args = [
        "log",
        "--format=%H%n%an%n%ae%n%at%n%s%n---END---",
    ];
    if (options?.depth) {
        args.push(`-${options.depth}`);
    }
    if (options?.ref) {
        args.push(options.ref);
    }

    const result = await gitExec(args, dir);
    if (result.exitCode !== 0) {
        return [];
    }

    const entries: LogEntry[] = [];
    const blocks = stdout(result).split("---END---\n");

    for (const block of blocks) {
        const lines = block.trim().split("\n");
        if (lines.length >= 5) {
            entries.push({
                oid: lines[0],
                author: {
                    name: lines[1],
                    email: lines[2],
                    timestamp: parseInt(lines[3], 10),
                },
                message: lines[4],
            });
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Git operations — Blob reading
// ---------------------------------------------------------------------------

/** Read file content at a specific ref. Returns the raw content as a Buffer. */
export async function readBlobAtRef(
    dir: string,
    ref: string,
    filepath: string,
): Promise<Buffer> {
    const result = await gitExec(["show", `${ref}:${filepath}`], dir, {
        encoding: "buffer",
    });
    assertSuccess("show", result);
    return result.stdout as Buffer;
}

// ---------------------------------------------------------------------------
// Convenience / compatibility helpers
// ---------------------------------------------------------------------------

/**
 * Check if a directory is a git repository.
 */
export async function hasGitRepository(dir: string): Promise<boolean> {
    try {
        const result = await gitExec(["rev-parse", "--is-inside-work-tree"], dir);
        return result.exitCode === 0 && stdout(result).trim() === "true";
    } catch {
        return false;
    }
}

/**
 * Get the status of a single file. Returns the porcelain v2 status string
 * or undefined if the file is unmodified.
 */
export async function status(dir: string, filepath: string): Promise<string | undefined> {
    const result = await gitExec(
        ["status", "--porcelain=v2", "--", filepath],
        dir,
    );
    assertSuccess("status", result);
    const output = stdout(result).trim();
    return output || undefined;
}

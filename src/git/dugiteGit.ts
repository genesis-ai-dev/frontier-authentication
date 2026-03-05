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
 *
 * On Linux, dugite skips setting GIT_SSL_CAINFO when LOCAL_GIT_DIRECTORY is
 * provided (it only sets it for the embedded git case).  The dugite-native
 * archive ships ssl/cacert.pem on Linux, so we point to it explicitly —
 * without it, every HTTPS git operation would fail with a certificate error.
 *
 * macOS uses the system's Secure Transport for SSL (no CA bundle needed).
 * Windows uses schannel via the system certificate store.
 */
export function setGitBinaryPath(localGitDir: string, execPath: string): void {
    gitEnvOverrides = {
        LOCAL_GIT_DIRECTORY: localGitDir,
        GIT_EXEC_PATH: execPath,
    };

    // When LOCAL_GIT_DIRECTORY is provided, dugite does not set GIT_SSL_CAINFO.
    // The dugite-native archive ships ssl/cacert.pem for platforms where the
    // bundled git uses OpenSSL.  If present, point to it so HTTPS works.
    // On platforms using a native SSL backend (schannel / SecureTransport)
    // the file may be absent — the native backend uses the OS cert store.
    const sslCaBundle = path.join(localGitDir, "ssl", "cacert.pem");
    try {
        fs.accessSync(sslCaBundle, fs.constants.R_OK);
        gitEnvOverrides.GIT_SSL_CAINFO = sslCaBundle;
        console.log(`[dugiteGit] SSL CA bundle: ${sslCaBundle}`);
    } catch {
        // Not present — platform likely uses a native SSL backend
    }
}

/**
 * Set the path to the askpass helper script used for credential injection.
 * Creates a shell wrapper to ensure the script is invocable regardless of
 * file permissions (VSIX extraction doesn't preserve +x).
 *
 * Uses process.execPath (absolute path to the running Node binary) rather
 * than bare "node" so the wrapper works even when Node isn't on PATH
 * (e.g. NVM-managed installs on macOS, restricted PATH on Linux, or
 * non-developer Windows machines).
 *
 * On Windows the .cmd wrapper may briefly flash a console window when git
 * invokes it. This is a known limitation of cmd.exe-based wrappers;
 * the flash is sub-second and the window receives no focus.
 */
export function setAskpassPath(scriptPath: string): void {
    askpassScriptPath = scriptPath;

    const wrapperDir = path.dirname(scriptPath);
    const nodeBin = process.execPath;

    if (process.platform === "win32") {
        const wrapperPath = path.join(wrapperDir, "askpass-wrapper.cmd");
        try {
            const wrapperContent = `@echo off\r\n"${nodeBin}" "${scriptPath}" %*\r\n`;
            fs.writeFileSync(wrapperPath, wrapperContent);
            askpassScriptPath = wrapperPath;
            console.log(`[dugiteGit] Askpass wrapper created: ${wrapperPath} (win32)`);
        } catch (err) {
            console.warn(`[dugiteGit] Failed to create .cmd askpass wrapper, falling back to JS file:`, err);
        }
    } else {
        const wrapperPath = path.join(wrapperDir, "askpass-wrapper.sh");
        try {
            const wrapperContent = `#!/bin/sh\nexec "${nodeBin}" "${scriptPath}" "$@"\n`;
            fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
            askpassScriptPath = wrapperPath;
            console.log(`[dugiteGit] Askpass wrapper created: ${wrapperPath} (${process.platform})`);
        } catch (err) {
            console.warn(`[dugiteGit] Failed to create .sh askpass wrapper, falling back to JS file:`, err);
        }
    }
}

/**
 * Use dugite's own embedded git binary instead of a runtime-downloaded one.
 * Clears any previously set path overrides so dugite resolves its bundled
 * binary for the current platform automatically.
 *
 * Intended for test environments where the full gitBinaryManager download
 * flow hasn't run (and doesn't need to).
 */
export function useEmbeddedGitBinary(): void {
    gitEnvOverrides = {};
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
 * Platform-safety and performance flags applied to every git invocation to
 * normalize behavior across Windows, macOS, and Linux — regardless of what
 * the user's ~/.gitconfig or the repo's .git/config may contain.
 *
 * core.longpaths         — Windows: enables paths >260 chars via \\?\
 *                          prefix.  Without this, deeply nested projects
 *                          or OneDrive-synced folders silently fail.
 * core.autocrlf          — Prevents git from converting LF↔CRLF on
 *                          checkout/commit.  Translation files must be
 *                          stored byte-for-byte as authored.
 * core.fsmonitor         — Disables filesystem monitor integration
 *                          (watchman, fsmonitor--daemon).  These can
 *                          hang when Spotlight or Windows Search are
 *                          indexing the working tree.
 * core.pager             — Disables the pager so git never waits for
 *                          user input (e.g. log output).
 * core.quotePath         — When true (the default), git quotes non-ASCII
 *                          characters in paths with octal escapes.  Since
 *                          this is a translation tool with filenames in
 *                          many scripts, we need raw UTF-8 paths for
 *                          correct parsing in status/ls-files output.
 * core.precomposeUnicode — macOS HFS+/APFS uses NFD (decomposed)
 *                          Unicode.  This flag normalizes to NFC so git
 *                          paths match what Node.js and the rest of our
 *                          code expect.  No-op on other platforms.
 * core.protectNTFS       — Rejects paths that are invalid on NTFS
 *                          (CON, AUX, NUL, trailing dots/spaces, etc.).
 *                          Already the default on Windows; set everywhere
 *                          so repos created on macOS/Linux remain safe
 *                          for Windows collaborators.
 * core.looseCompression  — Fastest zlib level for loose objects.  Git
 *                          re-compresses during pack, so optimizing for
 *                          write speed over ratio is the right trade-off.
 * gc.auto                — Disables automatic garbage collection, which
 *                          can lock the repo for 30+ seconds mid-operation
 *                          and make the app appear frozen.
 * pack.windowMemory      — Caps delta-search memory to 256 MB.  Prevents
 *                          OOM on memory-constrained ARM laptops and
 *                          older machines.
 * protocol.version       — Git protocol v2 is significantly more efficient
 *                          for fetch (selective ref advertisement, server-
 *                          side filtering).  Supported since Git 2.18;
 *                          we ship 2.47.
 * safe.directory          — Git 2.35.2+ rejects operations in directories
 *                          owned by a different user ("dubious ownership").
 *                          On shared systems, network drives, or when
 *                          projects live on external storage, this causes
 *                          unexpected failures for non-developer users.
 *                          Setting to "*" disables the ownership check.
 * user.useConfigOnly      — Prevents git from guessing user.name and
 *                          user.email from the hostname/username.  All
 *                          commits must supply author info explicitly
 *                          (via GIT_AUTHOR_NAME env vars or -c flags),
 *                          which we already do.
 */
const PLATFORM_SAFETY_FLAGS = [
    "-c", "core.longpaths=true",
    "-c", "core.autocrlf=false",
    "-c", "core.fsmonitor=false",
    "-c", "core.pager=",
    "-c", "core.quotePath=false",
    "-c", "core.precomposeUnicode=true",
    "-c", "core.protectNTFS=true",
    "-c", "core.looseCompression=1",
    "-c", "gc.auto=0",
    "-c", "pack.windowMemory=256m",
    "-c", "protocol.version=2",
    "-c", "safe.directory=*",
    "-c", "user.useConfigOnly=true",
];

/**
 * HTTP reliability flags for remote operations (fetch, push, clone).
 *
 * http.lowSpeedLimit + lowSpeedTime — abort if transfer speed drops below
 *     1 byte/s for 60 consecutive seconds, producing a descriptive error
 *     rather than hanging until the JS-level withTimeout fires.
 * http.postBuffer — raise the POST buffer ceiling from the 1 MB default
 *     to 75 MB.  Git only allocates what the packfile actually needs, up
 *     to this limit; if it exceeds the limit, git falls back to chunked
 *     transfer encoding (which some proxies reject with HTTP 413).  75 MB
 *     is generous for text-heavy translation projects — binary media goes
 *     through LFS, not git's HTTP transport — while staying well within
 *     reach of memory-constrained devices.
 */
const HTTP_TIMEOUT_FLAGS = [
    "-c", "http.lowSpeedLimit=1",
    "-c", "http.lowSpeedTime=60",
    "-c", "http.postBuffer=78643200",
];

/**
 * Baseline env vars applied to every git invocation to ensure fully
 * non-interactive operation — no terminal prompts, no GUI dialogs,
 * and no interference from system-level git configuration.
 *
 * GIT_CONFIG_NOSYSTEM skips /etc/gitconfig (Linux/macOS) and
 * C:\ProgramData\Git\config (Windows) which may be left over from
 * a separate Git for Windows / Homebrew git installation and can
 * inject credential helpers, editors, pagers, or fsmonitor hooks.
 * User-level config (~/.gitconfig) is still read — proxy settings
 * and other legitimate user preferences are preserved.  Network
 * proxies also work via the standard HTTP_PROXY / HTTPS_PROXY env
 * vars which git honors regardless of config files.
 */
const NON_INTERACTIVE_ENV: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
};

/**
 * If a git operation fails because of a stale index.lock, try to remove it
 * and retry once.  Lock files are left behind when git (or the extension)
 * crashes mid-operation.  Non-developer users have no idea how to recover
 * from this, so we handle it transparently.
 *
 * Only removes the lock if it is older than STALE_LOCK_THRESHOLD_MS to
 * avoid racing with a legitimately running git process.
 */
const STALE_LOCK_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Lock files that can be left behind after a crash and block subsequent
 * git operations. Each is relative to `<repo>/.git/`.
 */
const KNOWN_LOCK_FILES = [
    "index.lock",
    "shallow.lock",
    "config.lock",
    "HEAD.lock",
    "FETCH_HEAD.lock",
    "MERGE_HEAD.lock",
    "packed-refs.lock",
    "refs/heads/main.lock",
    "refs/heads/master.lock",
    "refs/remotes/origin/main.lock",
    "refs/remotes/origin/master.lock",
];

/**
 * Try to remove any stale lock file older than the threshold.
 * Returns true if at least one lock was removed.
 */
async function removeStaleLocks(dir: string): Promise<boolean> {
    let removed = false;
    for (const lockFile of KNOWN_LOCK_FILES) {
        const lockPath = path.join(dir, ".git", lockFile);
        try {
            const stat = await fs.promises.stat(lockPath);
            const ageMs = Date.now() - stat.mtimeMs;
            if (ageMs > STALE_LOCK_THRESHOLD_MS) {
                await fs.promises.unlink(lockPath);
                console.warn(
                    `[dugiteGit] Removed stale ${lockFile} (${Math.round(ageMs / 1000)}s old) at ${lockPath}`,
                );
                removed = true;
            } else {
                console.warn(
                    `[dugiteGit] ${lockFile} exists but is only ${Math.round(ageMs / 1000)}s old — not removing (may be held by another operation)`,
                );
            }
        } catch {
            // Lock file doesn't exist — nothing to do
        }
    }
    return removed;
}

/**
 * Low-level exec wrapper that injects the binary path env vars into every call
 * and applies LFS overrides + platform safety flags via one-shot `-c` flags.
 *
 * Automatically recovers from stale index.lock files by removing them and
 * retrying the operation once.
 */
async function gitExec(
    args: string[],
    dir: string,
    options?: IGitExecutionOptions,
): Promise<IGitResult> {
    const flags = [...LFS_OVERRIDE_FLAGS, ...PLATFORM_SAFETY_FLAGS];
    const execOptions: IGitExecutionOptions = {
        ...options,
        env: { ...NON_INTERACTIVE_ENV, ...gitEnvOverrides, ...options?.env },
    };

    let result = await exec([...flags, ...args], dir, execOptions);

    if (result.exitCode !== 0) {
        const errStr = typeof result.stderr === "string"
            ? result.stderr
            : result.stderr.toString("utf8");
        if (errStr.includes(".lock") && await removeStaleLocks(dir)) {
            result = await exec([...flags, ...args], dir, execOptions);
        }
    }

    return result;
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
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    };
}

/**
 * Git config flags that disable all credential helpers and system askpass
 * programs so that only our GIT_ASKPASS env var is used for authentication.
 * Without these, bundled credential managers (like GCM on Windows or
 * osxkeychain on macOS) may show interactive GUI prompts, or a user's
 * core.askPass config may return stale/wrong credentials.
 *
 * Note: credential.helper is a multi-valued git config key. Setting it to
 * empty via `-c` replaces *all* configured values (system, global, local),
 * which is exactly the behavior we need — a single override clears the list.
 */
const CREDENTIAL_OVERRIDE_FLAGS = [
    "-c", "credential.helper=",
    "-c", "core.askPass=",
];

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export class GitOperationError extends Error {
    public readonly exitCode: number;
    public readonly gitStderr: string;
    public readonly operation: string;

    constructor(operation: string, result: IGitResult) {
        const stderrStr = stderr(result);
        super(`git ${operation} failed (exit ${result.exitCode}): ${stderrStr.trim()}`);
        this.name = "GitOperationError";
        this.exitCode = result.exitCode;
        this.gitStderr = stderrStr;
        this.operation = operation;
    }
}

function assertSuccess(operation: string, result: IGitResult): void {
    if (result.exitCode !== 0) {
        throw new GitOperationError(operation, result);
    }
}

/**
 * Extract stdout as a string with CRLF normalized to LF.
 * MinGW git on Windows typically outputs LF, but system-level git
 * config or locale settings can introduce CRLF in edge cases.
 * Normalizing here keeps all downstream parsers platform-safe.
 */
function stdout(result: IGitResult): string {
    const raw = typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
    return raw.replace(/\r\n/g, "\n");
}

function stderr(result: IGitResult): string {
    const raw = typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8");
    return raw.replace(/\r\n/g, "\n");
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

/**
 * Build a processCallback that wires an optional AbortSignal to SIGTERM the
 * child process, and optionally forwards stderr to a progress parser.
 */
function buildProcessCallback(
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
): ((cp: import("child_process").ChildProcess) => void) | undefined {
    if (!onProgress && !signal) {
        return undefined;
    }
    return (cp) => {
        if (signal) {
            const onAbort = () => {
                if (!cp.killed) {
                    cp.kill("SIGTERM");
                }
            };
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener("abort", onAbort, { once: true });
            }
        }
        if (onProgress) {
            cp.stderr?.on("data", (data: Buffer) => {
                parseGitProgress(data.toString(), onProgress);
            });
        }
    };
}

/** Fetch from origin with auth and optional progress reporting. */
export async function fetchOrigin(
    dir: string,
    auth: { username: string; password: string },
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
): Promise<void> {
    const result = await gitExec(
        [...CREDENTIAL_OVERRIDE_FLAGS, ...HTTP_TIMEOUT_FLAGS, "fetch", "--prune", "--progress", "origin"],
        dir,
        {
            env: authEnv(auth),
            processCallback: buildProcessCallback(onProgress, signal),
        },
    );
    assertSuccess("fetch", result);
}

/** Fast-forward merge to the remote tracking branch. */
export async function fastForward(
    dir: string,
    branch: string,
    auth: { username: string; password: string },
    signal?: AbortSignal,
): Promise<void> {
    const result = await gitExec(
        [...CREDENTIAL_OVERRIDE_FLAGS, "merge", "--ff-only", `origin/${branch}`],
        dir,
        {
            env: authEnv(auth),
            processCallback: buildProcessCallback(undefined, signal),
        },
    );
    assertSuccess("merge --ff-only", result);
}

/** Push the current branch to origin, setting upstream if needed. */
export async function push(
    dir: string,
    auth: { username: string; password: string },
    options?: { ref?: string; onProgress?: ProgressCallback; signal?: AbortSignal },
): Promise<void> {
    const branch = options?.ref || (await currentBranch(dir)) || "main";
    const args = [...CREDENTIAL_OVERRIDE_FLAGS, ...HTTP_TIMEOUT_FLAGS, "push", "-u", "--progress", "origin", branch];
    const result = await gitExec(args, dir, {
        env: authEnv(auth),
        processCallback: buildProcessCallback(options?.onProgress, options?.signal),
    });
    assertSuccess("push", result);
}

/**
 * Detect the remote's default branch after a fetch.
 * Tries (in order): symbolic ref from the remote HEAD, common names
 * (main, master), then falls back to the first available remote branch.
 */
async function detectDefaultBranch(dir: string): Promise<string | undefined> {
    // 1. symbolic-ref (set by fetch when the server advertises HEAD)
    const symRef = await gitExec(
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        dir,
    );
    if (symRef.exitCode === 0) {
        const branch = stdout(symRef).trim().replace("origin/", "");
        if (branch) {
            return branch;
        }
    }

    // 2. Common default branch names
    for (const candidate of ["main", "master"]) {
        const check = await gitExec(
            ["rev-parse", "--verify", `origin/${candidate}`],
            dir,
        );
        if (check.exitCode === 0) {
            return candidate;
        }
    }

    // 3. First available remote branch (handles repos with non-standard defaults)
    const refs = await gitExec(
        ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"],
        dir,
    );
    if (refs.exitCode === 0) {
        const branches = stdout(refs)
            .split("\n")
            .filter((b) => b && !b.endsWith("/HEAD"))
            .map((b) => b.replace("origin/", ""));
        if (branches.length > 0) {
            return branches[0];
        }
    }

    return undefined;
}

/** Clone a repository. */
export async function clone(
    url: string,
    dir: string,
    auth?: { username: string; password: string },
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
): Promise<void> {
    const envOverrides = auth ? authEnv(auth) : {};
    const credFlags = CREDENTIAL_OVERRIDE_FLAGS;
    const processCallback = buildProcessCallback(onProgress, signal);

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
        const hasGit = await fs.promises.stat(path.join(dir, ".git")).then(() => true).catch(() => false);
        if (!hasGit) {
            await init(dir);
        }

        const remotes = await listRemotes(dir);
        if (!remotes.some((r) => r.remote === "origin")) {
            await addRemote(dir, "origin", url);
        }

        const fetchResult = await gitExec(
            [...credFlags, ...HTTP_TIMEOUT_FLAGS, "fetch", "--progress", "origin"],
            dir,
            { env: envOverrides, processCallback },
        );
        assertSuccess("fetch", fetchResult);

        const defaultBranch = await detectDefaultBranch(dir);
        if (defaultBranch) {
            const checkoutResult = await gitExec(
                ["checkout", "-B", defaultBranch, `origin/${defaultBranch}`],
                dir,
            );
            if (checkoutResult.exitCode === 0) {
                await gitExec(
                    ["branch", "--set-upstream-to", `origin/${defaultBranch}`, defaultBranch],
                    dir,
                );
            }
        }
    } else {
        const parentDir = path.dirname(dir);
        const dirName = path.basename(dir);
        await fs.promises.mkdir(parentDir, { recursive: true });

        const args = [...credFlags, ...HTTP_TIMEOUT_FLAGS, "clone", "--progress", url, dirName];
        const result = await gitExec(args, parentDir, {
            env: envOverrides,
            processCallback,
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
        ["--no-optional-locks", "status", "--porcelain=v2", "--untracked-files=all"],
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
            // Porcelain v2 format:
            // Type 1: "1 XY sub mH mI mW hH hI <path>" (8 fixed fields + path)
            // Type 2: "2 XY sub mH mI mW hH hI X<score> <path>\t<origPath>"
            const parts = line.split("\t");
            const fields = parts[0].split(" ");
            const minFields = line.startsWith("2") ? 10 : 9;
            if (fields.length < minFields || !fields[1] || fields[1].length < 2) {
                console.warn(`[statusMatrix] Skipping malformed porcelain line: ${line}`);
                continue;
            }
            const xy = fields[1];

            let filepath: string;
            if (line.startsWith("2")) {
                filepath = fields.slice(9).join(" ");
            } else {
                filepath = fields.slice(8).join(" ");
            }

            const indexStatus = xy[0];
            const workdirStatus = xy[1];

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
            // 11 fixed space-separated fields (indices 0-10), path may contain spaces.
            const fields = line.split(" ");
            if (fields.length < 11) {
                console.warn(`[statusMatrix] Skipping malformed unmerged line: ${line}`);
                continue;
            }
            const filepath = fields.slice(10).join(" ");
            if (!filepath) {
                console.warn(`[statusMatrix] Skipping unmerged line with empty path: ${line}`);
                continue;
            }
            entries.set(filepath, [filepath, 1, 2, 2]);
            continue;
        }
    }

    // Also include tracked, unmodified files for full matrix.
    // Use -z for NUL-delimited output so filenames containing newlines
    // (valid on Unix, though unlikely for translation projects) parse correctly.
    const lsResult = await gitExec(["ls-files", "--cached", "-z"], dir);
    if (lsResult.exitCode === 0) {
        for (const filepath of stdout(lsResult).split("\0")) {
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
    // Use NUL (%x00) as the record separator — git commit messages cannot
    // contain NUL bytes, so this delimiter is collision-proof unlike text
    // sentinels like "---END---" which could appear in subject lines.
    const args = [
        "log",
        "--format=%H%n%an%n%ae%n%at%n%s%x00",
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
    const blocks = stdout(result).split("\0");

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
        ["--no-optional-locks", "status", "--porcelain=v2", "--", filepath],
        dir,
    );
    assertSuccess("status", result);
    const output = stdout(result).trim();
    return output || undefined;
}

/** Write/update a ref to a given SHA. */
export async function updateRef(dir: string, ref: string, value: string): Promise<void> {
    const result = await gitExec(["update-ref", ref, value], dir);
    assertSuccess("update-ref", result);
}

/** Checkout a ref, optionally forcing. */
export async function checkout(dir: string, ref: string, force = false): Promise<void> {
    const args = force ? ["checkout", "-f", ref] : ["checkout", ref];
    const result = await gitExec(args, dir);
    assertSuccess("checkout", result);
}

/**
 * gitBinaryManager.ts — Downloads and manages the dugite-native git binary.
 *
 * On first extension activation, downloads the correct platform-specific
 * git binary from the dugite-native GitHub releases, extracts it to
 * VS Code's globalStorageUri, and provides the path for dugiteGit.ts to use.
 *
 * The binary is downloaded once and persisted across sessions/workspaces.
 * Codex-editor accesses the same binary via FrontierAPI.getGitBinaryPath().
 */

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import * as tar from "tar";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Integrity helpers (self-contained — no cross-extension imports)
// ---------------------------------------------------------------------------

const HASH_MARKER = "sha256.txt";
const computeGitBinaryHash = (filePath: string): Promise<string> =>
    new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });

const writeGitHashMarker = (dir: string, hash: string): void => {
    fs.writeFileSync(path.join(dir, HASH_MARKER), hash, "utf8");
};

const readGitHashMarker = (dir: string): string | null => {
    try {
        return fs.readFileSync(path.join(dir, HASH_MARKER), "utf8").trim();
    } catch {
        return null;
    }
};

// ---------------------------------------------------------------------------
// Configuration — pin to a specific dugite-native release
// ---------------------------------------------------------------------------

const DUGITE_NATIVE_TAG = "v2.47.3-1";
const GITHUB_API_RELEASE_URL = `https://api.github.com/repos/desktop/dugite-native/releases/tags/${DUGITE_NATIVE_TAG}`;

/** Map from Node.js platform+arch to dugite-native asset name pattern. */
const PLATFORM_MAP: Record<string, string> = {
    "darwin-x64": "macOS-x64",
    "darwin-arm64": "macOS-arm64",
    "linux-x64": "ubuntu-x64",
    "linux-arm64": "ubuntu-arm64",
    "win32-x64": "windows-x64",
    "win32-arm64": "windows-arm64",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitBinaryPaths {
    /** The root directory of the git installation (for LOCAL_GIT_DIRECTORY). */
    localGitDir: string;
    /** The git-core libexec path (for GIT_EXEC_PATH). */
    execPath: string;
}

interface GitHubAsset {
    name: string;
    browser_download_url: string;
    size: number;
}

interface GitHubRelease {
    tag_name: string;
    assets: GitHubAsset[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let resolvedPaths: GitBinaryPaths | undefined;
let inflightEnsure: Promise<GitBinaryPaths | undefined> | undefined;

/** Returns the currently resolved paths, or undefined if not yet initialized. */
export function getResolvedPath(): GitBinaryPaths | undefined {
    return resolvedPaths;
}

/**
 * Returns true when the current OS/arch has a prebuilt dugite-native
 * asset published in the release we pin to. Callers use this to decide
 * whether to offer a "Download and install" button at all — on
 * unsupported platforms, downloading is impossible and the UI should
 * surface that fact instead of showing a no-op action.
 */
export function isGitBinaryNativelySupported(): boolean {
    return PLATFORM_MAP[`${os.platform()}-${os.arch()}`] !== undefined;
}

/** Reset cached paths so the next ensureGitBinary call retries from scratch. */
export function resetResolvedPaths(): void {
    resolvedPaths = undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the git binary is available. Downloads if needed.
 * Call this during extension activation.
 *
 * Returns `undefined` when the native binary cannot be obtained
 * (retries exhausted, offline, unsupported platform). The caller
 * should fall back to isomorphic-git silently.
 *
 * @param context The VS Code extension context (for globalStorageUri)
 * @returns Resolved paths to the git binary, or undefined if unavailable
 */
export async function ensureGitBinary(
    context: vscode.ExtensionContext,
): Promise<GitBinaryPaths | undefined> {
    if (resolvedPaths) {
        return resolvedPaths;
    }
    if (inflightEnsure) {
        return inflightEnsure;
    }
    inflightEnsure = doEnsureGitBinary(context).finally(() => { inflightEnsure = undefined; });
    return inflightEnsure;
}

async function doEnsureGitBinary(
    context: vscode.ExtensionContext,
): Promise<GitBinaryPaths | undefined> {
    if (resolvedPaths) {
        return resolvedPaths;
    }

    const gitMode = vscode.workspace
        .getConfiguration("codex-editor")
        .get<string>("gitBackendMode");
    if (gitMode === "force-builtin") {
        console.log("[GitBinaryManager] force-builtin mode — skipping native binary download");
        return undefined;
    }

    // Unsupported platforms must NOT enter the retry loop or bump the retry
    // counter — the fallback (isomorphic-git) is used and re-evaluated next
    // startup. "Unsupported" is a permanent condition for this machine, not
    // a transient failure worth retrying with backoff.
    const platformKey = `${os.platform()}-${os.arch()}`;
    if (!PLATFORM_MAP[platformKey]) {
        console.warn(
            `[GitBinaryManager] Platform ${platformKey} not supported — falling back to builtin sync`,
        );
        return undefined;
    }

    const storageDir = context.globalStorageUri.fsPath;
    await fs.promises.mkdir(storageDir, { recursive: true });

    const gitRootDir = path.join(storageDir, "git", DUGITE_NATIVE_TAG);

    // Check if already downloaded and valid (file exists + permissions)
    if (await isValidInstallation(gitRootDir)) {
        // Verify SHA-256 marker if one exists (pre-integrity installs have no marker)
        const storedHash = readGitHashMarker(gitRootDir);
        const gitBin = process.platform === "win32"
            ? path.join(gitRootDir, "cmd", "git.exe")
            : path.join(gitRootDir, "bin", "git");
        let integrityOk = true;

        if (storedHash) {
            try {
                const actualHash = await computeGitBinaryHash(gitBin);
                integrityOk = actualHash === storedHash;
                if (!integrityOk) {
                    console.warn("[GitBinaryManager] SHA-256 mismatch — cached binary may be corrupt");
                }
            } catch {
                integrityOk = false;
            }
        }

        if (integrityOk) {
            // Run an execution test to confirm the binary works
            try {
                await verifyGitRuns(gitRootDir);
                resolvedPaths = buildPaths(gitRootDir);
                console.log("[GitBinaryManager] Using existing git binary at:", gitRootDir);
                return resolvedPaths;
            } catch (err) {
                console.warn("[GitBinaryManager] Cached binary failed execution test:", err);
            }
        }

        // Integrity or execution test failed — delete the corrupt installation and re-download
        console.warn("[GitBinaryManager] Deleting cached installation for re-download");
        await fs.promises.rm(gitRootDir, { recursive: true, force: true }).catch(() => { });
    }

    // Fast-fail when offline: no point retrying downloads that cannot succeed.
    // Any HTTP response (even 4xx/5xx) means we have network connectivity — only
    // a network-level failure (DNS, connection refused, timeout) means offline.
    // Checking api.github.com directly is avoided because rate-limit responses
    // (HTTP 403/429) would incorrectly look like "offline" with a resp.ok check.
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        await fetch("https://github.com", {
            method: "HEAD",
            signal: controller.signal,
        });
        clearTimeout(timeout);
    } catch {
        console.warn("[GitBinaryManager] Offline — native git unavailable, falling back to builtin sync");
        return undefined;
    }

    // Download with progress UI, retrying the entire flow up to MAX_FULL_RETRIES times
    const MAX_FULL_RETRIES = 2;

    // Track whether the download succeeded inside the withProgress callback.
    // Using a flag + return-undefined pattern keeps this consistent with
    // SQLite/FFmpeg which return null on failure rather than throwing, so
    // callers don't need try/catch to handle "download failed" vs "offline".
    let downloadSucceeded = false;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Downloading Sync Tools",
            cancellable: false,
        },
        async (progress) => {
            let lastError: Error | undefined;

            for (let attempt = 1; attempt <= MAX_FULL_RETRIES; attempt++) {
                try {
                    // Clean up any partial installation from a previous attempt
                    await fs.promises.rm(gitRootDir, { recursive: true, force: true });
                    await fs.promises.mkdir(gitRootDir, { recursive: true });

                    if (attempt > 1) {
                        progress.report({
                            message: `Retry ${attempt}/${MAX_FULL_RETRIES} — Preparing download...`,
                        });
                    } else {
                        progress.report({ message: "Preparing download..." });
                    }

                    const { asset, expectedSha256 } = await findPlatformAsset();

                    const prefix = attempt > 1 ? `Retry ${attempt}/${MAX_FULL_RETRIES} — ` : "";

                    progress.report({ message: `${prefix}Downloading (${formatBytes(asset.size)})...` });

                    const tarballPath = path.join(storageDir, "git-download.tar.gz");
                    const actualSha256 = await downloadFile(asset.browser_download_url, tarballPath, (pct) => {
                        progress.report({
                            message: `${prefix}Downloading... ${pct}%`,
                            increment: pct > 0 ? 1 : 0,
                        });
                    });

                    if (expectedSha256 && actualSha256 !== expectedSha256) {
                        throw new Error(
                            `SHA-256 integrity check failed for ${asset.name}. ` +
                            `Expected: ${expectedSha256.substring(0, 16)}..., ` +
                            `got: ${actualSha256.substring(0, 16)}...`,
                        );
                    }

                    progress.report({ message: `${prefix}Installing...` });
                    await extractTarball(tarballPath, gitRootDir);

                    await fs.promises.unlink(tarballPath).catch(() => { });

                    if (process.platform !== "win32") {
                        await makeExecutable(gitRootDir);
                    }

                    progress.report({ message: `${prefix}Verifying...` });

                    if (!(await isValidInstallation(gitRootDir))) {
                        throw new Error("Git binary verification failed after extraction");
                    }

                    await verifyGitRuns(gitRootDir);

                    // Write SHA-256 marker for startup re-verification
                    const installedGitBin = process.platform === "win32"
                        ? path.join(gitRootDir, "cmd", "git.exe")
                        : path.join(gitRootDir, "bin", "git");
                    try {
                        const hash = await computeGitBinaryHash(installedGitBin);
                        writeGitHashMarker(gitRootDir, hash);
                        console.log(`[GitBinaryManager] SHA-256 of installed binary: ${hash}`);
                    } catch (hashErr) {
                        console.warn("[GitBinaryManager] Could not write SHA-256 marker:", hashErr);
                    }

                    downloadSucceeded = true;
                    console.log("[GitBinaryManager] Git binary installed at:", gitRootDir);
                    return; // exit the withProgress callback
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    await fs.promises.rm(gitRootDir, { recursive: true, force: true }).catch(() => { });

                    if (attempt < MAX_FULL_RETRIES) {
                        const delay = 2000 * Math.pow(2, attempt - 1);
                        console.warn(
                            `[GitBinaryManager] Full attempt ${attempt}/${MAX_FULL_RETRIES} failed, retrying in ${delay}ms:`,
                            lastError.message,
                        );
                        progress.report({
                            message: `Attempt ${attempt} failed — retrying in ${(delay / 1000).toFixed(0)}s...`,
                        });
                        await new Promise((resolve) => setTimeout(resolve, delay));
                    }
                }
            }

            console.error(
                `[GitBinaryManager] All ${MAX_FULL_RETRIES} download attempts failed:`,
                lastError?.message ?? "unknown error",
            );
            // Do NOT throw — callers treat undefined return as "unavailable",
            // consistent with SQLite/FFmpeg returning null on failure.
        },
    );

    if (!downloadSucceeded) {
        return undefined;
    }

    resolvedPaths = buildPaths(gitRootDir);
    return resolvedPaths;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildPaths(gitRootDir: string): GitBinaryPaths {
    if (process.platform === "win32") {
        const archDir = process.arch === "arm64" ? "clangarm64" : "mingw64";
        return {
            localGitDir: gitRootDir,
            execPath: path.join(gitRootDir, archDir, "libexec", "git-core"),
        };
    }
    return {
        localGitDir: gitRootDir,
        execPath: path.join(gitRootDir, "libexec", "git-core"),
    };
}

/** Check if the git binary exists and is runnable. */
async function isValidInstallation(gitRootDir: string): Promise<boolean> {
    try {
        const gitBin = process.platform === "win32"
            ? path.join(gitRootDir, "cmd", "git.exe")
            : path.join(gitRootDir, "bin", "git");

        // On Windows, X_OK is not supported and falls back to F_OK (exists);
        // executability is determined by file extension (.exe).
        // On macOS/Linux, X_OK verifies the execute permission bit.
        const accessMode = process.platform === "win32"
            ? fs.constants.F_OK
            : fs.constants.X_OK;
        await fs.promises.access(gitBin, accessMode);
        return true;
    } catch {
        return false;
    }
}

interface PlatformAssetInfo {
    asset: GitHubAsset;
    expectedSha256?: string;
}

/**
 * Verify the git binary actually executes by running `git --version`.
 * Catches architecture mismatches (e.g. x64 binary on ARM without Rosetta),
 * corrupted binaries that passed the file-existence check, or missing
 * shared libraries.
 */
async function verifyGitRuns(gitRootDir: string): Promise<void> {
    const gitBin = process.platform === "win32"
        ? path.join(gitRootDir, "cmd", "git.exe")
        : path.join(gitRootDir, "bin", "git");

    try {
        const { stdout } = await execFileAsync(gitBin, ["--version"], { timeout: 10_000 });
        console.log(`[GitBinaryManager] Verified: ${stdout.trim()}`);
    } catch (err) {
        throw new Error(
            `Git binary exists but failed to execute: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

/** Find the tar.gz asset for the current platform from the GitHub release (with retries). */
async function findPlatformAsset(): Promise<PlatformAssetInfo> {
    const platformKey = `${os.platform()}-${os.arch()}`;
    const targetSuffix = PLATFORM_MAP[platformKey];

    if (!targetSuffix) {
        throw new Error(
            `Unsupported platform: ${platformKey}. ` +
            `Supported: ${Object.keys(PLATFORM_MAP).join(", ")}`,
        );
    }

    // Cap at 2 attempts — if GitHub is still failing on the second try, more retries burn rate limits.
    const MAX_API_ATTEMPTS = 2;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_API_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(GITHUB_API_RELEASE_URL, {
                headers: {
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "frontier-authentication-vscode",
                },
            });

            if (!response.ok) {
                await response.text().catch(() => {});
                throw new Error(
                    `Failed to fetch release info: ${response.status} ${response.statusText}`,
                );
            }

            const release = (await response.json()) as GitHubRelease;

            const assetPattern = new RegExp(
                `dugite-native-.*-${targetSuffix.replace("-", "\\-")}\\.tar\\.gz$`,
            );
            const asset = release.assets.find((a) => assetPattern.test(a.name));

            if (!asset) {
                throw new Error(
                    `No tar.gz asset found for ${targetSuffix} in release ${release.tag_name}. ` +
                    `Available: ${release.assets.map((a) => a.name).join(", ")}`,
                );
            }

            // Try to fetch the companion .sha256 checksum (best-effort)
            let expectedSha256: string | undefined;
            const sha256Asset = release.assets.find((a) => a.name === `${asset.name}.sha256`);
            if (sha256Asset) {
                try {
                    const sha256Resp = await fetch(sha256Asset.browser_download_url, {
                        headers: { "User-Agent": "frontier-authentication-vscode" },
                        redirect: "follow",
                    });
                    if (sha256Resp.ok) {
                        const text = await sha256Resp.text();
                        const hash = text.trim().split(/\s+/)[0];
                        if (/^[a-f0-9]{64}$/i.test(hash)) {
                            expectedSha256 = hash.toLowerCase();
                        }
                    }
                } catch {
                    // SHA-256 file unavailable — proceed without verification
                }
            }

            return { asset, expectedSha256 };
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < MAX_API_ATTEMPTS - 1) {
                const delay = 1000 * Math.pow(2, attempt);
                console.warn(
                    `[GitBinaryManager] Asset lookup attempt ${attempt + 1}/${MAX_API_ATTEMPTS} failed, retrying in ${delay}ms:`,
                    lastError.message,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError ?? new Error("Failed to find platform asset after retries");
}

/**
 * Download a file from a URL to a local path with progress reporting.
 * Returns the SHA-256 hex digest of the downloaded content for integrity
 * verification against the published .sha256 companion file.
 *
 * Uses stream.pipeline for proper backpressure handling — the previous
 * implementation ignored WriteStream.write() return values, which could
 * buffer unbounded data in memory on slow disks or network-backed storage
 * (OneDrive, Dropbox redirecting globalStorageUri).
 */
async function downloadFile(
    url: string,
    destPath: string,
    onProgress?: (percent: number) => void,
): Promise<string> {
    const MAX_DOWNLOAD_ATTEMPTS = 2;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(url, {
                headers: { "User-Agent": "frontier-authentication-vscode" },
                redirect: "follow",
            });

            if (!response.ok) {
                await response.text().catch(() => {});
                throw new Error(`Download failed: ${response.status} ${response.statusText}`);
            }

            if (!response.body) {
                throw new Error("Response has no body");
            }

            const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
            const hash = crypto.createHash("sha256");
            let downloaded = 0;
            let lastReportedPct = -1;

            async function* readChunks(): AsyncGenerator<Uint8Array> {
                const reader = response.body!.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done || !value) {
                            break;
                        }

                        hash.update(value);
                        downloaded += value.length;

                        if (contentLength > 0 && onProgress) {
                            const pct = Math.round((downloaded / contentLength) * 100);
                            if (pct !== lastReportedPct) {
                                lastReportedPct = pct;
                                onProgress(pct);
                            }
                        }

                        yield value;
                    }
                } finally {
                    reader.releaseLock();
                }
            }

            const readable = Readable.from(readChunks());
            const fileStream = fs.createWriteStream(destPath);
            await pipeline(readable, fileStream);

            return hash.digest("hex");
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < MAX_DOWNLOAD_ATTEMPTS - 1) {
                const delay = 1000 * Math.pow(2, attempt);
                console.warn(
                    `[GitBinaryManager] Download attempt ${attempt + 1}/${MAX_DOWNLOAD_ATTEMPTS} failed, retrying in ${delay}ms:`,
                    lastError.message,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError || new Error("Download failed after retries");
}

/** Extract a .tar.gz file to a destination directory. */
async function extractTarball(tarballPath: string, destDir: string): Promise<void> {
    await tar.x({
        file: tarballPath,
        cwd: destDir,
        strip: 1, // Strip the top-level directory from the archive
    });
}

/**
 * Make binaries executable on Unix (macOS / Linux).
 *
 * Walks each known binary directory, including subdirectories (e.g.
 * libexec/git-core/mergetools/), so that helper scripts and credential
 * helpers that dugite-native ships are also covered.  Without +x these
 * would silently fail when git invokes them.
 */
async function makeExecutable(dir: string): Promise<void> {
    const binDirs = ["bin", "libexec/git-core"];

    const chmodDir = async (dirPath: string): Promise<void> => {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isFile() || entry.isSymbolicLink()) {
                await fs.promises.chmod(fullPath, 0o755).catch(() => { });
            } else if (entry.isDirectory()) {
                await chmodDir(fullPath);
            }
        }
    };

    for (const binDir of binDirs) {
        await chmodDir(path.join(dir, binDir));
    }
}

/** Format bytes as human-readable. */
function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

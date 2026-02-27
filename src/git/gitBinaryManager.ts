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
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import * as tar from "tar";

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

/** Returns the currently resolved paths, or undefined if not yet initialized. */
export function getResolvedPath(): GitBinaryPaths | undefined {
    return resolvedPaths;
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
 * @param context The VS Code extension context (for globalStorageUri)
 * @returns Resolved paths to the git binary
 */
export async function ensureGitBinary(
    context: vscode.ExtensionContext,
): Promise<GitBinaryPaths> {
    if (resolvedPaths) {
        return resolvedPaths;
    }

    const storageDir = context.globalStorageUri.fsPath;
    await fs.promises.mkdir(storageDir, { recursive: true });

    const gitRootDir = path.join(storageDir, "git", DUGITE_NATIVE_TAG);

    // Check if already downloaded and valid
    if (await isValidInstallation(gitRootDir)) {
        resolvedPaths = buildPaths(gitRootDir);
        console.log("[GitBinaryManager] Using existing git binary at:", gitRootDir);
        return resolvedPaths;
    }

    // Download with progress UI, retrying the entire flow up to MAX_FULL_RETRIES times
    const MAX_FULL_RETRIES = 3;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Downloading Git runtime...",
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
                            message: `Retry ${attempt}/${MAX_FULL_RETRIES} — Finding platform binary...`,
                        });
                    } else {
                        progress.report({ message: "Finding platform binary..." });
                    }

                    const asset = await findPlatformAsset();

                    const prefix = attempt > 1 ? `Retry ${attempt}/${MAX_FULL_RETRIES} — ` : "";

                    progress.report({ message: `${prefix}Downloading ${formatBytes(asset.size)}...` });

                    const tarballPath = path.join(storageDir, "git-download.tar.gz");
                    await downloadFile(asset.browser_download_url, tarballPath, (pct) => {
                        progress.report({
                            message: `${prefix}Downloading... ${pct}%`,
                            increment: pct > 0 ? 1 : 0,
                        });
                    });

                    progress.report({ message: `${prefix}Extracting...` });
                    await extractTarball(tarballPath, gitRootDir);

                    await fs.promises.unlink(tarballPath).catch(() => { });

                    if (process.platform !== "win32") {
                        await makeExecutable(gitRootDir);
                    }

                    progress.report({ message: `${prefix}Verifying...` });

                    if (!(await isValidInstallation(gitRootDir))) {
                        throw new Error("Git binary verification failed after extraction");
                    }

                    console.log("[GitBinaryManager] Git binary installed at:", gitRootDir);
                    return; // Success
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

            throw lastError ?? new Error("Git binary download failed after all retries");
        },
    );

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

        await fs.promises.access(gitBin, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Find the tar.gz asset for the current platform from the GitHub release (with retries). */
async function findPlatformAsset(): Promise<GitHubAsset> {
    const platformKey = `${os.platform()}-${os.arch()}`;
    const targetSuffix = PLATFORM_MAP[platformKey];

    if (!targetSuffix) {
        throw new Error(
            `Unsupported platform: ${platformKey}. ` +
            `Supported: ${Object.keys(PLATFORM_MAP).join(", ")}`,
        );
    }

    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(GITHUB_API_RELEASE_URL, {
                headers: {
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "frontier-authentication-vscode",
                },
            });

            if (!response.ok) {
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

            return asset;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < maxRetries) {
                const delay = 1000 * Math.pow(2, attempt);
                console.warn(
                    `[GitBinaryManager] Asset lookup attempt ${attempt + 1} failed, retrying in ${delay}ms:`,
                    lastError.message,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError ?? new Error("Failed to find platform asset after retries");
}

/** Download a file from a URL to a local path with progress reporting. */
async function downloadFile(
    url: string,
    destPath: string,
    onProgress?: (percent: number) => void,
): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                headers: { "User-Agent": "frontier-authentication-vscode" },
                redirect: "follow",
            });

            if (!response.ok) {
                throw new Error(`Download failed: ${response.status} ${response.statusText}`);
            }

            if (!response.body) {
                throw new Error("Response has no body");
            }

            const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
            const fileStream = fs.createWriteStream(destPath);
            const reader = response.body.getReader();

            let downloaded = 0;
            let lastReportedPct = -1;

            const writeStream = new WritableStream({
                write(chunk) {
                    fileStream.write(chunk);
                    downloaded += chunk.length;
                    if (contentLength > 0 && onProgress) {
                        const pct = Math.round((downloaded / contentLength) * 100);
                        if (pct !== lastReportedPct) {
                            lastReportedPct = pct;
                            onProgress(pct);
                        }
                    }
                },
                close() {
                    fileStream.end();
                },
                abort(err) {
                    fileStream.destroy(err instanceof Error ? err : new Error(String(err)));
                },
            });

            await reader
                .read()
                .then(function process({ done, value }): Promise<void> | undefined {
                    if (done) {
                        fileStream.end();
                        return;
                    }
                    fileStream.write(value);
                    downloaded += value.length;
                    if (contentLength > 0 && onProgress) {
                        const pct = Math.round((downloaded / contentLength) * 100);
                        if (pct !== lastReportedPct) {
                            lastReportedPct = pct;
                            onProgress(pct);
                        }
                    }
                    return reader.read().then(process);
                });

            // Wait for the file to finish writing
            await new Promise<void>((resolve, reject) => {
                fileStream.on("finish", resolve);
                fileStream.on("error", reject);
            });

            return; // Success
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < maxRetries) {
                const delay = 1000 * Math.pow(2, attempt);
                console.warn(
                    `[GitBinaryManager] Download attempt ${attempt + 1} failed, retrying in ${delay}ms:`,
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

/** Recursively make binaries executable on Unix. */
async function makeExecutable(dir: string): Promise<void> {
    const binDirs = ["bin", "libexec/git-core"];
    for (const binDir of binDirs) {
        const fullPath = path.join(dir, binDir);
        try {
            const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile()) {
                    const filePath = path.join(fullPath, entry.name);
                    await fs.promises.chmod(filePath, 0o755).catch(() => { });
                }
            }
        } catch {
            // Directory may not exist
        }
    }
    // Also make git-lfs executable
    const lfsPath = path.join(dir, "bin", "git-lfs");
    await fs.promises.chmod(lfsPath, 0o755).catch(() => { });
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

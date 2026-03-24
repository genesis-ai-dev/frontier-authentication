/**
 * dugiteGit.ts — Routing layer for git operations.
 *
 * Delegates every call to either the native dugite wrapper
 * (dugiteGitNative.ts) or the pure-JS isomorphic-git adapter
 * (isomorphicGitAdapter.ts) based on whether the native git binary
 * has been configured.
 *
 * Consumer files import from this module — their imports remain
 * unchanged regardless of which backend is active.
 */

import * as native from "./dugiteGitNative";
import * as fallback from "./isomorphicGitAdapter";

// ---------------------------------------------------------------------------
// Re-export types (identical in both implementations)
// ---------------------------------------------------------------------------

export type { StatusMatrixEntry, LogEntry, ProgressCallback } from "./dugiteGitNative";
export { GitOperationError } from "./dugiteGitNative";

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

let _forceBuiltin = false;

/**
 * Force the use of isomorphic-git regardless of binary availability.
 * Intended for testing or user preference.
 */
export function setForceBuiltin(force: boolean): void {
    _forceBuiltin = force;
}

function shouldUseNative(): boolean {
    if (_forceBuiltin) return false;
    return native.isGitBinaryConfigured();
}

// ---------------------------------------------------------------------------
// Binary-path helpers — always forward to the native module since they
// manage the dugite binary and are irrelevant for isomorphic-git.
// ---------------------------------------------------------------------------

export const setGitBinaryPath = native.setGitBinaryPath;
export const setAskpassPath = native.setAskpassPath;
export const useEmbeddedGitBinary = native.useEmbeddedGitBinary;
export const getGitBinaryPaths = native.getGitBinaryPaths;

export function isGitBinaryConfigured(): boolean {
    return native.isGitBinaryConfigured();
}

/** Returns true when git operations will work (either native or fallback). */
export function isGitAvailable(): boolean {
    return true; // isomorphic-git is always bundled
}

// ---------------------------------------------------------------------------
// Progress parsing — native only (isomorphic-git uses its own events)
// ---------------------------------------------------------------------------

export function parseGitProgress(data: string, onProgress?: native.ProgressCallback): void {
    return shouldUseNative()
        ? native.parseGitProgress(data, onProgress)
        : fallback.parseGitProgress(data, onProgress);
}

// ---------------------------------------------------------------------------
// Git operations — one-liner routing via shouldUseNative()
// ---------------------------------------------------------------------------

export async function init(dir: string): Promise<void> {
    return shouldUseNative() ? native.init(dir) : fallback.init(dir);
}

export async function setConfig(dir: string, key: string, value: string): Promise<void> {
    return shouldUseNative() ? native.setConfig(dir, key, value) : fallback.setConfig(dir, key, value);
}

export async function disableLfsFilters(dir: string): Promise<void> {
    return shouldUseNative() ? native.disableLfsFilters(dir) : fallback.disableLfsFilters(dir);
}

export async function resolveRef(dir: string, ref: string): Promise<string> {
    return shouldUseNative() ? native.resolveRef(dir, ref) : fallback.resolveRef(dir, ref);
}

export async function currentBranch(dir: string): Promise<string | null> {
    return shouldUseNative() ? native.currentBranch(dir) : fallback.currentBranch(dir);
}

export async function findMergeBase(dir: string, oid1: string, oid2: string): Promise<string[]> {
    return shouldUseNative() ? native.findMergeBase(dir, oid1, oid2) : fallback.findMergeBase(dir, oid1, oid2);
}

export async function listRemotes(dir: string): Promise<Array<{ remote: string; url: string }>> {
    return shouldUseNative() ? native.listRemotes(dir) : fallback.listRemotes(dir);
}

export async function addRemote(dir: string, name: string, url: string): Promise<void> {
    return shouldUseNative() ? native.addRemote(dir, name, url) : fallback.addRemote(dir, name, url);
}

export async function deleteRemote(dir: string, name: string): Promise<void> {
    return shouldUseNative() ? native.deleteRemote(dir, name) : fallback.deleteRemote(dir, name);
}

export async function add(dir: string, filepath: string): Promise<void> {
    return shouldUseNative() ? native.add(dir, filepath) : fallback.add(dir, filepath);
}

export async function addMany(
    dir: string,
    filepaths: string[],
    options?: { batchSize?: number; maxRetries?: number },
): Promise<void> {
    return shouldUseNative() ? native.addMany(dir, filepaths, options) : fallback.addMany(dir, filepaths, options);
}

export async function addAll(dir: string): Promise<void> {
    return shouldUseNative() ? native.addAll(dir) : fallback.addAll(dir);
}

export async function remove(dir: string, filepath: string): Promise<void> {
    return shouldUseNative() ? native.remove(dir, filepath) : fallback.remove(dir, filepath);
}

export async function removeMany(
    dir: string,
    filepaths: string[],
    options?: { batchSize?: number; maxRetries?: number },
): Promise<void> {
    return shouldUseNative() ? native.removeMany(dir, filepaths, options) : fallback.removeMany(dir, filepaths, options);
}

export async function commit(
    dir: string,
    message: string,
    author: { name: string; email: string },
): Promise<string> {
    return shouldUseNative() ? native.commit(dir, message, author) : fallback.commit(dir, message, author);
}

export async function mergeCommit(
    dir: string,
    message: string,
    author: { name: string; email: string },
    parents: string[],
): Promise<string> {
    return shouldUseNative()
        ? native.mergeCommit(dir, message, author, parents)
        : fallback.mergeCommit(dir, message, author, parents);
}

export async function fetchOrigin(
    dir: string,
    auth: { username: string; password: string },
    onProgress?: native.ProgressCallback,
    signal?: AbortSignal,
): Promise<void> {
    return shouldUseNative()
        ? native.fetchOrigin(dir, auth, onProgress, signal)
        : fallback.fetchOrigin(dir, auth, onProgress, signal);
}

export async function fastForward(
    dir: string,
    branch: string,
    auth: { username: string; password: string },
    signal?: AbortSignal,
): Promise<void> {
    return shouldUseNative()
        ? native.fastForward(dir, branch, auth, signal)
        : fallback.fastForward(dir, branch, auth, signal);
}

export async function push(
    dir: string,
    auth: { username: string; password: string },
    options?: { ref?: string; onProgress?: native.ProgressCallback; signal?: AbortSignal },
): Promise<void> {
    return shouldUseNative() ? native.push(dir, auth, options) : fallback.push(dir, auth, options);
}

export async function clone(
    url: string,
    dir: string,
    auth?: { username: string; password: string },
    onProgress?: native.ProgressCallback,
    signal?: AbortSignal,
): Promise<void> {
    return shouldUseNative()
        ? native.clone(url, dir, auth, onProgress, signal)
        : fallback.clone(url, dir, auth, onProgress, signal);
}

export async function statusMatrix(dir: string): Promise<native.StatusMatrixEntry[]> {
    return shouldUseNative() ? native.statusMatrix(dir) : fallback.statusMatrix(dir);
}

export async function statusMatrixAtRef(
    dir: string,
    ref: string,
): Promise<native.StatusMatrixEntry[]> {
    return shouldUseNative() ? native.statusMatrixAtRef(dir, ref) : fallback.statusMatrixAtRef(dir, ref);
}

export async function log(
    dir: string,
    options?: { depth?: number; ref?: string },
): Promise<native.LogEntry[]> {
    return shouldUseNative() ? native.log(dir, options) : fallback.log(dir, options);
}

export async function readBlobAtRef(
    dir: string,
    ref: string,
    filepath: string,
): Promise<Buffer> {
    return shouldUseNative()
        ? native.readBlobAtRef(dir, ref, filepath)
        : fallback.readBlobAtRef(dir, ref, filepath);
}

export async function hasGitRepository(dir: string): Promise<boolean> {
    return shouldUseNative() ? native.hasGitRepository(dir) : fallback.hasGitRepository(dir);
}

export async function status(dir: string, filepath: string): Promise<string | undefined> {
    return shouldUseNative() ? native.status(dir, filepath) : fallback.status(dir, filepath);
}

export async function updateRef(dir: string, ref: string, value: string): Promise<void> {
    return shouldUseNative() ? native.updateRef(dir, ref, value) : fallback.updateRef(dir, ref, value);
}

export async function checkout(dir: string, ref: string, force = false): Promise<void> {
    return shouldUseNative() ? native.checkout(dir, ref, force) : fallback.checkout(dir, ref, force);
}

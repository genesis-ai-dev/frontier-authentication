/**
 * lfsPointerUtils.ts — Minimal LFS pointer utilities.
 *
 * Replaces @fetsorn/isogit-lfs's formatPointerInfo() and buildPointerInfo()
 * with native Node.js implementations. These are the only two functions from
 * that library that were actually used.
 */

import * as crypto from "crypto";

/**
 * Format an LFS pointer info object into the standard pointer file content.
 * This produces the exact same output as @fetsorn/isogit-lfs formatPointerInfo().
 *
 * @param info - Object with oid (SHA-256 hex) and size (byte count)
 * @returns Uint8Array containing the pointer file text
 */
export function formatPointerInfo(info: { oid: string; size: number }): Uint8Array {
    const text = `version https://git-lfs.github.com/spec/v1\noid sha256:${info.oid}\nsize ${info.size}\n`;
    return Buffer.from(text, "utf-8");
}

/**
 * Compute the LFS pointer info (SHA-256 OID and size) from raw file content.
 * This produces the exact same output as @fetsorn/isogit-lfs buildPointerInfo().
 *
 * @param content - The raw file bytes
 * @returns Object with oid (SHA-256 hex) and size (byte count)
 */
export function buildPointerInfo(content: Buffer | Uint8Array): { oid: string; size: number } {
    const oid = crypto.createHash("sha256").update(content).digest("hex");
    return { oid, size: content.length };
}

/** Commits whose contents were used to produce the conflict list. */
export interface MergeSnapshot {
    localHead: string;
    remoteHead: string;
    baseHead?: string;
}

/**
 * Abort completeMerge when the heads no longer match the ones the conflict
 * list was computed from (typically: another client pushed while this one was
 * resolving conflicts). Committing anyway would produce a merge whose tree
 * silently reverts the newly pushed commits.
 *
 * The message is a cross-extension contract. "MERGE_STATE_CHANGED" is the
 * marker current Codex clients classify as retriable; "non-fast-forward" keeps
 * older Codex clients retrying as well (same technique as assertSyncHeads in
 * GitService). A retry re-runs the whole sync, so the resolutions still on
 * disk are committed and re-analysed against the new heads.
 */
export function assertMergeSnapshot(expected: MergeSnapshot, current: MergeSnapshot): void {
    if (expected.localHead !== current.localHead || expected.remoteHead !== current.remoteHead) {
        throw new Error(
            "MERGE_STATE_CHANGED: Local or remote history changed during conflict resolution " +
            "(non-fast-forward). No merge commit was created; sync must analyse the new changes before retrying."
        );
    }
}

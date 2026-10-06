import * as assert from "assert";
import {
    BLOB_READ_FAILED_PREFIX,
    CONFLICT_ANALYSIS_CONCURRENCY,
    analyzeConflicts,
    mapWithConcurrency,
} from "../../../git/conflictAnalysis";
import type { ConflictAnalysisDeps } from "../../../git/conflictAnalysis";

/**
 * A file version is: a string (readable content), an Error (the file exists
 * but reading it fails — e.g. the git process could not be spawned), or
 * undefined (absent at that ref).
 */
type Version = string | Error | undefined;
interface Fixture {
    local?: Version;
    working?: Version;
    remote?: Version;
    base?: Version;
}

function fakeDeps(files: Record<string, Fixture>, onRead?: () => Promise<void>) {
    const reads: string[] = [];
    const read =
        (source: keyof Fixture) =>
        async (filepath: string): Promise<string> => {
            reads.push(`${source}:${filepath}`);
            if (onRead) {
                await onRead();
            }
            const value = files[filepath]?.[source];
            if (value instanceof Error) {
                throw value;
            }
            if (value === undefined) {
                throw new Error(`fatal: path '${filepath}' does not exist in '${source}'`);
            }
            return value;
        };
    const exists = (version: Version): boolean => version !== undefined;
    const deps: ConflictAnalysisDeps = {
        existence: (filepath) => ({
            local: exists(files[filepath]?.local),
            remote: exists(files[filepath]?.remote),
            base: exists(files[filepath]?.base),
        }),
        readLocalBlob: read("local"),
        readWorkingFile: read("working"),
        readRemoteBlob: read("remote"),
        readBaseBlob: read("base"),
    };
    return { deps, reads };
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (error) {
        return error as Error;
    }
    throw new Error("expected the promise to reject");
}

suite("conflictAnalysis: BLOB_READ_FAILED wire contract", () => {
    test("prefix is the exact string codex-editor matches on", () => {
        // Hard-coded on purpose: codex-editor/src/projectManager/utils/merge/
        // transientSyncError.ts asserts the same literal.
        assert.strictEqual(BLOB_READ_FAILED_PREFIX, "BLOB_READ_FAILED:");
    });

    test("default concurrency is a small positive bound", () => {
        assert.ok(Number.isInteger(CONFLICT_ANALYSIS_CONCURRENCY));
        assert.ok(CONFLICT_ANALYSIS_CONCURRENCY >= 1 && CONFLICT_ANALYSIS_CONCURRENCY <= 64);
    });
});

suite("conflictAnalysis: mapWithConcurrency", () => {
    test("never runs more than `concurrency` calls at once and keeps input order", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const items = Array.from({ length: 50 }, (_, i) => i);
        const results = await mapWithConcurrency(items, 4, async (item) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 1 + (item % 3)));
            inFlight--;
            return item * 2;
        });
        assert.strictEqual(maxInFlight, 4);
        assert.deepStrictEqual(
            results,
            items.map((i) => i * 2)
        );
    });

    test("re-throws the first failure and starts no further calls", async () => {
        const started: number[] = [];
        const error = await rejectionOf(
            mapWithConcurrency([0, 1, 2, 3, 4], 1, async (item) => {
                started.push(item);
                if (item === 1) {
                    throw new Error("boom");
                }
                return item;
            })
        );
        assert.strictEqual(error.message, "boom");
        assert.deepStrictEqual(started, [0, 1]);
    });

    test("handles an empty input", async () => {
        assert.deepStrictEqual(await mapWithConcurrency([], 8, async (x) => x), []);
    });
});

suite("conflictAnalysis: analyzeConflicts", () => {
    test("returns remote-only additions as new conflicts carrying the remote content", async () => {
        const { deps, reads } = fakeDeps({
            "pointers/a.wav": { remote: "pointer a" },
            "pointers/b.wav": { remote: "pointer b" },
        });
        const conflicts = await analyzeConflicts(deps, {
            filepaths: ["pointers/a.wav", "pointers/b.wav"],
            modifiedInBoth: [],
        });
        assert.deepStrictEqual(conflicts, [
            {
                filepath: "pointers/a.wav",
                ours: "",
                theirs: "pointer a",
                base: "",
                isNew: true,
                isDeleted: false,
            },
            {
                filepath: "pointers/b.wav",
                ours: "",
                theirs: "pointer b",
                base: "",
                isNew: true,
                isDeleted: false,
            },
        ]);
        // Only the version that exists is read: no wasted local/base reads.
        assert.deepStrictEqual(reads.sort(), ["remote:pointers/a.wav", "remote:pointers/b.wav"]);
    });

    test("a failed read of a file that exists aborts with BLOB_READ_FAILED instead of dropping the file", async () => {
        const spawnFailure = Object.assign(new Error("spawn git EAGAIN"), { code: "EAGAIN" });
        const { deps } = fakeDeps({
            "pointers/ok.wav": { remote: "pointer" },
            "pointers/unreadable.wav": { remote: spawnFailure },
        });
        const error = await rejectionOf(
            analyzeConflicts(deps, {
                filepaths: ["pointers/ok.wav", "pointers/unreadable.wav"],
                modifiedInBoth: [],
            })
        );
        assert.ok(
            error.message.startsWith(BLOB_READ_FAILED_PREFIX),
            `expected prefix, got: ${error.message}`
        );
        assert.ok(error.message.includes("pointers/unreadable.wav"));
        assert.ok(error.message.includes("EAGAIN"));
        assert.strictEqual((error as Error & { cause?: unknown }).cause, spawnFailure);
    });

    test("a failed merge-base or local read is also fatal", async () => {
        const { deps: baseFails } = fakeDeps({
            "files/x.codex": { local: "L", remote: "R", base: new Error("bad object") },
        });
        const baseError = await rejectionOf(
            analyzeConflicts(baseFails, { filepaths: ["files/x.codex"], modifiedInBoth: [] })
        );
        assert.ok(baseError.message.startsWith(BLOB_READ_FAILED_PREFIX));
        assert.ok(baseError.message.includes("merge-base"));

        const { deps: localFails } = fakeDeps({
            "files/y.codex": { local: new Error("bad object"), remote: "R", base: "B" },
        });
        const localError = await rejectionOf(
            analyzeConflicts(localFails, { filepaths: ["files/y.codex"], modifiedInBoth: [] })
        );
        assert.ok(localError.message.startsWith(BLOB_READ_FAILED_PREFIX));
        assert.ok(localError.message.includes("local"));
    });

    test("files with identical content on both sides are not conflicts", async () => {
        const { deps } = fakeDeps({
            "same-as-base.txt": { local: "same", remote: "same", base: "same" },
            "both-changed-alike.txt": { local: "same", remote: "same", base: "old" },
        });
        const conflicts = await analyzeConflicts(deps, {
            filepaths: ["same-as-base.txt", "both-changed-alike.txt"],
            modifiedInBoth: [],
        });
        assert.deepStrictEqual(conflicts, []);
    });

    test("files modified in both branches are always conflicts with all three versions", async () => {
        const { deps } = fakeDeps({
            "files/target/JUD.codex": { local: "L", remote: "R", base: "B" },
        });
        const conflicts = await analyzeConflicts(deps, {
            filepaths: ["files/target/JUD.codex"],
            modifiedInBoth: ["files/target/JUD.codex"],
        });
        assert.deepStrictEqual(conflicts, [
            {
                filepath: "files/target/JUD.codex",
                ours: "L",
                theirs: "R",
                base: "B",
                isNew: false,
                isDeleted: false,
            },
        ]);
    });

    test("a deletion on either side is reported with isDeleted so the client can apply it", async () => {
        const { deps } = fakeDeps({
            "edited-here-deleted-there.txt": { local: "L2", base: "B" },
            "deleted-here-edited-there.txt": { remote: "R2", base: "B" },
            "deleted-here-untouched-there.txt": { remote: "B", base: "B" },
            "untouched-here-deleted-there.txt": { local: "B", base: "B" },
        });
        const conflicts = await analyzeConflicts(deps, {
            filepaths: [
                "edited-here-deleted-there.txt",
                "deleted-here-edited-there.txt",
                "deleted-here-untouched-there.txt",
                "untouched-here-deleted-there.txt",
            ],
            modifiedInBoth: [],
        });
        assert.deepStrictEqual(
            conflicts.map((c) => [c.filepath, c.ours, c.theirs, c.base, c.isDeleted]),
            [
                ["edited-here-deleted-there.txt", "L2", "", "B", true],
                ["deleted-here-edited-there.txt", "", "R2", "B", true],
                ["deleted-here-untouched-there.txt", "", "B", "B", true],
                ["untouched-here-deleted-there.txt", "B", "", "B", true],
            ]
        );
    });

    test("locally added files come from the working tree, falling back to the local commit", async () => {
        const { deps } = fakeDeps({
            "new/from-working.txt": { local: "committed", working: "working copy" },
            "new/working-missing.txt": { local: "committed", working: new Error("ENOENT") },
            "new/added-on-both.txt": { local: "mine", working: "mine", remote: "theirs" },
        });
        const conflicts = await analyzeConflicts(deps, {
            filepaths: ["new/from-working.txt", "new/working-missing.txt", "new/added-on-both.txt"],
            modifiedInBoth: [],
        });
        assert.deepStrictEqual(
            conflicts.map((c) => [c.filepath, c.ours, c.theirs, c.isNew]),
            [
                ["new/from-working.txt", "working copy", "", true],
                ["new/working-missing.txt", "committed", "", true],
                ["new/added-on-both.txt", "mine", "theirs", true],
            ]
        );

        const { deps: bothFail } = fakeDeps({
            "new/unreadable.txt": { local: new Error("bad object"), working: new Error("ENOENT") },
        });
        const error = await rejectionOf(
            analyzeConflicts(bothFail, { filepaths: ["new/unreadable.txt"], modifiedInBoth: [] })
        );
        assert.ok(error.message.startsWith(BLOB_READ_FAILED_PREFIX));
    });

    test("analyses at most `concurrency` files at a time across thousands of paths", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const files: Record<string, Fixture> = {};
        const filepaths: string[] = [];
        for (let i = 0; i < 2000; i++) {
            const filepath = `pointers/audio-${i}.wav`;
            files[filepath] = { remote: `pointer ${i}` };
            filepaths.push(filepath);
        }
        const { deps } = fakeDeps(files, async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setImmediate(resolve));
            inFlight--;
        });
        const conflicts = await analyzeConflicts(deps, {
            filepaths,
            modifiedInBoth: [],
            concurrency: 16,
        });
        assert.strictEqual(conflicts.length, 2000);
        assert.ok(maxInFlight <= 16, `max in flight was ${maxInFlight}`);
        assert.ok(maxInFlight > 1, "expected some parallelism");
    });
});

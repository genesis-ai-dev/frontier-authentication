import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { resolveEmbeddedGitDir, resolveGitBinary } from "dugite";
import * as vscode from "vscode";
import * as dugiteGit from "../../../git/dugiteGit";
import * as nativeGit from "../../../git/dugiteGitNative";
import { GitService } from "../../../git/GitService";
import { findRemoteEquivalentAdditions, findUnchangedSyncFiles } from "../../../git/unchangedSyncFiles";

/**
 * Locate a Git installation laid out the way dugite expects (`cmd/git.exe` on
 * Windows, `bin/git` elsewhere). The `git` on PATH can live deeper inside the
 * installation — Git Bash on Windows resolves to `mingw64/bin/git.exe` — so
 * walk up from it until dugite's binary path exists. Fall back to dugite's
 * embedded git when the system installation has an unfamiliar layout.
 */
function locateNativeGit(): { localGitDir: string; execPath: string } {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const onPath = execFileSync(locator, ["git"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    const candidates: string[] = [];
    for (let dir = path.dirname(onPath); ; dir = path.dirname(dir)) {
        candidates.push(dir);
        if (path.dirname(dir) === dir) { break; }
    }
    candidates.push(resolveEmbeddedGitDir());
    const localGitDir = candidates.find((dir) => fs.existsSync(resolveGitBinary(dir)));
    if (!localGitDir) {
        throw new Error(`No dugite-compatible Git installation found from ${onPath}`);
    }
    const execPath = execFileSync(resolveGitBinary(localGitDir), ["--exec-path"], { encoding: "utf8" }).trim();
    return { localGitDir, execPath };
}

/**
 * Native git writes loose objects read-only, and Windows refuses to delete a
 * read-only file until the attribute is cleared. Make the tree writable first.
 */
function removeRepository(dir: string): void {
    const makeWritable = (entry: string): void => {
        const stat = fs.lstatSync(entry);
        if (stat.isSymbolicLink()) { return; }
        fs.chmodSync(entry, stat.isDirectory() ? 0o777 : 0o666);
        if (stat.isDirectory()) {
            for (const child of fs.readdirSync(entry)) { makeWritable(path.join(entry, child)); }
        }
    };
    makeWritable(dir);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

suite("GitService: unchanged sync file verification", function () {
    this.timeout(120000);
    let dir: string;
    function git(...args: string[]): string {
        return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
            cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    }
    function write(file: string, bytes: string | Buffer): void {
        fs.writeFileSync(path.join(dir, file), bytes);
    }
    suiteSetup(async () => {
        await vscode.extensions.getExtension("frontier-rnd.frontier-authentication")?.activate();
    });
    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-unchanged-sync-"));
        git("init", "-q", "-b", "main");
        git("config", "user.name", "Sync verification");
        git("config", "user.email", "test@example.invalid");
        git("config", "core.autocrlf", "false");
        const { localGitDir, execPath } = locateNativeGit();
        dugiteGit.setGitBinaryPath(localGitDir, execPath);
    });
    teardown(() => {
        dugiteGit.setForceBuiltin(false);
        dugiteGit.useEmbeddedGitBinary();
        removeRepository(dir);
    });

    for (const builtin of [false, true]) {
        test(`requires both commits, index and actual disk bytes to match (${builtin ? "builtin" : "native"})`, async () => {
            dugiteGit.setForceBuiltin(builtin);
            const unusual = process.platform === "win32" ? "unicode-دری.txt" : "unicode-دری\twith\nnewline.txt";
            const files = ["same.bin", "edited.bin", "missing.txt", "staged.txt", "different.bin", "mode.txt", unusual];
            for (const file of files) { write(file, Buffer.from([0xff])); }
            git("add", ".");
            git("commit", "-qm", "base");
            const localHead = git("rev-parse", "HEAD");
            git("checkout", "-qb", "remote");
            write("incoming.txt", "remote-only file left on disk");
            write("different.bin", Buffer.from([0xfe]));
            git("add", ".");
            git("update-index", "--chmod=+x", "mode.txt");
            git("commit", "-qm", "remote content and mode changes");
            git("checkout-index", "--force", "--", "mode.txt");
            const remoteHead = git("rev-parse", "HEAD");
            git("checkout", "-q", "main");
            write("incoming.txt", "remote-only file left on disk");
            write("edited.bin", Buffer.from([0xfe]));
            fs.unlinkSync(path.join(dir, "missing.txt"));
            write("staged.txt", "new staged work");
            git("add", "staged.txt");
            write("staged.txt", Buffer.from([0xff]));

            // Deliberately stale clean statuses for edited/missing files prove
            // actual disk bytes are checked independently of Git's stat cache.
            const status: dugiteGit.StatusMatrixEntry[] = files.map(file => [file, 1, 1, file === "staged.txt" ? 2 : 1]);
            status.push(["incoming.txt", 0, 1, 2]);
            const unchanged = await findUnchangedSyncFiles(dir, { localHead, remoteHead }, status);
            assert.deepStrictEqual([...unchanged].sort(), ["same.bin", unusual].sort());
            const entries = await dugiteGit.blobEntriesAtRef(dir, localHead);
            assert.ok(entries.has(unusual), "Tree parsing must preserve tabs, newlines and Unicode");
            assert.strictEqual(entries.get("mode.txt")?.mode, 0o100644);
            await assert.rejects(dugiteGit.blobEntriesAtRef(dir, "refs/heads/nonexistent"),
                "Unreadable trees must not look like empty trees");
        });

        test(`recognizes only byte-, mode- and index-identical remote additions (${builtin ? "builtin" : "native"})`, async () => {
            dugiteGit.setForceBuiltin(builtin);
            write("base.txt", "base");
            git("add", "base.txt");
            git("commit", "-qm", "base");
            const localHead = git("rev-parse", "HEAD");
            git("checkout", "-qb", "remote");
            write("exact.bin", Buffer.from([0x00, 0xff, 0x7f]));
            write("staged-exact.bin", "remote staged bytes");
            write("different-index.bin", "remote worktree bytes");
            write("missing.bin", "remote but missing locally");
            write("mode.sh", "#!/bin/sh\nexit 0\n");
            fs.chmodSync(path.join(dir, "mode.sh"), 0o755);
            git("add", ".");
            git("update-index", "--chmod=+x", "mode.sh");
            git("commit", "-qm", "remote additions");
            const remoteHead = git("rev-parse", "HEAD");
            git("checkout", "-q", "main");

            write("exact.bin", Buffer.from([0x00, 0xff, 0x7f]));
            write("staged-exact.bin", "remote staged bytes");
            git("add", "staged-exact.bin");
            write("different-index.bin", "valuable staged bytes");
            git("add", "different-index.bin");
            write("different-index.bin", "remote worktree bytes");
            write("mode.sh", "#!/bin/sh\nexit 0\n");
            fs.chmodSync(path.join(dir, "mode.sh"), 0o644);

            const equivalent = await findRemoteEquivalentAdditions(
                dir,
                { localHead, remoteHead },
                await dugiteGit.statusMatrix(dir),
            );
            const expected = ["exact.bin", "staged-exact.bin"];
            if (process.platform === "win32") { expected.push("mode.sh"); }
            assert.deepStrictEqual([...equivalent].sort(), expected.sort());
        });
    }

    test("recovers 1,500 interrupted remote additions without committing or reporting them", async () => {
        dugiteGit.setForceBuiltin(false);
        write("base.txt", "base");
        git("add", "base.txt");
        git("commit", "-qm", "base");
        const baseHead = git("rev-parse", "HEAD");

        git("checkout", "-qb", "remote");
        const pointerDir = ".project/attachments/pointers/BOOK";
        fs.mkdirSync(path.join(dir, pointerDir), { recursive: true });
        const pointerPaths = Array.from({ length: 1500 }, (_, index) =>
            `${pointerDir}/audio-${index}.wav`
        );
        for (const [index, filepath] of pointerPaths.entries()) {
            write(filepath, `version https://git-lfs.github.com/spec/v1\noid sha256:${index.toString(16).padStart(64, "0")}\nsize ${index}\n`);
        }
        git("add", ".");
        git("commit", "-qm", "remote pointers");
        const remoteHead = git("rev-parse", "HEAD");

        git("checkout", "-q", "main");
        write("local.txt", "genuine local history");
        git("add", "local.txt");
        git("commit", "-qm", "local work");
        const localHead = git("rev-parse", "HEAD");
        assert.notStrictEqual(localHead, baseHead);
        git("remote", "add", "origin", "https://example.invalid/project.git");
        git("update-ref", "refs/remotes/origin/main", remoteHead);

        fs.mkdirSync(path.join(dir, pointerDir), { recursive: true });
        for (const [index, filepath] of pointerPaths.entries()) {
            write(filepath, `version https://git-lfs.github.com/spec/v1\noid sha256:${index.toString(16).padStart(64, "0")}\nsize ${index}\n`);
        }
        git("add", ".");

        const stateStub: any = {
            isSyncLocked: () => false,
            acquireSyncLock: async () => true,
            updateLockHeartbeat: async () => {},
            releaseSyncLock: async () => {},
        };
        const service = new GitService(stateStub);
        (service as any).isOnline = async () => true;
        (service as any).reconcilePointersFilesystem = async () => {};
        const originalFetch = dugiteGit.fetchOrigin;
        const originalFastForward = dugiteGit.fastForward;
        const originalPush = dugiteGit.push;
        (dugiteGit as any).fetchOrigin = async () => {};
        (dugiteGit as any).fastForward = async () => {
            throw new Error("divergent histories");
        };
        (dugiteGit as any).push = async () => {};

        try {
            const result = await service.syncChanges(
                dir,
                { username: "oauth2", password: "token" },
                { name: "Sync test", email: "test@example.invalid" }
            );

            assert.strictEqual(result.hadConflicts, true);
            assert.strictEqual(git("rev-parse", "HEAD"), localHead, "recovery must not make a local commit");
            assert.ok(pointerPaths.every((filepath) =>
                !result.allChangedFilePaths?.includes(filepath) &&
                !result.remoteChangedFilePaths?.includes(filepath) &&
                !result.conflicts?.some((conflict) => conflict.filepath === filepath)
            ));

            const remoteEntries = await dugiteGit.blobEntriesAtRef(dir, remoteHead);
            const indexEntries = await dugiteGit.blobEntriesAtIndex(dir);
            for (const filepath of pointerPaths) {
                assert.deepStrictEqual(indexEntries.get(filepath), remoteEntries.get(filepath));
            }

            await service.completeMerge(
                dir,
                { username: "oauth2", password: "token" },
                { name: "Sync test", email: "test@example.invalid" },
                [],
                result.mergeSnapshot
            );
            const [, firstParent, secondParent] = git("rev-list", "--parents", "-n", "1", "HEAD").split(" ");
            assert.strictEqual(firstParent, localHead);
            assert.strictEqual(secondParent, remoteHead);
            const mergedEntries = await dugiteGit.blobEntriesAtRef(dir, "HEAD");
            assert.ok(mergedEntries.has("local.txt"));
            assert.ok(pointerPaths.every((filepath) =>
                mergedEntries.get(filepath)?.oid === remoteEntries.get(filepath)?.oid
            ));
        } finally {
            (dugiteGit as any).fetchOrigin = originalFetch;
            (dugiteGit as any).fastForward = originalFastForward;
            (dugiteGit as any).push = originalPush;
        }
    });

    test("fast-forwards 1,500 remote-equivalent files without a recovery commit", async () => {
        dugiteGit.setForceBuiltin(false);
        write("base.txt", "base");
        git("add", "base.txt");
        git("commit", "-qm", "base");
        const baseHead = git("rev-parse", "HEAD");
        const pointerDir = ".project/attachments/pointers/BOOK";
        const pointerPaths = Array.from({ length: 1500 }, (_, index) =>
            `${pointerDir}/fast-forward-${index}.wav`
        );
        const writePointers = () => {
            fs.mkdirSync(path.join(dir, pointerDir), { recursive: true });
            for (const [index, filepath] of pointerPaths.entries()) {
                write(
                    filepath,
                    `version https://git-lfs.github.com/spec/v1\n` +
                    `oid sha256:${index.toString(16).padStart(64, "b")}\nsize ${index}\n`
                );
            }
        };

        git("checkout", "-qb", "remote", baseHead);
        writePointers();
        git("add", ".");
        git("commit", "-qm", "remote pointers");
        const remoteHead = git("rev-parse", "HEAD");

        git("checkout", "-q", "main");
        git("remote", "add", "origin", "https://example.invalid/project.git");
        git("update-ref", "refs/remotes/origin/main", remoteHead);
        writePointers();
        git("add", "--", ...pointerPaths.slice(0, 10));

        const stateStub: any = {
            isSyncLocked: () => false,
            acquireSyncLock: async () => true,
            updateLockHeartbeat: async () => {},
            releaseSyncLock: async () => {},
        };
        const service = new GitService(stateStub);
        (service as any).isOnline = async () => true;
        (service as any).reconcilePointersFilesystem = async () => {};
        const originalFetch = dugiteGit.fetchOrigin;
        const originalFastForward = dugiteGit.fastForward;
        const originalPush = dugiteGit.push;
        (dugiteGit as any).fetchOrigin = async () => {};
        (dugiteGit as any).fastForward = nativeGit.fastForward;
        (dugiteGit as any).push = async () => {};

        try {
            const result = await service.syncChanges(
                dir,
                { username: "oauth2", password: "token" },
                { name: "Sync test", email: "test@example.invalid" }
            );
            assert.strictEqual(result.hadConflicts, false);
            assert.strictEqual(git("rev-parse", "HEAD"), remoteHead);
            assert.strictEqual(git("rev-list", "--count", `${baseHead}..HEAD`), "1");
            assert.strictEqual(git("status", "--porcelain"), "");
        } finally {
            (dugiteGit as any).fetchOrigin = originalFetch;
            (dugiteGit as any).fastForward = originalFastForward;
            (dugiteGit as any).push = originalPush;
        }
    });

    test("converges a prior local commit containing 1,500 byte-identical remote pointers", async () => {
        dugiteGit.setForceBuiltin(false);
        write("base.txt", "base");
        git("add", "base.txt");
        git("commit", "-qm", "base");
        const baseHead = git("rev-parse", "HEAD");
        const pointerDir = ".project/attachments/pointers/BOOK";
        const pointerPaths = Array.from({ length: 1500 }, (_, index) =>
            `${pointerDir}/committed-${index}.wav`
        );
        const writePointers = () => {
            fs.mkdirSync(path.join(dir, pointerDir), { recursive: true });
            for (const [index, filepath] of pointerPaths.entries()) {
                write(filepath, `version https://git-lfs.github.com/spec/v1\noid sha256:${index.toString(16).padStart(64, "a")}\nsize ${index}\n`);
            }
        };

        git("checkout", "-qb", "remote");
        writePointers();
        git("add", ".");
        git("commit", "-qm", "remote pointers");
        const remoteHead = git("rev-parse", "HEAD");

        git("checkout", "-q", "main");
        assert.strictEqual(git("rev-parse", "HEAD"), baseHead);
        writePointers();
        write("local.txt", "genuine local history");
        git("add", ".");
        git("commit", "-qm", "interrupted sync residue and local work");
        const localHead = git("rev-parse", "HEAD");
        git("remote", "add", "origin", "https://example.invalid/project.git");
        git("update-ref", "refs/remotes/origin/main", remoteHead);

        const stateStub: any = {
            isSyncLocked: () => false,
            acquireSyncLock: async () => true,
            updateLockHeartbeat: async () => {},
            releaseSyncLock: async () => {},
        };
        const service = new GitService(stateStub);
        (service as any).isOnline = async () => true;
        (service as any).reconcilePointersFilesystem = async () => {};
        const originalFetch = dugiteGit.fetchOrigin;
        const originalFastForward = dugiteGit.fastForward;
        const originalPush = dugiteGit.push;
        (dugiteGit as any).fetchOrigin = async () => {};
        (dugiteGit as any).fastForward = async () => {
            throw new Error("divergent histories");
        };
        (dugiteGit as any).push = async () => {};

        try {
            const result = await service.syncChanges(
                dir,
                { username: "oauth2", password: "token" },
                { name: "Sync test", email: "test@example.invalid" }
            );
            assert.strictEqual(result.hadConflicts, true);
            assert.strictEqual(git("rev-parse", "HEAD"), localHead);
            assert.ok(pointerPaths.every((filepath) =>
                !result.allChangedFilePaths?.includes(filepath) &&
                !result.remoteChangedFilePaths?.includes(filepath) &&
                !result.conflicts?.some((conflict) => conflict.filepath === filepath)
            ));

            await service.completeMerge(
                dir,
                { username: "oauth2", password: "token" },
                { name: "Sync test", email: "test@example.invalid" },
                [],
                result.mergeSnapshot
            );
            const [, firstParent, secondParent] = git("rev-list", "--parents", "-n", "1", "HEAD").split(" ");
            assert.strictEqual(firstParent, localHead);
            assert.strictEqual(secondParent, remoteHead);
            const mergedEntries = await dugiteGit.blobEntriesAtRef(dir, "HEAD");
            const remoteEntries = await dugiteGit.blobEntriesAtRef(dir, remoteHead);
            assert.ok(mergedEntries.has("local.txt"));
            assert.ok(pointerPaths.every((filepath) =>
                mergedEntries.get(filepath)?.oid === remoteEntries.get(filepath)?.oid
            ));
        } finally {
            (dugiteGit as any).fetchOrigin = originalFetch;
            (dugiteGit as any).fastForward = originalFastForward;
            (dugiteGit as any).push = originalPush;
        }
    });

    test("stages the resolved pointer without hydrating media", async () => {
        dugiteGit.setForceBuiltin(false);
        const pointerDir = ".project/attachments/pointers/BOOK";
        const pointerPath = `${pointerDir}/resolved.wav`;
        fs.mkdirSync(path.join(dir, pointerDir), { recursive: true });
        const oldPointer =
            `version https://git-lfs.github.com/spec/v1\n` +
            `oid sha256:${"1".repeat(64)}\nsize 10\n`;
        const newPointer =
            `version https://git-lfs.github.com/spec/v1\n` +
            `oid sha256:${"2".repeat(64)}\nsize 20\n`;
        write(pointerPath, oldPointer);
        git("add", ".");
        git("commit", "-qm", "old pointer");
        write(pointerPath, newPointer);

        const stateStub: any = {
            isSyncLocked: () => false,
            acquireSyncLock: async () => true,
            updateLockHeartbeat: async () => {},
            releaseSyncLock: async () => {},
        };
        const service = new GitService(stateStub);
        await (service as any).stageResolvedFileWithLFS(
            dir,
            pointerPath,
            { username: "oauth2", password: "token" }
        );

        assert.strictEqual(git("show", `:${pointerPath}`), newPointer.trim());
        assert.strictEqual(
            fs.existsSync(path.join(dir, ".project/attachments/files/BOOK/resolved.wav")),
            false,
            "merge staging must not materialize media in the files directory"
        );
    });

    test("rejects a merge when the remote advances after conflict analysis", async () => {
        dugiteGit.setForceBuiltin(false);
        write("base.txt", "base");
        git("add", "base.txt");
        git("commit", "-qm", "base");
        const baseHead = git("rev-parse", "HEAD");

        write("local.txt", "local");
        git("add", ".");
        git("commit", "-qm", "local");
        const localHead = git("rev-parse", "HEAD");

        git("checkout", "-qb", "remote", baseHead);
        write("remote.txt", "remote");
        git("add", ".");
        git("commit", "-qm", "remote");
        const remoteHead = git("rev-parse", "HEAD");
        write("advanced.txt", "new remote work");
        git("add", ".");
        git("commit", "-qm", "remote advanced");
        const advancedRemoteHead = git("rev-parse", "HEAD");

        git("checkout", "-q", "main");
        git("remote", "add", "origin", "https://example.invalid/project.git");
        git("update-ref", "refs/remotes/origin/main", remoteHead);
        const indexTree = git("write-tree");

        const stateStub: any = {
            isSyncLocked: () => false,
            acquireSyncLock: async () => true,
            updateLockHeartbeat: async () => {},
            releaseSyncLock: async () => {},
        };
        const service = new GitService(stateStub);
        const originalFetch = dugiteGit.fetchOrigin;
        (dugiteGit as any).fetchOrigin = async () => {
            await dugiteGit.updateRef(dir, "refs/remotes/origin/main", advancedRemoteHead);
        };

        try {
            await assert.rejects(
                service.completeMerge(
                    dir,
                    { username: "oauth2", password: "token" },
                    { name: "Sync test", email: "test@example.invalid" },
                    [],
                    { localHead, remoteHead, baseHead }
                ),
                /MERGE_STATE_CHANGED:/
            );
            assert.strictEqual(git("rev-parse", "HEAD"), localHead);
            assert.strictEqual(git("write-tree"), indexTree);
        } finally {
            (dugiteGit as any).fetchOrigin = originalFetch;
        }
    });
});

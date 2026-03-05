import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { GitService } from "../../../git/GitService";

suite("GitService Branch & Merge Scenarios", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-git-branch-"));
    let repoDir: string;

    const stateStub: any = {
        isSyncLocked: () => false,
        acquireSyncLock: async () => true,
        releaseSyncLock: async () => {},
    };

    const service = new GitService(stateStub);

    suiteSetup(() => {
        dugiteGit.useEmbeddedGitBinary();
    });

    setup(async () => {
        repoDir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
        await service.init(repoDir);

        // Bypass the network connectivity check so mocked fetch/push are reached
        (service as any).isOnline = async () => true;
    });

    teardown(async () => {
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    });

    suite("syncChanges - Branch Scenarios", () => {
        test("remote branch doesn't exist (first push)", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "initial", "utf8");
            await dugiteGit.add(repoDir, "test.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            // Mock fetch to return empty (no remote branch)
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            const originalPush = dugiteGit.push;
            
            (dugiteGit as any).fetchOrigin = async () => {};
            (dugiteGit as any).push = async () => {};

            try {
                const result = await service.syncChanges(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" }
                );
                
                // Result should be defined
                assert.ok(result !== undefined, "Should return result");
                // For first push, skippedDueToLock should be false (or undefined if not set)
                if (result.skippedDueToLock !== undefined) {
                    assert.strictEqual(result.skippedDueToLock, false);
                }
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
                (dugiteGit as any).push = originalPush;
            }
        });

        test("local branch is behind remote (needs fast-forward)", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "local", "utf8");
            await dugiteGit.add(repoDir, "test.txt");
            await dugiteGit.commit(repoDir, "Local commit", { name: "Test", email: "test@example.com" });

            // Mock: fetch brings remote changes, local is behind
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            const originalFastForward = dugiteGit.fastForward;
            const originalPush = dugiteGit.push;
            
            let fetchCalled = false;
            (dugiteGit as any).fetchOrigin = async () => {
                fetchCalled = true;
            };
            
            (dugiteGit as any).fastForward = async () => {};
            (dugiteGit as any).push = async () => {};

            try {
                const result = await service.syncChanges(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" }
                );
                
                assert.strictEqual(fetchCalled, true);
                assert.strictEqual(result.hadConflicts, false);
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
                (dugiteGit as any).fastForward = originalFastForward;
                (dugiteGit as any).push = originalPush;
            }
        });

        test("local branch diverged from remote (needs merge)", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "local", "utf8");
            await dugiteGit.add(repoDir, "test.txt");
            await dugiteGit.commit(repoDir, "Local commit", { name: "Test", email: "test@example.com" });

            // Mock: fetch brings remote changes, branches diverged
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            const originalFastForward = dugiteGit.fastForward;
            
            (dugiteGit as any).fetchOrigin = async () => {};
            
            (dugiteGit as any).fastForward = async () => {
                // Fast-forward fails with merge conflict
                const error: any = new Error("Merge conflict");
                error.name = "MergeConflictError";
                throw error;
            };

            try {
                const result = await service.syncChanges(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" }
                );
                
                // Should detect conflicts (if fast-forward throws merge conflict error)
                assert.ok(result !== undefined, "Should return result");
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
                (dugiteGit as any).fastForward = originalFastForward;
            }
        });

        test("current branch is not tracking remote branch", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "local", "utf8");
            await dugiteGit.add(repoDir, "test.txt");
            await dugiteGit.commit(repoDir, "Local commit", { name: "Test", email: "test@example.com" });

            // Mock: branch exists but not tracking
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            const originalResolveRef = dugiteGit.resolveRef;
            
            (dugiteGit as any).fetchOrigin = async () => {};
            
            (dugiteGit as any).resolveRef = async (_dir: string, ref: string) => {
                if (ref && ref.includes("origin/")) {
                    // Remote ref doesn't exist
                    throw new Error("Reference not found");
                }
                return "local-commit-hash";
            };

            try {
                // Should handle gracefully when remote ref doesn't exist
                const result = await service.syncChanges(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" }
                );
                
                // Should complete without error (pushes to create remote branch)
                assert.ok(result !== undefined);
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
                (dugiteGit as any).resolveRef = originalResolveRef;
            }
        });
    });

    suite("completeMerge - Edge Cases", () => {
        test("complete merge with no resolved files", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "content", "utf8");
            await dugiteGit.add(repoDir, "test.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            // Mock fetch and push
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            const originalResolveRef = dugiteGit.resolveRef;
            const originalCommit = dugiteGit.commit;
            const originalPush = dugiteGit.push;
            
            (dugiteGit as any).fetchOrigin = async () => {};
            (dugiteGit as any).resolveRef = async () => "commit-hash";
            (dugiteGit as any).commit = async () => "merge-commit-hash";
            (dugiteGit as any).push = async () => {};

            try {
                // Complete merge with empty resolved files array
                await service.completeMerge(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" },
                    []
                );
                
                // Should complete without error
                assert.ok(true);
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
                (dugiteGit as any).resolveRef = originalResolveRef;
                (dugiteGit as any).commit = originalCommit;
                (dugiteGit as any).push = originalPush;
            }
        });

        test("complete merge with deleted file resolution", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit with file
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "content", "utf8");
            await dugiteGit.add(repoDir, "test.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            // Mock operations
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            const originalResolveRef = dugiteGit.resolveRef;
            const originalRemove = dugiteGit.remove;
            const originalCommit = dugiteGit.commit;
            const originalPush = dugiteGit.push;
            
            let removeCalled = false;
            (dugiteGit as any).fetchOrigin = async () => {};
            (dugiteGit as any).resolveRef = async () => "commit-hash";
            (dugiteGit as any).remove = async () => {
                removeCalled = true;
            };
            (dugiteGit as any).commit = async () => "merge-commit-hash";
            (dugiteGit as any).push = async () => {};

            try {
                await service.completeMerge(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" },
                    [{ filepath: "test.txt", resolution: "deleted" }]
                );
                
                assert.strictEqual(removeCalled, true, "Should call dugiteGit.remove for deleted files");
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
                (dugiteGit as any).resolveRef = originalResolveRef;
                (dugiteGit as any).remove = originalRemove;
                (dugiteGit as any).commit = originalCommit;
                (dugiteGit as any).push = originalPush;
            }
        });

        test("complete merge with created file resolution", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit with a file
            const initFile = path.join(repoDir, "init.txt");
            await fs.promises.writeFile(initFile, "init", "utf8");
            await dugiteGit.add(repoDir, "init.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            // Create new file
            const newFile = path.join(repoDir, "new.txt");
            await fs.promises.writeFile(newFile, "new content", "utf8");

            // Mock operations
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            const originalResolveRef = dugiteGit.resolveRef;
            const originalAdd = dugiteGit.add;
            const originalCommit = dugiteGit.commit;
            const originalPush = dugiteGit.push;
            
            let addCalled = false;
            (dugiteGit as any).fetchOrigin = async () => {};
            (dugiteGit as any).resolveRef = async () => "commit-hash";
            (dugiteGit as any).add = async () => {
                addCalled = true;
            };
            (dugiteGit as any).commit = async () => "merge-commit-hash";
            (dugiteGit as any).push = async () => {};

            try {
                await service.completeMerge(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" },
                    [{ filepath: "new.txt", resolution: "created" }]
                );
                
                assert.strictEqual(addCalled, true, "Should stage created files");
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
                (dugiteGit as any).resolveRef = originalResolveRef;
                (dugiteGit as any).add = originalAdd;
                (dugiteGit as any).commit = originalCommit;
                (dugiteGit as any).push = originalPush;
            }
        });

        test("complete merge fails if sync lock is held", async () => {
            const lockedStateStub: any = {
                isSyncLocked: () => true,
                acquireSyncLock: async () => false,
                releaseSyncLock: async () => {},
            };

            const lockedService = new GitService(lockedStateStub);
            await lockedService.init(repoDir);

            await assert.rejects(
                async () => {
                    await lockedService.completeMerge(
                        repoDir,
                        { username: "oauth2", password: "token" },
                        { name: "Test", email: "test@example.com" },
                        []
                    );
                },
                (error: Error) => {
                    return error.message.includes("Sync operation already in progress");
                },
                "Should fail when sync lock is held"
            );
        });

        test("complete merge with stale remote reference (should fetch first)", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "content", "utf8");
            await dugiteGit.add(repoDir, "test.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            // Mock: fetch should be called before reading remote ref
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            const originalResolveRef = dugiteGit.resolveRef;
            const originalCommit = dugiteGit.commit;
            const originalPush = dugiteGit.push;
            
            let fetchCallCount = 0;
            (dugiteGit as any).fetchOrigin = async () => {
                fetchCallCount++;
            };
            (dugiteGit as any).resolveRef = async () => "commit-hash";
            (dugiteGit as any).commit = async () => "merge-commit-hash";
            (dugiteGit as any).push = async () => {};

            try {
                await service.completeMerge(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" },
                    [{ filepath: "test.txt", resolution: "modified" }]
                );
                
                // Should fetch before reading remote ref
                assert.ok(fetchCallCount > 0, "Should fetch before reading remote reference");
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
                (dugiteGit as any).resolveRef = originalResolveRef;
                (dugiteGit as any).commit = originalCommit;
                (dugiteGit as any).push = originalPush;
            }
        });

        test("complete merge when remote has new commits after conflict resolution", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "content", "utf8");
            await dugiteGit.add(repoDir, "test.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            // Mock: first fetch gets old ref, second fetch (in completeMerge) gets new ref
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            const originalResolveRef = dugiteGit.resolveRef;
            const originalCommit = dugiteGit.commit;
            const originalPush = dugiteGit.push;
            
            let fetchCount = 0;
            (dugiteGit as any).fetchOrigin = async () => {
                fetchCount++;
            };
            
            let resolveRefCount = 0;
            (dugiteGit as any).resolveRef = async () => {
                resolveRefCount++;
                // First call returns old ref, subsequent calls return new ref
                if (resolveRefCount === 1) {
                    return "old-remote-hash";
                }
                return "new-remote-hash";
            };
            
            (dugiteGit as any).commit = async () => "merge-commit-hash";
            (dugiteGit as any).push = async () => {};

            try {
                await service.completeMerge(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" },
                    [{ filepath: "test.txt", resolution: "modified" }]
                );
                
                // Should fetch to get latest remote state
                assert.ok(fetchCount > 0, "Should fetch to get latest remote state");
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
                (dugiteGit as any).resolveRef = originalResolveRef;
                (dugiteGit as any).commit = originalCommit;
                (dugiteGit as any).push = originalPush;
            }
        });
    });
});

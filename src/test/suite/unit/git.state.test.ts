import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { GitService } from "../../../git/GitService";

suite("GitService Working Copy & Repository State", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-git-state-"));
    let repoDir: string;

    const stateStub: any = {
        isSyncLocked: () => false,
        acquireSyncLock: async () => true,
        releaseSyncLock: async () => {},
    };

    const service = new GitService(stateStub);

    suiteSetup(() => {
        // Point dugite at system git for tests
        dugiteGit.setGitBinaryPath("/usr", "/usr/libexec/git-core");
    });

    setup(async () => {
        repoDir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
    });

    teardown(async () => {
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    });

    suite("getWorkingCopyState", () => {
        test("returns correct dirty state for new files", async () => {
            await service.init(repoDir);
            
            // Create initial commit
            const file1 = path.join(repoDir, "file1.txt");
            await fs.promises.writeFile(file1, "content1", "utf8");
            await dugiteGit.add(repoDir, "file1.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            // Add new file (untracked)
            const file2 = path.join(repoDir, "file2.txt");
            await fs.promises.writeFile(file2, "content2", "utf8");

            const state = await service.getWorkingCopyState(repoDir);
            assert.strictEqual(state.isDirty, true, "Should detect new untracked file");
            assert.ok(state.status.length > 0, "Should have status entries");
        });

        test("returns correct dirty state for modified files", async () => {
            await service.init(repoDir);
            
            // Create initial commit
            const file1 = path.join(repoDir, "file1.txt");
            await fs.promises.writeFile(file1, "content1", "utf8");
            await dugiteGit.add(repoDir, "file1.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            // Modify file
            await fs.promises.writeFile(file1, "modified content", "utf8");

            const state = await service.getWorkingCopyState(repoDir);
            assert.strictEqual(state.isDirty, true, "Should detect modified file");
        });

        test("returns correct dirty state for deleted files", async () => {
            await service.init(repoDir);
            
            // Create initial commit
            const file1 = path.join(repoDir, "file1.txt");
            await fs.promises.writeFile(file1, "content1", "utf8");
            await dugiteGit.add(repoDir, "file1.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            // Delete file
            await fs.promises.unlink(file1);

            const state = await service.getWorkingCopyState(repoDir);
            assert.strictEqual(state.isDirty, true, "Should detect deleted file");
        });

        test("returns correct dirty state for staged changes", async () => {
            await service.init(repoDir);
            
            // Create initial commit
            const file1 = path.join(repoDir, "file1.txt");
            await fs.promises.writeFile(file1, "content1", "utf8");
            await dugiteGit.add(repoDir, "file1.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            // Modify and stage
            await fs.promises.writeFile(file1, "modified", "utf8");
            await dugiteGit.add(repoDir, "file1.txt");

            const state = await service.getWorkingCopyState(repoDir);
            assert.strictEqual(state.isDirty, true, "Should detect staged changes");
        });

        test("handles empty repository", async () => {
            await service.init(repoDir);

            const state = await service.getWorkingCopyState(repoDir);
            assert.strictEqual(state.isDirty, false, "Empty repo should not be dirty");
            assert.ok(Array.isArray(state.status), "Should return status array");
        });

        test("handles repository with no changes", async () => {
            await service.init(repoDir);
            
            // Create initial commit
            const file1 = path.join(repoDir, "file1.txt");
            await fs.promises.writeFile(file1, "content1", "utf8");
            await dugiteGit.add(repoDir, "file1.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            const state = await service.getWorkingCopyState(repoDir);
            assert.strictEqual(state.isDirty, false, "Clean repo should not be dirty");
        });

        test("handles mixed changes (new, modified, deleted)", async () => {
            await service.init(repoDir);
            
            // Create initial commit with multiple files
            const file1 = path.join(repoDir, "file1.txt");
            const file2 = path.join(repoDir, "file2.txt");
            await fs.promises.writeFile(file1, "content1", "utf8");
            await fs.promises.writeFile(file2, "content2", "utf8");
            await dugiteGit.add(repoDir, "file1.txt");
            await dugiteGit.add(repoDir, "file2.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            // Make mixed changes
            await fs.promises.writeFile(file1, "modified", "utf8"); // Modified
            await fs.promises.unlink(file2); // Deleted
            const file3 = path.join(repoDir, "file3.txt");
            await fs.promises.writeFile(file3, "new", "utf8"); // New

            const state = await service.getWorkingCopyState(repoDir);
            assert.strictEqual(state.isDirty, true, "Should detect mixed changes");
        });
    });

    suite("hasGitRepository", () => {
        test("returns false before first commit", async () => {
            await service.init(repoDir);
            
            const hasRepo = await service.hasGitRepository(repoDir);
            assert.strictEqual(hasRepo, false, "Should return false before first commit");
        });

        test("returns true after first commit", async () => {
            await service.init(repoDir);
            
            // Create initial commit
            const file1 = path.join(repoDir, "file1.txt");
            await fs.promises.writeFile(file1, "content1", "utf8");
            await dugiteGit.add(repoDir, "file1.txt");
            await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

            const hasRepo = await service.hasGitRepository(repoDir);
            assert.strictEqual(hasRepo, true, "Should return true after first commit");
        });

        test("returns false for non-git directory", async () => {
            const nonGitDir = fs.mkdtempSync(path.join(tmpRoot, "non-git-"));
            const file1 = path.join(nonGitDir, "file1.txt");
            await fs.promises.writeFile(file1, "content", "utf8");

            const hasRepo = await service.hasGitRepository(nonGitDir);
            assert.strictEqual(hasRepo, false, "Should return false for non-git directory");

            // Cleanup
            fs.rmSync(nonGitDir, { recursive: true, force: true });
        });

        test("returns true after multiple commits", async () => {
            await service.init(repoDir);
            
            // Create multiple commits
            for (let i = 1; i <= 3; i++) {
                const file = path.join(repoDir, `file${i}.txt`);
                await fs.promises.writeFile(file, `content${i}`, "utf8");
                await dugiteGit.add(repoDir, `file${i}.txt`);
                await dugiteGit.commit(repoDir, `Commit ${i}`, { name: "Test", email: "test@example.com" });
            }

            const hasRepo = await service.hasGitRepository(repoDir);
            assert.strictEqual(hasRepo, true, "Should return true after multiple commits");
        });
    });
});

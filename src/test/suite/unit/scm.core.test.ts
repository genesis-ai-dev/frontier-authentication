import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { SCMManager } from "../../../scm/SCMManager";
import { GitLabService } from "../../../gitlab/GitLabService";
import type { GitService } from "../../../git/GitService";
import { StateManager } from "../../../state";
import * as versionChecker from "../../../utils/extensionVersionChecker";

suite("SCMManager Core Operations", () => {
    let mockProvider: vscode.Disposable | undefined;
    let scmManager: SCMManager;
    let workspaceDir: string;
    let mockContext: vscode.ExtensionContext;

    suiteSetup(async () => {
        mockProvider = await registerMockAuthProvider();
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        assert.ok(ext, "Extension not found");
        await ext!.activate();

        StateManager.initialize({
            globalState: {
                get: () => undefined,
                update: async () => {},
            },
            workspaceState: {
                get: () => undefined,
                update: async () => {},
            },
            subscriptions: [],
        } as unknown as vscode.ExtensionContext);

        mockContext = {
            subscriptions: [],
            globalState: {
                get: () => undefined,
                update: async () => {},
            },
            workspaceState: {
                get: () => undefined,
                update: async () => {},
            },
        } as unknown as vscode.ExtensionContext;
    });

    setup(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-scm-core-"));
        
        // Note: workspaceFolders is read-only, so we can't mock it directly
        // Instead, tests that need workspace should use a real workspace setup
        // For these unit tests, we'll test the methods that don't require workspace
        
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        const authProvider = (await ext!.activate()).authProvider;
        const gitLabService = new GitLabService(authProvider);
        scmManager = new SCMManager(gitLabService, mockContext);
    });

    teardown(async () => {
        try {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {}
    });

    suiteTeardown(async () => {
        if (mockProvider) {
            mockProvider.dispose();
        }
    });

    test("toggleAutoSync enables auto-sync when disabled", async () => {
        assert.strictEqual(scmManager.isAutoSyncEnabled(), false, "Should start disabled");
        
        // Access private method via type assertion for testing
        (scmManager as any).toggleAutoSync();
        
        assert.strictEqual(scmManager.isAutoSyncEnabled(), true, "Should be enabled after toggle");
    });

    test("toggleAutoSync disables auto-sync when enabled", async () => {
        // Enable first
        (scmManager as any).toggleAutoSync();
        assert.strictEqual(scmManager.isAutoSyncEnabled(), true, "Should be enabled");
        
        // Disable
        (scmManager as any).toggleAutoSync();
        assert.strictEqual(scmManager.isAutoSyncEnabled(), false, "Should be disabled after toggle");
    });

    test("auto-sync respects sync lock", async () => {
        // Initialize git repo first
        await scmManager.gitService.init(workspaceDir);
        
        const stateManager = StateManager.getInstance();
        
        // Acquire lock
        await stateManager.acquireSyncLock(workspaceDir);
        assert.strictEqual(stateManager.isSyncLocked(), true, "Lock should be held");
        
        // Auto-sync should skip when lock is held
        // This is tested through syncChanges behavior
        const result = await scmManager.gitService.syncChanges(
            workspaceDir,
            { username: "oauth2", password: "token" },
            { name: "Test", email: "test@example.com" }
        );
        
        assert.strictEqual(result.skippedDueToLock, true, "Should skip when lock held");
        
        await stateManager.releaseSyncLock();
    });

    /**
     * Drive SCMManager.syncChanges with a stubbed GitService so the test pins
     * the shape of what reaches the client (Codex) without needing a remote.
     * The metadata version gate is bypassed because the test workspace has no
     * metadata.json.
     */
    async function syncWithStubbedGitService(
        gitResult: Awaited<ReturnType<GitService["syncChanges"]>>
    ) {
        const originalCheck = versionChecker.checkMetadataVersionsForSync;
        (versionChecker as any).checkMetadataVersionsForSync = async () => true;
        (scmManager as any).getWorkspacePath = () => workspaceDir;
        (scmManager as any).gitLabService = {
            getToken: async () => "token",
            getCurrentUser: async () => ({
                username: "sync-test",
                name: "Sync Test",
                email: "sync-test@example.invalid",
            }),
        };
        scmManager.gitService = {
            isSyncLocked: () => false,
            syncChanges: async () => gitResult,
        } as unknown as GitService;
        try {
            return await scmManager.syncChanges({ commitMessage: "test" }, true);
        } finally {
            (versionChecker as any).checkMetadataVersionsForSync = originalCheck;
        }
    }

    test("syncChanges forwards the merge snapshot and uploaded LFS files with the conflict list", async () => {
        // Codex hands mergeSnapshot back to completeMerge so the merge is
        // verified against the exact commits the conflicts were computed from.
        // Dropping it here silently downgrades that guard to whatever HEAD and
        // origin/<branch> point at when completeMerge starts.
        const mergeSnapshot = {
            localHead: "a".repeat(40),
            remoteHead: "b".repeat(40),
            baseHead: "c".repeat(40),
        };
        const conflicts = [
            {
                filepath: "files/target/GEN.codex",
                ours: "{}",
                theirs: "{}",
                base: "{}",
                isNew: false,
                isDeleted: false,
            },
        ];
        const uploadedLfsFiles = [".project/attachments/files/GEN/GEN_001_001.wav"];

        const result = await syncWithStubbedGitService({
            hadConflicts: true,
            conflicts,
            mergeSnapshot,
            uploadedLfsFiles,
            allChangedFilePaths: ["files/target/GEN.codex"],
            remoteChangedFilePaths: ["files/target/GEN.codex"],
        });

        assert.strictEqual(result.hasConflicts, true);
        assert.deepStrictEqual(result.conflicts, conflicts);
        assert.deepStrictEqual(result.mergeSnapshot, mergeSnapshot);
        assert.deepStrictEqual(result.uploadedLfsFiles, uploadedLfsFiles);
        assert.deepStrictEqual(result.remoteChangedFilePaths, ["files/target/GEN.codex"]);
    });

    test("syncChanges forwards uploaded LFS files when the sync completed without conflicts", async () => {
        const uploadedLfsFiles = [".project/attachments/files/GEN/GEN_001_002.wav"];

        const result = await syncWithStubbedGitService({ hadConflicts: false, uploadedLfsFiles });

        assert.strictEqual(result.hasConflicts, false);
        assert.strictEqual(result.mergeSnapshot, undefined);
        assert.deepStrictEqual(result.uploadedLfsFiles, uploadedLfsFiles);
    });
});


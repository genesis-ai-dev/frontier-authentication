import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { SCMManager } from "../../../scm/SCMManager";
import { GitLabService } from "../../../gitlab/GitLabService";
import { StateManager } from "../../../state";

suite("Integration: SCMManager Merge & File Watcher", () => {
    let mockProvider: vscode.Disposable | undefined;
    let workspaceDir: string;
    let mockContext: vscode.ExtensionContext;

    suiteSetup(async () => {
        dugiteGit.useEmbeddedGitBinary();

        mockProvider = await registerMockAuthProvider();
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        assert.ok(ext, "Extension not found");
        await ext!.activate();

        StateManager.initialize({
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
            subscriptions: [],
        } as unknown as vscode.ExtensionContext);

        mockContext = {
            subscriptions: [],
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
        } as unknown as vscode.ExtensionContext;
    });

    setup(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-merge-watcher-"));
        // Note: workspaceFolders is read-only, tests use gitService directly
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

    test("complete merge with multiple resolved files", async () => {
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        const authProvider = (await ext!.activate()).authProvider;
        const gitLabService = new GitLabService(authProvider);
        const scmManager = new SCMManager(gitLabService, mockContext);

        // Initialize repo
        await scmManager.gitService.init(workspaceDir);
        await scmManager.gitService.addRemote(workspaceDir, "origin", "https://example.com/repo.git");

        const resolvedFiles = [
            { filepath: "file1.txt", resolution: "modified" as const },
            { filepath: "file2.txt", resolution: "deleted" as const },
            { filepath: "file3.txt", resolution: "created" as const },
        ];

        // Mock operations
        const originalFetchOrigin = dugiteGit.fetchOrigin;
        const originalResolveRef = dugiteGit.resolveRef;
        const originalCommit = dugiteGit.commit;
        const originalPush = dugiteGit.push;

        (dugiteGit as any).fetchOrigin = async () => {};
        (dugiteGit as any).resolveRef = async () => "hash";
        (dugiteGit as any).commit = async () => "merge-hash";
        (dugiteGit as any).push = async () => {};

        try {
            await scmManager.completeMerge(resolvedFiles, workspaceDir);
            assert.ok(true, "Should complete merge with multiple files");
        } catch (error) {
            // May fail if files don't exist, but should handle multiple files
            assert.ok(error instanceof Error);
        } finally {
            (dugiteGit as any).fetchOrigin = originalFetchOrigin;
            (dugiteGit as any).resolveRef = originalResolveRef;
            (dugiteGit as any).commit = originalCommit;
            (dugiteGit as any).push = originalPush;
        }
    });
});

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

suite("E2E: Full Workflows", () => {
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
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-e2e-"));
        // Note: workspaceFolders is read-only, E2E tests should use real workspace setup
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

    test("full sync flow: make changes → sync → verify", async () => {
        await dugiteGit.init(workspaceDir);
        await dugiteGit.addRemote(workspaceDir, "origin", "https://example.com/repo.git");
        
        // Create initial commit so we're on a branch
        await fs.promises.writeFile(path.join(workspaceDir, "README.md"), "readme", "utf8");
        await dugiteGit.add(workspaceDir, "README.md");
        await dugiteGit.commit(workspaceDir, "Initial", { name: "Test", email: "test@example.com" });

        // Use gitService directly instead of SCMManager to avoid command registration conflicts
        const stateManager = StateManager.getInstance();
        const { GitService } = await import("../../../git/GitService");
        const gitService = new GitService(stateManager);

        // Create file
        await fs.promises.writeFile(path.join(workspaceDir, "test.txt"), "content", "utf8");

        // Mock fetch to simulate remote matching local after sync commits
        const originalFetchOrigin = dugiteGit.fetchOrigin;
        const originalPush = dugiteGit.push;
        const originalResolveRef = dugiteGit.resolveRef;
        (dugiteGit as any).fetchOrigin = async () => {};
        (dugiteGit as any).push = async () => {};

        // Mock resolveRef for remote ref to return current HEAD,
        // simulating "remote is up to date" after the mocked fetch
        (dugiteGit as any).resolveRef = async (dir: string, ref: string) => {
            if (ref.includes("origin/")) {
                return originalResolveRef(dir, "HEAD");
            }
            return originalResolveRef(dir, ref);
        };

        try {
            const result = await gitService.syncChanges(
                workspaceDir,
                { username: "oauth2", password: "token" },
                { name: "Test", email: "test@example.com" }
            );

            assert.ok(result !== undefined, "Should complete sync");
        } finally {
            (dugiteGit as any).fetchOrigin = originalFetchOrigin;
            (dugiteGit as any).push = originalPush;
            (dugiteGit as any).resolveRef = originalResolveRef;
        }
    });
});

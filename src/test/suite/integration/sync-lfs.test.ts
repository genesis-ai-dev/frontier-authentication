import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { GitLabService } from "../../../gitlab/GitLabService";
import { SCMManager } from "../../../scm/SCMManager";
import { StateManager } from "../../../state";

suite("Integration: sync uses Git LFS for pointer downloads", () => {
    let mockProvider: vscode.Disposable | undefined;
    let originalFetch: any;
    let workspaceDir: string;
    let originalGetExtension: any;

    suiteSetup(async () => {
        dugiteGit.useEmbeddedGitBinary();

        // Register mock VS Code auth provider and activate extension
        mockProvider = await registerMockAuthProvider();
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        assert.ok(ext, "Extension not found");
        await ext!.activate();

        // Monkey-patch GitLabService methods used by sync
        (GitLabService as any).prototype.initializeWithRetry = async function () {
            this.gitlabToken = "mock-token";
            this.gitlabBaseUrl = "https://gitlab.example.com";
        };
        (GitLabService as any).prototype.getToken = async function () {
            this.gitlabToken = this.gitlabToken || "mock-token";
            return this.gitlabToken;
        };
        (GitLabService as any).prototype.getCurrentUser = async function () {
            return { id: 1, username: "tester", name: "Tester", email: "tester@example.com" };
        };

        // Stub metadata version checker to always allow syncing
        const versionChecker = await import("../../../utils/extensionVersionChecker");
        (versionChecker as any).checkMetadataVersionsForSync = async () => true;

        // Keep original getExtension and patch to satisfy any version lookups
        originalGetExtension = vscode.extensions.getExtension;
        (vscode.extensions as any).getExtension = (id: string) => {
            if (id === "project-accelerate.codex-editor-extension") {
                return { packageJSON: { version: "0.0.0" } } as any;
            }
            if (id === "frontier-rnd.frontier-authentication") {
                return { packageJSON: { version: "0.4.15" } } as any;
            }
            return originalGetExtension.call(vscode.extensions, id);
        };
    });

    setup(async () => {
        // Prepare a temporary workspace
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-sync-lfs-"));

        // Initialize a real git repo
        await dugiteGit.init(workspaceDir);
        await dugiteGit.disableLfsFilters(workspaceDir);
        // Write initial file and commit, so HEAD exists
        await fs.promises.writeFile(path.join(workspaceDir, "README.md"), "hello", "utf8");
        await dugiteGit.add(workspaceDir, "README.md");
        const headOid = await dugiteGit.commit(workspaceDir, "initial", { name: "Tester", email: "tester@example.com" });
        // Add remote and create matching remote ref
        const remoteUrl = "https://example.com/repo.git";
        await dugiteGit.addRemote(workspaceDir, "origin", remoteUrl);
        await dugiteGit.updateRef(workspaceDir, "refs/remotes/origin/main", headOid);

        // Mark pointers as LFS-tracked
        await fs.promises.writeFile(
            path.join(workspaceDir, ".gitattributes"),
            ".project/attachments/pointers/** filter=lfs\n",
            "utf8"
        );

        // Place a valid pointer in pointers dir and ensure files dir missing
        const fakeOid = "b".repeat(64);
        const pointerRel = ".project/attachments/pointers/audio/sync.wav";
        const pointerAbs = path.join(workspaceDir, pointerRel);
        await fs.promises.mkdir(path.dirname(pointerAbs), { recursive: true });
        const pointerText = [
            "version https://git-lfs.github.com/spec/v1",
            `oid sha256:${fakeOid}`,
            "size 11",
        ].join("\n");
        await fs.promises.writeFile(pointerAbs, pointerText, "utf8");

        // Stage and commit the pointer so local HEAD includes it
        await dugiteGit.add(workspaceDir, pointerRel);
        const newHead = await dugiteGit.commit(workspaceDir, "add pointer", { name: "Tester", email: "tester@example.com" });
        // Make remote ref match local HEAD to avoid fast-forward path
        await dugiteGit.updateRef(workspaceDir, "refs/remotes/origin/main", newHead);

        // Ensure files dir path exists but target file absent
        const filesAbs = path.join(workspaceDir, ".project/attachments/files/audio/sync.wav");
        await fs.promises.mkdir(path.dirname(filesAbs), { recursive: true });
        try {
            await fs.promises.unlink(filesAbs);
        } catch {}

        // Initialize StateManager with a minimal fake context
        const fakeContext: any = {
            subscriptions: [],
            globalState: {
                get: (_key: string) => undefined,
                update: async (_key: string, _value: any) => {},
            },
            workspaceState: { get: () => undefined, update: async () => {} },
        };
        StateManager.initialize(fakeContext);

        // Force SCMManager to use our temp workspace path
        (SCMManager as any).prototype.getWorkspacePath = function () {
            return workspaceDir;
        };
        // Prevent duplicate command registration inside tests
        (SCMManager as any).prototype.registerCommands = function () {};

        // Stub dugiteGit fetch/fastForward/push to no-op to avoid network
        (dugiteGit as any).fetchOrigin = async () => {};
        (dugiteGit as any).fastForward = async () => {};
        (dugiteGit as any).push = async () => {};

        // Stub fetch to simulate LFS batch + download
        originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (input: any, init?: any) => {
            const url = typeof input === "string" ? input : String(input);
            const method = init?.method || "GET";

            if (url.includes("/info/lfs/objects/batch") && method === "POST") {
                const resp = {
                    objects: [
                        {
                            oid: fakeOid,
                            size: 11,
                            actions: {
                                download: {
                                    href: "https://lfs-download.example.com/sync-obj",
                                    header: { accept: "application/octet-stream" },
                                },
                            },
                        },
                    ],
                };
                return new Response(JSON.stringify(resp), {
                    status: 200,
                    headers: { "content-type": "application/vnd.git-lfs+json" },
                });
            }

            if (url.startsWith("https://lfs-download.example.com/") && method === "GET") {
                return new Response(Buffer.from("hello-sync"), { status: 200 });
            }

            // Allow unrelated calls
            return new Response("", { status: 200 });
        };
    });

    teardown(async () => {
        // Restore fetch and cleanup
        (globalThis as any).fetch = originalFetch;
        try {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {}
    });

    suiteTeardown(async () => {
        if (mockProvider) {
            mockProvider.dispose();
        }
        if (originalGetExtension) {
            (vscode.extensions as any).getExtension = originalGetExtension;
        }
    });

    test("syncChanges triggers LFS batch download and writes files bytes", async () => {
        // Instantiate GitLabService and SCMManager
        const authProvider: any = {}; // not used by our patched methods
        const gitlabService = new GitLabService(authProvider);
        const fakeContext: any = {
            subscriptions: [],
            workspaceState: { get: () => undefined, update: async () => {} },
        };
        const scmManager = new SCMManager(gitlabService, fakeContext);

        const result = await scmManager.syncChanges({ commitMessage: "test" }, true);
        assert.ok(result && result.hasConflicts === false);

        // Verify bytes were written to files dir by reconcilePointersFilesystem
        const filesAbs = path.join(workspaceDir, ".project/attachments/files/audio/sync.wav");
        const bytes = await fs.promises.readFile(filesAbs);
        assert.strictEqual(bytes.toString(), "hello-sync");
    });
});

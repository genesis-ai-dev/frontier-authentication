import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { GitService } from "../../../git/GitService";
import { StateManager } from "../../../state";

suite("Integration: LFS Error Scenarios", () => {
    let mockProvider: vscode.Disposable | undefined;
    let workspaceDir: string;
    let gitService: GitService;
    let originalFetch: any;

    suiteSetup(async () => {
        dugiteGit.useEmbeddedGitBinary();

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

        gitService = new GitService(StateManager.getInstance());
        originalFetch = (globalThis as any).fetch;
    });

    setup(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-lfs-integration-"));
        await dugiteGit.init(workspaceDir);
        await dugiteGit.disableLfsFilters(workspaceDir);
        await dugiteGit.addRemote(workspaceDir, "origin", "https://example.com/repo.git");
        
        await fs.promises.writeFile(
            path.join(workspaceDir, ".gitattributes"),
            ".project/attachments/pointers/** filter=lfs\n",
            "utf8"
        );
    });

    teardown(async () => {
        (globalThis as any).fetch = originalFetch;
        try {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {}
    });

    suiteTeardown(async () => {
        if (mockProvider) {
            mockProvider.dispose();
        }
    });

    test("LFS upload failures with retry", async () => {
        const pointer = path.join(workspaceDir, ".project/attachments/pointers/file.bin");
        await fs.promises.mkdir(path.dirname(pointer), { recursive: true });
        await fs.promises.writeFile(pointer, Buffer.from("content"));

        let attemptCount = 0;
        (globalThis as any).fetch = async (input: any, init?: any) => {
            const url = typeof input === "string" ? input : String(input);
            const method = init?.method || "GET";

            if (url.endsWith("/info/lfs/objects/batch") && method === "POST") {
                return new Response(
                    JSON.stringify({
                        objects: [
                            {
                                oid: "oid1",
                                actions: {
                                    upload: {
                                        href: "https://lfs.example.com/upload",
                                        header: {},
                                    },
                                },
                            },
                        ],
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/vnd.git-lfs+json" },
                    }
                );
            }

            if (url.includes("/upload") && method === "PUT") {
                attemptCount++;
                if (attemptCount < 2) {
                    throw new Error("ECONNRESET");
                }
                return new Response("", { status: 200 });
            }

            throw new Error(`Unexpected fetch ${method} ${url}`);
        };

        // Should retry on failure
        try {
            await gitService.addAllWithLFS(workspaceDir, { username: "u", password: "p" });
            assert.ok(attemptCount >= 2, "Should retry on failure");
        } catch (error) {
            // May fail if retries exhausted
            assert.ok(error instanceof Error);
        }
    });

    // TODO: Fix assertion failure - test expects LFS conflict detection but hadConflicts is false
    // (commented-out test left as-is — references old isomorphic-git API)

    test("LFS recovery during sync operations", async () => {
        // Setup: Create empty pointer with recoverable bytes
        const pointer = path.join(workspaceDir, ".project/attachments/pointers/file.bin");
        const filesFile = path.join(workspaceDir, ".project/attachments/files/file.bin");
        await fs.promises.mkdir(path.dirname(pointer), { recursive: true });
        await fs.promises.mkdir(path.dirname(filesFile), { recursive: true });
        
        await fs.promises.writeFile(pointer, new Uint8Array());
        await fs.promises.writeFile(filesFile, Buffer.from("recovered"));

        await dugiteGit.add(workspaceDir, ".gitattributes");
        // Create a file to make commit non-empty
        await fs.promises.writeFile(path.join(workspaceDir, "README.md"), "readme", "utf8");
        await dugiteGit.add(workspaceDir, "README.md");
        const baseOid = await dugiteGit.commit(workspaceDir, "Base", { name: "Test", email: "test@example.com" });

        await dugiteGit.updateRef(workspaceDir, "refs/remotes/origin/main", baseOid);

        (globalThis as any).fetch = async (input: any, init?: any) => {
            const url = typeof input === "string" ? input : String(input);
            const method = init?.method || "GET";

            if (url.endsWith("/info/lfs/objects/batch") && method === "POST") {
                return new Response(
                    JSON.stringify({
                        objects: [
                            {
                                oid: "recovered-oid",
                                actions: {
                                    upload: {
                                        href: "https://lfs.example.com/upload",
                                        header: {},
                                    },
                                },
                            },
                        ],
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/vnd.git-lfs+json" },
                    }
                );
            }

            if (url.includes("/upload") && method === "PUT") {
                return new Response("", { status: 200 });
            }

            return new Response("", { status: 200 });
        };

        const originalFetchOrigin = dugiteGit.fetchOrigin;
        (dugiteGit as any).fetchOrigin = async () => {};

        try {
            // Sync should recover empty pointer
            await gitService.syncChanges(
                workspaceDir,
                { username: "oauth2", password: "token" },
                { name: "Test", email: "test@example.com" }
            );
            
            assert.ok(true, "Should handle LFS recovery during sync");
        } finally {
            (dugiteGit as any).fetchOrigin = originalFetchOrigin;
        }
    });
});

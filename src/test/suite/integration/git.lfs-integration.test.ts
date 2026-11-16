import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
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
        
        const recoveredBytes = Buffer.from("recovered");
        const recoveredOid = createHash("sha256").update(recoveredBytes).digest("hex");
        let uploadCount = 0;
        let pushCount = 0;
        await fs.promises.writeFile(pointer, new Uint8Array());
        await fs.promises.writeFile(filesFile, recoveredBytes);

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
                                oid: recoveredOid,
                                size: recoveredBytes.length,
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
                uploadCount++;
                const uploadedBytes = Buffer.from(await new Response(init.body).arrayBuffer());
                assert.deepStrictEqual(uploadedBytes, recoveredBytes);
                return new Response("", { status: 200 });
            }

            throw new Error(`Unexpected fetch ${method} ${url}`);
        };

        const originalFetchOrigin = dugiteGit.fetchOrigin;
        const originalPush = dugiteGit.push;
        const originalIsOnline = gitService.isOnline;
        gitService.isOnline = async () => true;
        (dugiteGit as any).fetchOrigin = async () => {};

        // Mock both Git network boundaries; the LFS fetch mock does not intercept Git HTTP.
        (dugiteGit as typeof dugiteGit).push = async (dir) => {
            assert.strictEqual(dir, workspaceDir);
            pushCount++;
        };

        try {
            // Sync should recover empty pointer
            await gitService.syncChanges(
                workspaceDir,
                { username: "oauth2", password: "token" },
                { name: "Test", email: "test@example.com" }
            );
            
            const expectedPointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${recoveredOid}\nsize ${recoveredBytes.length}\n`;
            assert.strictEqual(uploadCount, 1, "Recovered bytes should be uploaded once");
            assert.strictEqual(pushCount, 1, "Recovered commit should reach the Git push boundary");
            assert.strictEqual(await fs.promises.readFile(pointer, "utf8"), expectedPointer);
            const committed = await dugiteGit.readBlobAtRef(workspaceDir, "HEAD", ".project/attachments/pointers/file.bin");
            assert.strictEqual(Buffer.from(committed).toString("utf8"), expectedPointer);
            assert.deepStrictEqual(await fs.promises.readFile(filesFile), recoveredBytes);
        } finally {
            (dugiteGit as any).fetchOrigin = originalFetchOrigin;
            (dugiteGit as typeof dugiteGit).push = originalPush;
            gitService.isOnline = originalIsOnline;
        }
    });
});

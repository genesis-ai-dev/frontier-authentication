import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { GitLabService } from "../../../gitlab/GitLabService";
import { SCMManager } from "../../../scm/SCMManager";
import { StateManager } from "../../../state";

suite("Integration: clone respects mediaStrategy", () => {
    let workspaceDir: string;
    let originalFetch: any;
    let originalClone: any;
    let originalGetRemoteUrl: any;

    suiteSetup(async () => {
        dugiteGit.useEmbeddedGitBinary();

        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        assert.ok(ext, "Extension not found");
        await ext!.activate();

        // Patch GitLabService minimal auth
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
    });

    setup(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-clone-ms-"));

        await dugiteGit.init(workspaceDir);
        await fs.promises.writeFile(path.join(workspaceDir, "README.md"), "hello", "utf8");
        await dugiteGit.add(workspaceDir, "README.md");
        const headOid = await dugiteGit.commit(workspaceDir, "initial", { name: "Tester", email: "tester@example.com" });

        // Add a pointer under pointers dir
        const fakeOid = "c".repeat(64);
        const pointerRel = ".project/attachments/pointers/audio/clip.wav";
        const pointerAbs = path.join(workspaceDir, pointerRel);
        await fs.promises.mkdir(path.dirname(pointerAbs), { recursive: true });
        const pointerText = [
            "version https://git-lfs.github.com/spec/v1",
            `oid sha256:${fakeOid}`,
            "size 11",
        ].join("\n");
        await fs.promises.writeFile(pointerAbs, pointerText, "utf8");
        await dugiteGit.add(workspaceDir, pointerRel);
        const newHead = await dugiteGit.commit(workspaceDir, "add pointer", { name: "Tester", email: "tester@example.com" });

        // Simulate remote by setting origin and remote ref to HEAD
        const remoteUrl = "https://example.com/repo.git";
        await dugiteGit.addRemote(workspaceDir, "origin", remoteUrl);
        await dugiteGit.updateRef(workspaceDir, "refs/remotes/origin/main", newHead);

        // Stub dugiteGit.clone to avoid network and skip actual clone since repo already present
        originalClone = (dugiteGit as any).clone;
        (dugiteGit as any).clone = async () => {};

        // Stub fetch to satisfy LFS batch/download for auto-download case
        originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (input: any, init?: any) => {
            const url = typeof input === "string" ? input : String(input);
            const method = init?.method || "GET";

            if (url.includes("/info/lfs/objects/batch") && method === "POST") {
                const bodyStr = init?.body ? init.body.toString() : "";
                const req = bodyStr ? JSON.parse(bodyStr) : { objects: [] };
                const objects = (req.objects || []).map((o: any) => ({
                    oid: o.oid,
                    size: o.size || 11,
                    actions: {
                        download: {
                            href: "https://lfs-download.example.com/obj",
                            header: { accept: "application/octet-stream" },
                        },
                    },
                }));
                return new Response(JSON.stringify({ objects }), {
                    status: 200,
                    headers: { "content-type": "application/vnd.git-lfs+json" },
                });
            }

            if (url.startsWith("https://lfs-download.example.com/") && method === "GET") {
                return new Response(Buffer.from("hello-bytes"), { status: 200 });
            }

            return new Response("", { status: 200 });
        };

        // Initialize StateManager
        const fakeContext: any = {
            subscriptions: [],
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
        };
        StateManager.initialize(fakeContext);

        // Patch SCMManager workspace path getter to our target dir later when we simulate opening
        (SCMManager as any).prototype.getWorkspacePath = function () {
            return this.__testWorkspace || workspaceDir;
        };
        (SCMManager as any).prototype.registerCommands = function () {};

        // Ensure GitService.getRemoteUrl returns our origin URL to enable reconcile
        const { GitService } = require("../../../git/GitService");
        originalGetRemoteUrl = GitService.prototype.getRemoteUrl;
        GitService.prototype.getRemoteUrl = async function (_dir: string) {
            return remoteUrl;
        };
    });

    teardown(async () => {
        (globalThis as any).fetch = originalFetch;
        if (originalClone) (dugiteGit as any).clone = originalClone;
        try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
        if (originalGetRemoteUrl) {
            const { GitService } = require("../../../git/GitService");
            GitService.prototype.getRemoteUrl = originalGetRemoteUrl;
        }
    });

    test("stream-only: clone populates files with pointers", async () => {
        // Arrange: create SCM with token
        const authProvider: any = {};
        const gl = new GitLabService(authProvider);
        const context: any = { subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } };
        const scm = new SCMManager(gl, context) as any;

        // Act: call underlying gitService.clone directly
        await scm.gitService.clone("https://example.com/repo.git", workspaceDir, { username: "oauth2", password: "mock-token" }, "stream-only");

        // Assert: files folder should have pointer file (not full media bytes)
        const filesAbs = path.join(workspaceDir, ".project/attachments/files/audio/clip.wav");
        let exists = true;
        try { await fs.promises.access(filesAbs); } catch { exists = false; }
        assert.strictEqual(exists, true, "files/clip.wav pointer should exist");

        // Verify it's a pointer file, not full media
        const content = await fs.promises.readFile(filesAbs, "utf8");
        assert.ok(content.includes("version https://git-lfs.github.com/spec/v1"), "should be a pointer file");
        assert.ok(content.length < 200, "pointer file should be small");
    });

    test("auto-download: clone downloads media bytes", async () => {
        const authProvider: any = {};
        const gl = new GitLabService(authProvider);
        const context: any = { subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } };
        const scm = new SCMManager(gl, context) as any;

        await scm.gitService.clone("https://example.com/repo.git", workspaceDir, { username: "oauth2", password: "mock-token" }, "auto-download");

        const filesAbs = path.join(workspaceDir, ".project/attachments/files/audio/clip.wav");
        // Wait for background reconcile to write bytes
        const start = Date.now();
        let bytes: Buffer | undefined;
        while (Date.now() - start < 2000) { // up to 2s
            try {
                bytes = await fs.promises.readFile(filesAbs);
                break;
            } catch {
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        assert.ok(bytes, "expected files bytes to be written by background reconcile");
        assert.strictEqual(bytes!.toString(), "hello-bytes");
    });
});

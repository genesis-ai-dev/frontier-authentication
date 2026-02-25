import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { StateManager } from "../../../state";

suite("Unit: reconcile respects stream-only strategy", () => {
    suiteSetup(() => {
        // Point dugite at system git for tests
        dugiteGit.setGitBinaryPath("/usr", "/usr/libexec/git-core");
    });

    test("reconcilePointersFilesystem returns early for stream-only", async () => {
        // Arrange a minimal workspace with a pointer
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-reconcile-so-"));
        await dugiteGit.init(dir);

        const pointerRel = ".project/attachments/pointers/audio/stream.wav";
        const pointerAbs = path.join(dir, pointerRel);
        await fs.promises.mkdir(path.dirname(pointerAbs), { recursive: true });
        await fs.promises.writeFile(
            pointerAbs,
            [
                "version https://git-lfs.github.com/spec/v1",
                `oid sha256:${"d".repeat(64)}`,
                "size 3",
            ].join("\n"),
            "utf8"
        );

        // Stage and commit
        await dugiteGit.add(dir, pointerRel);
        await dugiteGit.commit(dir, "add pointer", { name: "Tester", email: "tester@example.com" });

        // Fake remote config so getRemoteUrl is non-empty
        await dugiteGit.addRemote(dir, "origin", "https://example.com/repo.git");

        // Initialize StateManager and set strategy via API
        const ctx: any = {
            subscriptions: [],
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
        };
        StateManager.initialize(ctx);
        await StateManager.getInstance().setRepoStrategy(dir, "stream-only");

        // Stub getRemoteUrl to ensure it resolves, and fetch to avoid network if misfired
        const { GitService } = require("../../../git/GitService");
        const gs = new GitService(StateManager.getInstance());
        const originalGetRemoteUrl = gs.getRemoteUrl;
        (gs as any).getRemoteUrl = async () => "https://example.com/repo.git";

        const originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => new Response(JSON.stringify({ objects: [] }), { status: 200 });

        try {
            // Act: call private method through any-cast
            await (gs as any).reconcilePointersFilesystem(dir, { username: "oauth2", password: "x" });

            // Assert: no files bytes written
            const filesAbs = path.join(dir, ".project/attachments/files/audio/stream.wav");
            let exists = true;
            try { await fs.promises.access(filesAbs); } catch { exists = false; }
            assert.strictEqual(exists, false, "No bulk download in stream-only mode");
        } finally {
            (gs as any).getRemoteUrl = originalGetRemoteUrl;
            (globalThis as any).fetch = originalFetch;
        }
    });
});

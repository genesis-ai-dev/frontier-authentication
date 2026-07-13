import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { StateManager } from "../../../state";

suite("Unit: resolveRepoStrategy treats disk as source of truth", () => {
    suiteSetup(() => {
        dugiteGit.useEmbeddedGitBinary();
    });

    const makeStateManager = (): StateManager => {
        const ctx: any = {
            subscriptions: [],
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
        };
        StateManager.initialize(ctx);
        return StateManager.getInstance();
    };

    const writeStrategyToDisk = async (dir: string, strategy: string): Promise<void> => {
        const settingsAbs = path.join(dir, ".project", "localProjectSettings.json");
        await fs.promises.mkdir(path.dirname(settingsAbs), { recursive: true });
        await fs.promises.writeFile(
            settingsAbs,
            JSON.stringify({ currentMediaFilesStrategy: strategy }, null, 2),
            "utf8"
        );
    };

    test("on-disk stream-and-save overrides a stale auto-download cache", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-resolve-disk-"));
        await writeStrategyToDisk(dir, "stream-and-save");

        const stateManager = makeStateManager();
        // Simulate the stale cache set at clone time (the bug condition).
        await stateManager.setRepoStrategy(dir, "auto-download");

        const { GitService } = require("../../../git/GitService");
        const gs = new GitService(stateManager);

        const resolved = await (gs as any).resolveRepoStrategy(dir);

        assert.strictEqual(
            resolved,
            "stream-and-save",
            "Disk strategy must win over a stale in-memory cache"
        );
        assert.strictEqual(
            stateManager.getRepoStrategy(dir),
            "stream-and-save",
            "Cache should be refreshed to match disk"
        );
    });

    test("falls back to cache when no settings file exists on disk", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-resolve-nodisk-"));

        const stateManager = makeStateManager();
        await stateManager.setRepoStrategy(dir, "stream-only");

        const { GitService } = require("../../../git/GitService");
        const gs = new GitService(stateManager);

        const resolved = await (gs as any).resolveRepoStrategy(dir);

        assert.strictEqual(
            resolved,
            "stream-only",
            "With no settings file, the cached strategy is used as a fallback"
        );
    });

    test("reconcile does not bulk-download when disk says stream-and-save despite stale cache", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-resolve-reconcile-"));
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

        await dugiteGit.add(dir, pointerRel);
        await dugiteGit.commit(dir, "add pointer", { name: "Tester", email: "tester@example.com" });
        await dugiteGit.addRemote(dir, "origin", "https://example.com/repo.git");

        // Disk = stream-and-save, but the persisted cache is the stale clone value.
        await writeStrategyToDisk(dir, "stream-and-save");
        const stateManager = makeStateManager();
        await stateManager.setRepoStrategy(dir, "auto-download");

        const { GitService } = require("../../../git/GitService");
        const gs = new GitService(stateManager);
        const originalGetRemoteUrl = gs.getRemoteUrl;
        (gs as any).getRemoteUrl = async () => "https://example.com/repo.git";

        const originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () =>
            new Response(JSON.stringify({ objects: [] }), { status: 200 });

        try {
            await (gs as any).reconcilePointersFilesystem(dir, { username: "oauth2", password: "x" });

            const filesAbs = path.join(dir, ".project/attachments/files/audio/stream.wav");
            let exists = true;
            try {
                await fs.promises.access(filesAbs);
            } catch {
                exists = false;
            }
            assert.strictEqual(
                exists,
                false,
                "No bulk download should happen when disk strategy is stream-and-save"
            );
        } finally {
            (gs as any).getRemoteUrl = originalGetRemoteUrl;
            (globalThis as any).fetch = originalFetch;
        }
    });
});

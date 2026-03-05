import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { GitService } from "../../../git/GitService";

suite("Git core actions", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-git-core-"));
    let repoDir: string;

    const stateStub: any = {
        isSyncLocked: () => false,
        acquireSyncLock: async () => true,
        releaseSyncLock: async () => {},
    };

    const service = new GitService(stateStub);

    suiteSetup(() => {
        dugiteGit.useEmbeddedGitBinary();
    });

    setup(async () => {
        repoDir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
    });

    teardown(async () => {
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    });

    test("init sets up repo; hasGitRepository true after first commit", async () => {
        await service.init(repoDir);
        // Before any commit, HEAD may not resolve to an OID
        assert.strictEqual(await service.hasGitRepository(repoDir), false);
        // Make initial commit
        const fp = path.join(repoDir, "init.txt");
        await fs.promises.writeFile(fp, "hello", "utf8");
        await dugiteGit.add(repoDir, "init.txt");
        await dugiteGit.commit(repoDir, "init", { name: "T", email: "t@example.com" });
        assert.strictEqual(await service.hasGitRepository(repoDir), true);
    });

    test("addRemote and getRemoteUrl return origin URL", async () => {
        await service.init(repoDir);
        const url = "https://example.com/sample.git";
        await service.addRemote(repoDir, "origin", url);
        const remoteUrl = await service.getRemoteUrl(repoDir);
        assert.strictEqual(remoteUrl, url);
    });

    test("addAll stages new and modified, remove handles deletions", async () => {
        await service.init(repoDir);
        // Create files
        const a = path.join(repoDir, "a.txt");
        const b = path.join(repoDir, "b.txt");
        await fs.promises.writeFile(a, "1", "utf8");
        await fs.promises.writeFile(b, "1", "utf8");
        // Stage both
        await service.addAll(repoDir);
        // Commit
        await dugiteGit.commit(repoDir, "add a,b", { name: "T", email: "t@example.com" });
        // Modify a and delete b
        await fs.promises.writeFile(a, "2", "utf8");
        await fs.promises.unlink(b);
        // addAll should stage modified and schedule deletion
        await service.addAll(repoDir);
        // Inspect index vs workdir using statusMatrix
        const status = await dugiteGit.statusMatrix(repoDir);
        // a.txt should have staged changes; b.txt should be removed
        const aEntry = status.find(([f]) => f === "a.txt");
        const bEntry = status.find(([f]) => f === "b.txt");
        assert.ok(aEntry, "a.txt should be tracked");
        assert.ok(bEntry, "b.txt should be tracked");
        // For b.txt, stage should indicate deletion (head=1, workdir=0)
        assert.strictEqual(bEntry?.[1], 1);
        assert.strictEqual(bEntry?.[2], 0);
    });

    test("push uses provided auth (no network)", async () => {
        await service.init(repoDir);
        const remote = "https://example.com/demo.git";
        await service.addRemote(repoDir, "origin", remote);
        // Prepare a commit so push is callable
        await fs.promises.writeFile(path.join(repoDir, "c.txt"), "x", "utf8");
        await dugiteGit.add(repoDir, "c.txt");
        await dugiteGit.commit(repoDir, "c", { name: "T", email: "t@example.com" });

        // Stub dugiteGit push to capture auth
        let authReceived = false;
        const origPush = (dugiteGit as any).push;
        (dugiteGit as any).push = async (_dir: string, auth: any) => {
            authReceived = auth?.username === "oauth2" && !!auth?.password;
        };

        try {
            await service.push(repoDir, { username: "oauth2", password: "token" });
            assert.strictEqual(
                authReceived,
                true,
                "Auth should be passed with provided credentials"
            );
        } finally {
            (dugiteGit as any).push = origPush;
        }
    });
});

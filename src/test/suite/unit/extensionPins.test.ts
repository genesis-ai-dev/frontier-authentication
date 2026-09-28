import { SCMManager } from "../../../scm/SCMManager";
import { EXTENSION_PIN_POLICY } from "../../../utils/extensionPinFeatureFlag";
import { checkMetadataVersionsForSync } from "../../../utils/extensionVersionChecker";
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { execFileSync } from "child_process";
import type { StateManager } from "../../../state";
import { clearProjectPins, clearConductorPinState } from "../../../utils/extensionPins";
import { GitService } from "../../../git/GitService";
import * as dugiteGit from "../../../git/dugiteGit";

suite("Temporary extension pin removal", () => {
    let directory: string;
    let originalCommands: typeof vscode.commands.getCommands;
    let originalExecute: typeof vscode.commands.executeCommand;
    const author = { name: "Test", email: "test@example.com" };
    const pinned = { projectName: "Keep", meta: {
        requiredExtensions: { codexEditor: "1.0.0" },
        pinnedExtensions: { ext: { version: "1.0.0", url: "https://example.invalid/ext.vsix" } }
    } };
    const read = () => JSON.parse(fs.readFileSync(path.join(directory, "metadata.json"), "utf8"));

    setup(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-pin-policy-"));
        originalCommands = vscode.commands.getCommands;
        originalExecute = vscode.commands.executeCommand;
        vscode.commands.getCommands = async () => ["codex.clearProjectExtensionPins"];
        // Simulate the editor command; Frontier must never write metadata itself.
        vscode.commands.executeCommand = async <T>(command: string, uri: string): Promise<T> => {
            assert.strictEqual(command, "codex.clearProjectExtensionPins");
            const file = path.join(vscode.Uri.parse(uri).fsPath, "metadata.json");
            const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
            if (JSON.stringify(metadata.meta?.pinnedExtensions) === "{}") { return false as T; }
            metadata.meta ??= {};
            metadata.meta.pinnedExtensions = {};
            fs.writeFileSync(file, JSON.stringify(metadata));
            return true as T;
        };
    });
    teardown(() => {
        EXTENSION_PIN_POLICY.ignoreProjectPins = true;
        vscode.commands.getCommands = originalCommands;
        vscode.commands.executeCommand = originalExecute;
        dugiteGit.useEmbeddedGitBinary();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test("project opening delegates to the editor's destination policy", async () => {
        const calls: [string, unknown[]][] = [];
        vscode.commands.getCommands = async () => ["codex.openProjectFolder"];
        vscode.commands.executeCommand = async <T>(command: string, ...args: unknown[]): Promise<T> => {
            calls.push([command, args]); return undefined as T;
        };
        const scm = Object.create(SCMManager.prototype) as { openWorkspace(folder: string): Promise<void> };
        await scm.openWorkspace(directory);
        assert.deepStrictEqual(calls, [["codex.openProjectFolder", [vscode.Uri.file(directory).toString()]]]);
        calls.length = 0;
        EXTENSION_PIN_POLICY.ignoreProjectPins = false;
        await scm.openWorkspace(directory);
        assert.deepStrictEqual(calls, [["vscode.openFolder", [vscode.Uri.file(directory)]]]);
    });

    test("project opening fails closed if editor opening support is unavailable", async () => {
        vscode.commands.getCommands = async () => [];
        vscode.commands.executeCommand = async () => { assert.fail("must not bypass editor"); };
        const scm = Object.create(SCMManager.prototype) as { openWorkspace(folder: string): Promise<void> };
        await assert.rejects(scm.openWorkspace(directory), /Update Codex Editor/);
    });

    test("remote pin validation never forwards pins while the policy is enabled", async () => {
        vscode.commands.executeCommand = async () => { assert.fail("must not signal Conductor"); };
        const scm = Object.create(SCMManager.prototype) as {
            handleRemotePinValidation(pins: unknown, manual: boolean): Promise<{ canSync: boolean; pinnedIds: Set<string> }>;
        };
        const result = await scm.handleRemotePinValidation(pinned.meta.pinnedExtensions, false);
        assert.strictEqual(result.canSync, true);
        assert.strictEqual(result.pinnedIds.size, 0);
    });

    test("disabled policy does not touch files, commands or Git", async () => {
        EXTENSION_PIN_POLICY.ignoreProjectPins = false;
        vscode.commands.getCommands = async () => { throw new Error("Unexpected command lookup"); };
        vscode.commands.executeCommand = async () => { throw new Error("Unexpected command"); };
        fs.writeFileSync(path.join(directory, "metadata.json"), "{broken");
        assert.strictEqual(await clearProjectPins(vscode.Uri.file(directory)), false);
        await clearConductorPinState();
        const service = Object.create(GitService.prototype) as GitService;
        await (service as any).commitPinRemoval(directory, author);
        assert.strictEqual(fs.readFileSync(path.join(directory, "metadata.json"), "utf8"), "{broken");
    });

    test("disabled policy honors satisfied Conductor pins before minimum requirements", async () => {
        EXTENSION_PIN_POLICY.ignoreProjectPins = false;
        const calls: string[] = [];
        vscode.commands.executeCommand = async <T>(command: string): Promise<T> => {
            calls.push(command);
            return (command === "codex.conductor.getPinMismatches" ? [] : pinned.meta.pinnedExtensions) as T;
        };
        assert.strictEqual(await checkMetadataVersionsForSync({} as vscode.ExtensionContext), true);
        assert.deepStrictEqual(calls, ["codex.conductor.getPinMismatches", "codex.conductor.getEffectivePinnedExtensions"]);
    });

    test("missing editor command blocks cleanup without changing the file", async () => {
        vscode.commands.getCommands = async () => [];
        const file = path.join(directory, "metadata.json");
        const text = JSON.stringify(pinned);
        fs.writeFileSync(file, text);
        await assert.rejects(clearProjectPins(vscode.Uri.file(directory)), /Codex Editor must be updated/);
        assert.strictEqual(fs.readFileSync(file, "utf8"), text);
    });

    test("delegates cleanup to the editor and accepts its no-change result", async () => {
        const file = path.join(directory, "metadata.json");
        fs.writeFileSync(file, JSON.stringify(pinned));
        const folder = vscode.Uri.file(directory);
        assert.strictEqual(await clearProjectPins(folder), true);
        assert.deepStrictEqual(read(), { ...pinned, meta: { ...pinned.meta, pinnedExtensions: {} } });
        const before = fs.statSync(file).mtimeMs;
        assert.strictEqual(await clearProjectPins(folder), false);
        assert.strictEqual(fs.statSync(file).mtimeMs, before);
    });

    test("missing metadata is skipped; malformed metadata fails without overwriting", async () => {
        assert.strictEqual(await clearProjectPins(vscode.Uri.file(directory)), false);
        const file = path.join(directory, "metadata.json");
        fs.writeFileSync(file, "{broken");
        await assert.rejects(clearProjectPins(vscode.Uri.file(directory)));
        assert.strictEqual(fs.readFileSync(file, "utf8"), "{broken");
    });

    test("editor writer failures propagate instead of falling back to a second writer", async () => {
        fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(pinned));
        vscode.commands.getCommands = async () => ["codex.clearProjectExtensionPins"];
        vscode.commands.executeCommand = async () => { throw new Error("save failed"); };
        await assert.rejects(clearProjectPins(vscode.Uri.file(directory)), /save failed/);
        assert.deepStrictEqual(read(), pinned);
    });

    test("clears both caches without signaling a fake sync; tolerates missing commands", async () => {
        const calls: string[] = [];
        vscode.commands.getCommands = async () => [
            "codex.conductor.setRemotePins", "codex.conductor.clearAdminPinIntent", "codex.conductor.setSyncCompletedAt"
        ];
        vscode.commands.executeCommand = async <T>(command: string, ...args: unknown[]): Promise<T> => {
            calls.push(command);
            if (command.endsWith("setRemotePins")) { assert.deepStrictEqual(args, [{}]); }
            return undefined as T;
        };
        await clearConductorPinState();
        assert.deepStrictEqual(calls, ["codex.conductor.setRemotePins", "codex.conductor.clearAdminPinIntent"]);
        vscode.commands.getCommands = async () => [];
        await clearConductorPinState();
        assert.strictEqual(calls.length, 2);
        vscode.commands.getCommands = async () => ["codex.conductor.clearAdminPinIntent"];
        vscode.commands.executeCommand = async () => { throw new Error("cache failed"); };
        await assert.rejects(clearConductorPinState(), /cache failed/);
    });

    test("pin removal from an incoming commit is committed, leaving a clean tree", async () => {
        dugiteGit.useEmbeddedGitBinary();
        await dugiteGit.init(directory);
        fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(pinned));
        await dugiteGit.add(directory, "metadata.json");
        await dugiteGit.commit(directory, "Incoming pins", author);
        const service = Object.create(GitService.prototype) as {
            commitPinRemoval(dir: string, author: { name: string; email: string }): Promise<void>;
        };
        await service.commitPinRemoval(directory, author);
        const committed = JSON.parse(Buffer.from(await dugiteGit.readBlobAtRef(directory, "HEAD", "metadata.json")).toString());
        assert.deepStrictEqual(committed.meta.pinnedExtensions, {});
        assert.deepStrictEqual(committed.meta.requiredExtensions, pinned.meta.requiredExtensions);
        assert.ok((await dugiteGit.statusMatrix(directory)).every(([, head, work, staged]) => head === work && work === staged));
        const head = await dugiteGit.resolveRef(directory, "HEAD");
        await service.commitPinRemoval(directory, author);
        assert.strictEqual(await dugiteGit.resolveRef(directory, "HEAD"), head);
    });

    test("commits pin removal already saved by another editor operation", async () => {
        dugiteGit.useEmbeddedGitBinary();
        await dugiteGit.init(directory);
        fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(pinned));
        await dugiteGit.add(directory, "metadata.json");
        await dugiteGit.commit(directory, "Incoming pins", author);
        await clearProjectPins(vscode.Uri.file(directory));
        const service = Object.create(GitService.prototype) as {
            commitPinRemoval(dir: string, author: { name: string; email: string }): Promise<void>;
        };
        await service.commitPinRemoval(directory, author);
        const committed = JSON.parse(Buffer.from(await dugiteGit.readBlobAtRef(directory, "HEAD", "metadata.json")).toString());
        assert.deepStrictEqual(committed.meta.pinnedExtensions, {});
        assert.ok((await dugiteGit.statusMatrix(directory)).every(([, head, work, staged]) => head === work && work === staged));
    });

    test("pin cleanup never includes unrelated staged files in its commit", async () => {
        dugiteGit.useEmbeddedGitBinary();
        await dugiteGit.init(directory);
        fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(pinned));
        await dugiteGit.add(directory, "metadata.json");
        await dugiteGit.commit(directory, "Incoming pins", author);
        const head = await dugiteGit.resolveRef(directory, "HEAD");
        fs.writeFileSync(path.join(directory, "notes.txt"), "keep staged");
        await dugiteGit.add(directory, "notes.txt");
        const service = Object.create(GitService.prototype) as {
            commitPinRemoval(dir: string, author: { name: string; email: string }): Promise<void>;
        };
        await assert.rejects(service.commitPinRemoval(directory, author), /unrelated files/);
        assert.strictEqual(await dugiteGit.resolveRef(directory, "HEAD"), head);
        assert.strictEqual(fs.readFileSync(path.join(directory, "notes.txt"), "utf8"), "keep staged");
    });
    test("sync removes remote pins after fast-forward and conflict resolution", async () => {
        const binary = path.join(path.dirname(require.resolve("dugite/package.json")), "git");
        dugiteGit.setGitBinaryPath(binary, path.join(binary, "libexec", "git-core"));
        dugiteGit.setAskpassPath(path.join(directory, "askpass.js"));
        const remote = path.join(directory, "remote.git");
        const seed = path.join(directory, "seed");
        const local = path.join(directory, "local");
        const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        git(directory, "init", "--bare", remote);
        git(directory, "init", "-b", "main", seed);
        git(seed, "config", "user.name", author.name);
        git(seed, "config", "user.email", author.email);
        fs.writeFileSync(path.join(seed, "metadata.json"), JSON.stringify({ ...pinned, meta: { ...pinned.meta, pinnedExtensions: {} } }));
        git(seed, "add", ".");
        git(seed, "commit", "-m", "Unpinned base");
        git(seed, "remote", "add", "origin", remote);
        git(seed, "push", "-u", "origin", "main");
        git(directory, "clone", "-b", "main", remote, local);
        fs.writeFileSync(path.join(seed, "metadata.json"), JSON.stringify(pinned));
        git(seed, "commit", "-am", "Remote adds pins");
        git(seed, "push");
        const state = {
            isSyncLocked: () => false,
            acquireSyncLock: async () => true,
            releaseSyncLock: async () => {},
            updateLockHeartbeat: async () => {},
        } as unknown as StateManager;
        const service = new GitService(state);
        service.isOnline = async () => true;
        (service as unknown as { reconcilePointersFilesystem(): Promise<void> }).reconcilePointersFilesystem = async () => {};
        const result = await service.syncChanges(local, { username: "", password: "" }, author);
        assert.strictEqual(result.hadConflicts, false);
        assert.deepStrictEqual(JSON.parse(git(local, "show", "HEAD:metadata.json")).meta.pinnedExtensions, {});
        assert.deepStrictEqual(JSON.parse(git(directory, "--git-dir", remote, "show", "main:metadata.json")).meta.pinnedExtensions, {});
        assert.strictEqual(git(local, "status", "--porcelain").trim(), "");
        const head = git(local, "rev-parse", "HEAD");
        await service.syncChanges(local, { username: "", password: "" }, author);
        assert.strictEqual(git(local, "rev-parse", "HEAD"), head, "repeat startup sync must not create another cleanup commit");

        // Divergent history: the resolver may hand back metadata that contains pins.
        git(seed, "pull", "--ff-only");
        fs.writeFileSync(path.join(seed, "metadata.json"), JSON.stringify(pinned));
        git(seed, "commit", "-am", "Remote reintroduces pins");
        git(seed, "push");
        const localMetadata = JSON.parse(fs.readFileSync(path.join(local, "metadata.json"), "utf8"));
        localMetadata.projectName = "Local edit";
        fs.writeFileSync(path.join(local, "metadata.json"), JSON.stringify(localMetadata));
        await dugiteGit.add(local, "metadata.json");
        await dugiteGit.commit(local, "Local metadata edit", author);
        const divergent = await service.syncChanges(local, { username: "", password: "" }, author);
        assert.strictEqual(divergent.hadConflicts, true);
        assert.ok(divergent.mergeSnapshot);
        fs.writeFileSync(path.join(local, "metadata.json"), JSON.stringify({ ...pinned, projectName: "Local edit" }));
        await service.completeMerge(local, { username: "", password: "" }, author,
            [{ filepath: "metadata.json", resolution: "modified" }], divergent.mergeSnapshot);
        const merged = JSON.parse(git(directory, "--git-dir", remote, "show", "main:metadata.json"));
        assert.deepStrictEqual(merged.meta.pinnedExtensions, {});
        assert.strictEqual(merged.projectName, "Local edit");
        assert.strictEqual(git(local, "status", "--porcelain").trim(), "");

    });

});

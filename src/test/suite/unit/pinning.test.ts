import * as assert from "assert";
import * as vscode from "vscode";
import {
    compareVersions,
    findPinMismatches,
    checkPinnedExtensionsForSync,
    PinnedExtensions,
} from "../../../utils/extensionVersionChecker";

suite("Integration: Pinning Logic", () => {
    const originalShowInfo = vscode.window.showInformationMessage;
    const originalExecute = vscode.commands.executeCommand;
    const originalGetExtension = vscode.extensions.getExtension;

    let stubbedExtensions: Record<string, any> = {};

    setup(() => {
        stubbedExtensions = {
            "project-accelerate.codex-editor-extension": {
                packageJSON: { version: "0.24.0" }
            },
            "frontier-rnd.frontier-authentication": {
                packageJSON: { version: "0.4.20" }
            }
        };

        (vscode.extensions.getExtension as any) = (id: string) => stubbedExtensions[id];
    });

    teardown(() => {
        (vscode.window.showInformationMessage as any) = originalShowInfo;
        (vscode.commands.executeCommand as any) = originalExecute;
        (vscode.extensions.getExtension as any) = originalGetExtension;
    });

    test("findPinMismatches detects mismatched versions", () => {
        const pins: PinnedExtensions = {
            "project-accelerate.codex-editor-extension": { version: "0.24.1", url: "http://example.com/vsix" },
            "frontier-rnd.frontier-authentication": { version: "0.4.20", url: "http://example.com/vsix" }
        };

        const mismatches = findPinMismatches(pins);
        assert.strictEqual(mismatches.length, 1);
        assert.strictEqual(mismatches[0].extensionId, "project-accelerate.codex-editor-extension");
        assert.strictEqual(mismatches[0].pinnedVersion, "0.24.1");
        assert.strictEqual(mismatches[0].runningVersion, "0.24.0");
    });

    test("findPinMismatches returns empty when all match", () => {
        const pins: PinnedExtensions = {
            "project-accelerate.codex-editor-extension": { version: "0.24.0", url: "http://example.com/vsix" },
            "frontier-rnd.frontier-authentication": { version: "0.4.20", url: "http://example.com/vsix" }
        };

        const mismatches = findPinMismatches(pins);
        assert.strictEqual(mismatches.length, 0);
    });

    test("findPinMismatches requires exact string equality for pin versions", () => {
        const pins: PinnedExtensions = {
            "project-accelerate.codex-editor-extension": {
                version: "0.24.0-pr123",
                url: "http://example.com/vsix"
            }
        };

        const mismatches = findPinMismatches(pins);
        assert.strictEqual(mismatches.length, 1);
        assert.strictEqual(mismatches[0].runningVersion, "0.24.0");
        assert.strictEqual(mismatches[0].pinnedVersion, "0.24.0-pr123");
    });

    test("compareVersions ignores prerelease affixes for required version checks", () => {
        assert.strictEqual(compareVersions("0.24.1", "0.24.1-pr123"), 0);
        assert.strictEqual(compareVersions("0.24.1-pr122", "0.24.1-pr123"), 0);
        assert.strictEqual(compareVersions("0.24.2-pr1", "0.24.1"), 1);
        assert.strictEqual(compareVersions("0.24.1-pr5-abc1234", "0.24.1"), 0);
        assert.strictEqual(compareVersions("0.24.1-pr5-abc1234", "0.24.2"), -1);
    });

    test("checkPinnedExtensionsForSync shows info notification and blocks sync", async () => {
        const pins: PinnedExtensions = {
            "project-accelerate.codex-editor-extension": { version: "0.24.1", url: "http://example.com/vsix" }
        };

        let shownMessage: string | undefined;
        (vscode.window.showInformationMessage as any) = async (msg: string, ...actions: string[]) => {
            shownMessage = msg;
            return undefined;
        };

        const result = await checkPinnedExtensionsForSync({ workspaceState: { get: () => 0 } } as any, true, pins);

        assert.strictEqual(result.canSync, false);
        assert.ok(shownMessage?.includes("Extension version pin detected"));
        assert.ok(shownMessage?.includes("Codex Editor"));
        assert.ok(shownMessage?.includes("pinned to v0.24.1"));
    });

    test("checkPinnedExtensionsForSync does not reload — Conductor owns reload UX", async () => {
        const pins: PinnedExtensions = {
            "project-accelerate.codex-editor-extension": { version: "0.24.1", url: "http://example.com/vsix" }
        };

        let reloaded = false;
        (vscode.window.showInformationMessage as any) = async (msg: string, ...actions: string[]) => {
            return undefined; // no reload button to click
        };
        (vscode.commands.executeCommand as any) = async (cmd: string) => {
            if (cmd === "workbench.action.reloadWindow") { reloaded = true; }
            return undefined;
        };

        const result = await checkPinnedExtensionsForSync({ workspaceState: { get: () => 0 } } as any, true, pins);

        assert.strictEqual(result.canSync, false);
        assert.strictEqual(reloaded, false);
    });
});

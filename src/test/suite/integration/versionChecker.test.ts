import * as assert from "assert";
import * as vscode from "vscode";
import {
    checkAndUpdateMetadataVersions,
    checkMetadataVersionsForSync,
    handleOutdatedExtensionsForSync,
    buildOutdatedExtensionsMessage,
    ExtensionVersionInfo,
    checkRequiredVersion,
} from "../../../utils/extensionVersionChecker";

suite("Integration: extensionVersionChecker", () => {
    const originalShowWarning = vscode.window.showWarningMessage;
    const originalShowInfo = vscode.window.showInformationMessage;
    const originalExecute = vscode.commands.executeCommand;

    setup(() => {
        // no-op
    });

    teardown(() => {
        // restore stubs after each test
        (vscode.window.showWarningMessage as any) = originalShowWarning;
        (vscode.window.showInformationMessage as any) = originalShowInfo;
        (vscode.commands.executeCommand as any) = originalExecute;
    });

    test("single outdated extension shows minimal modal and opens extensions view", async () => {
        const outdated: ExtensionVersionInfo[] = [
            {
                extensionId: "frontier-rnd.frontier-authentication",
                currentVersion: "0.4.15",
                latestVersion: "0.4.16",
                isOutdated: true,
                downloadUrl: "",
                displayName: "Frontier Authentication",
            },
        ];

        let shownMessage: string | undefined;
        let openedExtensions = false;

        (vscode.window.showWarningMessage as any) = async (msg: string) => {
            shownMessage = msg;
            return "Update Extensions"; // simulate user clicking
        };
        (vscode.commands.executeCommand as any) = async (cmd: string) => {
            if (cmd === "workbench.view.extensions") { openedExtensions = true; }
            return undefined;
        };

        await handleOutdatedExtensionsForSync({} as any, outdated, true);

        const expected = buildOutdatedExtensionsMessage(outdated);
        assert.strictEqual(shownMessage, expected);
        assert.strictEqual(openedExtensions, true);
    });

    test("both outdated show minimal plural modal", async () => {
        const outdated: ExtensionVersionInfo[] = [
            {
                extensionId: "project-accelerate.codex-editor-extension",
                currentVersion: "0.6.20",
                latestVersion: "0.6.21",
                isOutdated: true,
                downloadUrl: "",
                displayName: "Codex Editor",
            },
            {
                extensionId: "frontier-rnd.frontier-authentication",
                currentVersion: "0.4.15",
                latestVersion: "0.4.16",
                isOutdated: true,
                downloadUrl: "",
                displayName: "Frontier Authentication",
            },
        ];

        let shownMessage: string | undefined;
        (vscode.window.showWarningMessage as any) = async (msg: string) => {
            shownMessage = msg;
            return undefined; // user dismisses
        };

        await handleOutdatedExtensionsForSync({} as any, outdated, true);
        const expected = buildOutdatedExtensionsMessage(outdated);
        assert.strictEqual(shownMessage, expected);
    });

    test("malformed required version fails open without showing a toast", () => {
        let shownMessage: string | undefined;
        (vscode.window.showWarningMessage as any) = async (msg: string) => {
            shownMessage = msg;
            return undefined;
        };

        const result = checkRequiredVersion(
            "0.24.1-pr123",
            "not-a-version",
            "Codex Editor"
        );

        assert.deepStrictEqual(result, { kind: "invalid_required" });
        assert.strictEqual(shownMessage, undefined);
    });

    test("valid required version with missing installed version fails closed", () => {
        const result = checkRequiredVersion(
            null,
            "0.24.1",
            "Codex Editor"
        );

        assert.deepStrictEqual(result, { kind: "unknown_current" });
    });
});



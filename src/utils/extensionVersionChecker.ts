import * as vscode from "vscode";

/**
 * Extension version checker for frontier-authentication.
 * 
 * DESIGN: This extension delegates all metadata.json writes to codex-editor
 * via commands. This implements the "single writer" principle to prevent
 * conflicts and the issues that were causing metadata.json to be deleted.
 */

// Compare only the numeric x.y.z core. Affixes like -pr123 or -pr123-shorthash are ignored.
export function compareVersions(a: string, b: string): number {
    const pa = extractCoreVersionParts(a);
    const pb = extractCoreVersionParts(b);

    if (!pa || !pb) {
        throw new Error(`Invalid version core: a=${a}, b=${b}`);
    }

    for (let i = 0; i < 3; i++) {
        const ai = pa[i];
        const bi = pb[i];
        if (ai > bi) { return 1; }
        if (ai < bi) { return -1; }
    }
    return 0;
}

/**
 * Parses out the x.y.z core of a version string.
 */
/**
 * Compare a running extension version against a required version from metadata.json's
 * `requiredExtensions`. Both are reduced to their x.y.z numeric core — affixes like
 * `-pr123` or `-pr123-shorthash` are stripped — so `0.24.1-pr123` == `0.24.1`.
 *
 * Returns a discriminated union:
 *
 *   "ok"               — both parsed; `comparison` is -1 / 0 / 1 (current vs required).
 *                        -1 means outdated → block sync.
 *
 *   "invalid_required" — requiredVersion couldn't be parsed as x.y.z; fail-open
 *                        (allow sync, log warning, no toast). Scenario 10.
 *
 *   "unknown_current"  — requiredVersion is valid but currentVersion is null or
 *                        unparseable; fail-closed (block sync). Scenario 11.
 */
export type RequiredVersionCheckResult =
    | { kind: "ok"; comparison: -1 | 0 | 1 }
    | { kind: "invalid_required" }
    | { kind: "unknown_current" };

export function checkRequiredVersion(
    currentVersion: string | null,
    requiredVersion: string,
    extensionName: string
): RequiredVersionCheckResult {
    const requiredCore = extractCoreVersionParts(requiredVersion);
    if (!requiredCore) {
        console.warn(
            `[MetadataVersionChecker] Invalid required version for ${extensionName}: ${requiredVersion}. Expected x.y.z. Allowing sync.`
        );
        return { kind: "invalid_required" };
    }

    if (!currentVersion) {
        console.error(
            `[MetadataVersionChecker] Missing installed version for ${extensionName} while required version ${requiredVersion} is set. Blocking sync.`
        );
        return { kind: "unknown_current" };
    }

    const currentCore = extractCoreVersionParts(currentVersion);
    if (!currentCore) {
        console.error(
            `[MetadataVersionChecker] Unparseable installed version for ${extensionName}: ${currentVersion}. Blocking sync.`
        );
        return { kind: "unknown_current" };
    }

    for (let i = 0; i < 3; i++) {
        if (currentCore[i] > requiredCore[i]) { return { kind: "ok", comparison: 1 }; }
        if (currentCore[i] < requiredCore[i]) { return { kind: "ok", comparison: -1 }; }
    }

    return { kind: "ok", comparison: 0 };
}

function extractCoreVersionParts(version: string): [number, number, number] | null {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i);
    if (!match) {
        return null;
    }

    return [
        parseInt(match[1], 10),
        parseInt(match[2], 10),
        parseInt(match[3], 10),
    ];
}

const DEBUG_MODE = false;
const debug = (message: string) => {
    if (DEBUG_MODE) {
        console.log(`[ExtensionVersionChecker] ${message}`);
    }
};

export interface ExtensionVersionInfo {
    extensionId: string;
    currentVersion: string;
    latestVersion: string;
    isOutdated: boolean;
    downloadUrl: string;
    displayName: string;
}

const VERSION_MODAL_COOLDOWN_KEY = "codex-editor.versionModalLastShown";
const VERSION_MODAL_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

function getCurrentExtensionVersion(extensionId: string): string | null {
    const extension = vscode.extensions.getExtension(extensionId);
    return (extension as any)?.packageJSON?.version || null;
}

export function getInstalledExtensionVersions(): {
    codexEditorVersion: string | null;
    frontierAuthVersion: string | null;
} {
    const codexEditorVersion = getCurrentExtensionVersion(
        "project-accelerate.codex-editor-extension"
    );
    const frontierAuthVersion = getCurrentExtensionVersion(
        "frontier-rnd.frontier-authentication"
    );
    return { codexEditorVersion, frontierAuthVersion };
}

interface MetadataVersionCheckResult {
    canSync: boolean;
    metadataUpdated: boolean;
    reason?: string;
    needsUserAction?: boolean;
    outdatedExtensions?: ExtensionVersionInfo[];
}

/**
 * Read extension versions from metadata.json via codex-editor command
 */
async function getExtensionVersionsViaCommand(): Promise<{
    success: boolean;
    versions?: { codexEditor?: string; frontierAuthentication?: string };
    error?: string;
}> {
    try {
        // Check if codex-editor is available
        const codexExtension = vscode.extensions.getExtension("project-accelerate.codex-editor-extension");
        if (!codexExtension) {
            return { success: false, error: "Codex Editor extension not available" };
        }

        // Ensure it's activated
        if (!codexExtension.isActive) {
            await codexExtension.activate();
        }

        // Call the command
        const result = await vscode.commands.executeCommand<{
            success: boolean;
            versions?: { codexEditor?: string; frontierAuthentication?: string };
            error?: string;
        }>("codex-editor.getMetadataExtensionVersions");

        return result || { success: false, error: "No response from command" };
    } catch (error) {
        return { success: false, error: `Command failed: ${(error as Error).message}` };
    }
}

/**
 * Update extension versions in metadata.json via codex-editor command
 */
async function updateExtensionVersionsViaCommand(
    versions: { codexEditor?: string; frontierAuthentication?: string }
): Promise<{ success: boolean; error?: string }> {
    try {
        // Check if codex-editor is available
        const codexExtension = vscode.extensions.getExtension("project-accelerate.codex-editor-extension");
        if (!codexExtension) {
            return { success: false, error: "Codex Editor extension not available" };
        }

        // Ensure it's activated
        if (!codexExtension.isActive) {
            await codexExtension.activate();
        }

        // Call the command
        const result = await vscode.commands.executeCommand<{ success: boolean; error?: string }>(
            "codex-editor.updateMetadataExtensionVersions",
            versions
        );

        return result || { success: false, error: "No response from command" };
    } catch (error) {
        return { success: false, error: `Command failed: ${(error as Error).message}` };
    }
}

export async function checkAndUpdateMetadataVersions(): Promise<MetadataVersionCheckResult> {
    try {
        debug("[MetadataVersionChecker] ═══ METADATA VERSION CHECK ═══");

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            console.warn("[MetadataVersionChecker] ❌ No workspace folder found");
            return { canSync: false, metadataUpdated: false, reason: "No workspace folder" };
        }

        const codexEditorVersion = getCurrentExtensionVersion("project-accelerate.codex-editor-extension");
        const frontierAuthVersion = getCurrentExtensionVersion("frontier-rnd.frontier-authentication");

        debug("[MetadataVersionChecker] 📦 Current versions:");
        debug(`  - Codex Editor: ${codexEditorVersion || "not found"}`);
        debug(`  - Frontier Authentication: ${frontierAuthVersion || "not found"}`);

        if (!codexEditorVersion || !frontierAuthVersion) {
            const missingExtensions: string[] = [];
            if (!codexEditorVersion) missingExtensions.push("Codex Editor");
            if (!frontierAuthVersion) missingExtensions.push("Frontier Authentication");

            console.error(
                `[MetadataVersionChecker] ❌ Missing required extensions: ${missingExtensions.join(", ")}`
            );
            return {
                canSync: false,
                metadataUpdated: false,
                reason: `Missing required extensions: ${missingExtensions.join(", ")}`,
                needsUserAction: true,
            };
        }

        // Read current versions via codex-editor command
        const currentVersionsResult = await getExtensionVersionsViaCommand();
        if (!currentVersionsResult.success) {
            console.warn("[MetadataVersionChecker] ❌ Could not read metadata.json:", currentVersionsResult.error);
            return { canSync: false, metadataUpdated: false, reason: "Could not read metadata file" };
        }

        const currentVersions = currentVersionsResult.versions || {};
        const metadataCodexVersion = currentVersions.codexEditor;
        const metadataFrontierVersion = currentVersions.frontierAuthentication;

        debug("[MetadataVersionChecker] 📋 Metadata requires:");
        debug(`  - Codex Editor: ${metadataCodexVersion || "not set"}`);
        debug(`  - Frontier Authentication: ${metadataFrontierVersion || "not set"}`);

        let needsUpdate = false;
        const outdatedExtensions: ExtensionVersionInfo[] = [];
        const versionsToUpdate: { codexEditor?: string; frontierAuthentication?: string } = {};

        // Check if versions need updating
        if (!metadataCodexVersion || !metadataFrontierVersion) {
            debug("[MetadataVersionChecker] ➕ Adding missing extension version requirements to metadata");
            needsUpdate = true;
            if (!metadataCodexVersion) versionsToUpdate.codexEditor = codexEditorVersion;
            if (!metadataFrontierVersion) versionsToUpdate.frontierAuthentication = frontierAuthVersion;
        }

        if (metadataCodexVersion) {
            const codexCheck = checkRequiredVersion(
                codexEditorVersion,
                metadataCodexVersion,
                "Codex Editor"
            );
            if (codexCheck.kind === "unknown_current") {
                return {
                    canSync: false,
                    metadataUpdated: false,
                    reason: `Could not determine installed version for Codex Editor`,
                    needsUserAction: true,
                };
            }

            if (codexCheck.kind === "ok" && codexCheck.comparison < 0) {
                console.warn(
                    `[MetadataVersionChecker] ⚠️  Codex Editor outdated: ${codexEditorVersion} < ${metadataCodexVersion}`
                );
                outdatedExtensions.push({
                    extensionId: "project-accelerate.codex-editor-extension",
                    currentVersion: codexEditorVersion,
                    latestVersion: metadataCodexVersion,
                    isOutdated: true,
                    downloadUrl: "",
                    displayName: "Codex Editor",
                });
            } else if (codexCheck.kind === "ok" && codexCheck.comparison > 0) {
                debug(
                    `[MetadataVersionChecker] 🚀 Updating Codex Editor version: ${metadataCodexVersion} → ${codexEditorVersion}`
                );
                versionsToUpdate.codexEditor = codexEditorVersion;
                needsUpdate = true;
            }
        }

        if (metadataFrontierVersion) {
            const frontierCheck = checkRequiredVersion(
                frontierAuthVersion,
                metadataFrontierVersion,
                "Frontier Authentication"
            );
            if (frontierCheck.kind === "unknown_current") {
                return {
                    canSync: false,
                    metadataUpdated: false,
                    reason: `Could not determine installed version for Frontier Authentication`,
                    needsUserAction: true,
                };
            }

            if (frontierCheck.kind === "ok" && frontierCheck.comparison < 0) {
                console.warn(
                    `[MetadataVersionChecker] ⚠️  Frontier Authentication outdated: ${frontierAuthVersion} < ${metadataFrontierVersion}`
                );
                outdatedExtensions.push({
                    extensionId: "frontier-rnd.frontier-authentication",
                    currentVersion: frontierAuthVersion,
                    latestVersion: metadataFrontierVersion,
                    isOutdated: true,
                    downloadUrl: "",
                    displayName: "Frontier Authentication",
                });
            } else if (frontierCheck.kind === "ok" && frontierCheck.comparison > 0) {
                debug(
                    `[MetadataVersionChecker] 🚀 Updating Frontier Authentication version: ${metadataFrontierVersion} → ${frontierAuthVersion}`
                );
                versionsToUpdate.frontierAuthentication = frontierAuthVersion;
                needsUpdate = true;
            }
        }

        // Update metadata via codex-editor command if needed
        if (needsUpdate) {
            const updateResult = await updateExtensionVersionsViaCommand(versionsToUpdate);
            if (!updateResult.success) {
                console.error("[MetadataVersionChecker] ❌ Failed to update metadata:", updateResult.error);
                return {
                    canSync: false,
                    metadataUpdated: false,
                    reason: `Failed to update metadata: ${updateResult.error}`,
                };
            }
            debug("[MetadataVersionChecker] 💾 Metadata updated with latest extension versions");
        }

        const canSync = outdatedExtensions.length === 0;
        if (!canSync) {
            console.warn(
                `[MetadataVersionChecker] 🚫 Sync blocked due to ${outdatedExtensions.length} outdated extension(s)`
            );
            return {
                canSync: false,
                metadataUpdated: needsUpdate,
                reason: `Extensions need updating: ${outdatedExtensions
                    .map((ext) => `${ext.displayName} (${ext.currentVersion} → ${ext.latestVersion})`)
                    .join(", ")}`,
                needsUserAction: true,
                outdatedExtensions,
            };
        }

        debug("[MetadataVersionChecker] ✅ All extension versions compatible with metadata");
        return { canSync: true, metadataUpdated: needsUpdate };
    } catch (error) {
        console.error("[MetadataVersionChecker] ❌ Error during metadata version check:", error);
        return {
            canSync: false,
            metadataUpdated: false,
            reason: `Version check failed: ${(error as Error).message}`,
        };
    } finally {
        debug("[MetadataVersionChecker] ═══ END METADATA VERSION CHECK ═══\n");
    }
}

function shouldShowVersionModal(context: vscode.ExtensionContext, isManualSync: boolean): boolean {
    if (isManualSync) {
        debug("[VersionModalCooldown] Manual sync - showing modal");
        return true;
    }

    const lastShown = context.workspaceState.get<number>(VERSION_MODAL_COOLDOWN_KEY, 0);
    const now = Date.now();
    const timeSinceLastShown = now - lastShown;

    if (timeSinceLastShown >= VERSION_MODAL_COOLDOWN_MS) {
        debug(
            `[VersionModalCooldown] Auto-sync - cooldown expired (${Math.round(timeSinceLastShown / 1000 / 60)} minutes ago), showing modal`
        );
        return true;
    } else {
        const remainingMs = VERSION_MODAL_COOLDOWN_MS - timeSinceLastShown;
        const remainingMinutes = Math.round(remainingMs / 1000 / 60);
        debug(
            `[VersionModalCooldown] Auto-sync - in cooldown period, ${remainingMinutes} minutes remaining`
        );
        return false;
    }
}

async function updateVersionModalTimestamp(context: vscode.ExtensionContext): Promise<void> {
    await context.workspaceState.update(VERSION_MODAL_COOLDOWN_KEY, Date.now());
    debug("[VersionModalCooldown] Updated last shown timestamp");
}

export async function resetVersionModalCooldown(context: vscode.ExtensionContext): Promise<void> {
    await context.workspaceState.update(VERSION_MODAL_COOLDOWN_KEY, 0);
    debug("[VersionModalCooldown] Reset cooldown timestamp on extension activation");
}

export function buildOutdatedExtensionsMessage(outdatedExtensions: ExtensionVersionInfo[]): string {
    const names = outdatedExtensions.map((e) => e.displayName);

    const formatNames = (arr: string[]): string => {
        if (arr.length <= 1) return arr[0] || "";
        if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
        return `${arr.slice(0, -1).join(", ")}, and ${arr[arr.length - 1]}`;
    };

    if (names.length === 0) return "To sync, update:"; // safety fallback
    const bullets = names.map((n) => `- ${n}`).join("\n");
    return `To sync, update:\n${bullets}`;
}

async function showMetadataVersionMismatchNotification(
    context: vscode.ExtensionContext,
    outdatedExtensions: ExtensionVersionInfo[]
): Promise<boolean> {
    const message = buildOutdatedExtensionsMessage(outdatedExtensions);

    const actions = ["Update Extensions"];

    try {
        const selection = await vscode.window.showWarningMessage(message, { modal: true }, ...actions);

        switch (selection) {
            case "Update Extensions":
                await vscode.commands.executeCommand("workbench.view.extensions");
                for (const ext of outdatedExtensions) {
                    vscode.window
                        .showInformationMessage(
                            `Update ${ext.displayName} from v${ext.currentVersion} to v${ext.latestVersion}`,
                            "Search in Extensions"
                        )
                        .then((choice) => {
                            if (choice === "Search in Extensions") {
                                vscode.commands.executeCommand(
                                    "workbench.extensions.search",
                                    ext.extensionId
                                );
                            }
                        });
                }

                await updateVersionModalTimestamp(context);
                return false;

            default:
                return false;
        }
    } catch (error) {
        console.error("[MetadataVersionChecker] Error showing notification:", error);
        return false;
    }
}

export async function handleOutdatedExtensionsForSync(
    context: vscode.ExtensionContext,
    outdatedExtensions: ExtensionVersionInfo[],
    isManualSync: boolean
): Promise<boolean> {
    const shouldShow = shouldShowVersionModal(context, isManualSync);
    if (shouldShow) {
        return await showMetadataVersionMismatchNotification(context, outdatedExtensions);
    } else {
        debug(
            "[MetadataVersionChecker] Auto-sync blocked due to outdated extensions (in cooldown period)"
        );
        return false;
    }
}

export async function checkMetadataVersionsForSync(
    context: vscode.ExtensionContext,
    isManualSync: boolean = false
): Promise<boolean> {
    const result = await checkAndUpdateMetadataVersions();

    if (result.canSync) {
        return true;
    }

    if (result.needsUserAction && result.outdatedExtensions) {
        const shouldShow = shouldShowVersionModal(context, isManualSync);

        if (shouldShow) {
            return await showMetadataVersionMismatchNotification(context, result.outdatedExtensions);
        } else {
            debug(
                "[MetadataVersionChecker] Auto-sync blocked due to outdated extensions (in cooldown period)"
            );
            return false;
        }
    }

    console.warn("[MetadataVersionChecker] Sync not allowed:", result.reason);
    return false;
}

export function registerVersionCheckCommands(context: vscode.ExtensionContext): void {
    // Generic check command that other extensions (e.g., Codex) can call
    vscode.commands.registerCommand(
        "frontier.checkMetadataVersionsForSync",
        async (options?: { isManualSync?: boolean }): Promise<boolean> => {
            const isManual = !!options?.isManualSync;
            try {
                const allowed = await checkMetadataVersionsForSync(context, isManual);
                return !!allowed;
            } catch (err) {
                console.error("[VersionCheck] Error while checking metadata versions:", err);
                return false;
            }
        }
    );

    // Lightweight command to check remote metadata.json for requiredExtensions
    vscode.commands.registerCommand(
        "frontier.checkRemoteMetadataVersionMismatch",
        async (): Promise<boolean> => {
            try {
                const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspacePath) return true;

                // Mimic the remote metadata fetch/check
                const { getInstalledExtensionVersions } = await import("./extensionVersionChecker");
                const { compareVersions } = await import("./extensionVersionChecker");

                // Fetch remote refs and read remote metadata.json (best effort)
                try {
                    const git = await import("isomorphic-git");
                    const fs = (await import("fs")).promises as any;
                    const http = (await import("isomorphic-git/http/node")).default;
                    await git.fetch({ fs, http, dir: workspacePath } as any);
                } catch {}

                let mismatch = false;
                try {
                    const git = await import("isomorphic-git");
                    const fs = (await import("fs")).promises as any;
                    const currentBranch = await git.currentBranch({ fs, dir: workspacePath });
                    if (currentBranch) {
                        const remoteRef = `refs/remotes/origin/${currentBranch}`;
                        let remoteHead: string | undefined;
                        try { remoteHead = await git.resolveRef({ fs, dir: workspacePath, ref: remoteRef }); } catch {}
                        if (remoteHead) {
                            try {
                                const result = await git.readBlob({ fs, dir: workspacePath, oid: remoteHead, filepath: "metadata.json" });
                                const text = new TextDecoder().decode(result.blob);
                                const remoteMetadata = JSON.parse(text) as { meta?: { requiredExtensions?: { codexEditor?: string; frontierAuthentication?: string } } };
                                const required = remoteMetadata.meta?.requiredExtensions;
                                if (required) {
                                    const { codexEditorVersion, frontierAuthVersion } = getInstalledExtensionVersions();
                                    if (required.codexEditor && codexEditorVersion && compareVersions(codexEditorVersion, required.codexEditor) < 0) mismatch = true;
                                    if (required.frontierAuthentication && frontierAuthVersion && compareVersions(frontierAuthVersion, required.frontierAuthentication) < 0) mismatch = true;
                                }
                            } catch {}
                        }
                    }
                } catch {}

                return mismatch;
            } catch (err) {
                console.warn("checkRemoteMetadataVersionMismatch failed:", err);
                return true; // fail closed
            }
        }
    );
}

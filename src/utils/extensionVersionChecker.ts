import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Extension version checker for frontier-authentication.
 * 
 * DESIGN: This extension delegates all metadata.json writes to codex-editor
 * via commands. This implements the "single writer" principle to prevent
 * conflicts and the issues that were causing metadata.json to be deleted.
 * Reads, however, can safely go directly to disk.
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
    return (extension?.packageJSON as { version: string } | undefined)?.version || null;
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
 * Read extension versions from metadata.json.
 * Prefers the codex-editor command (which goes through the write-queue-aware
 * MetadataManager), but falls back to a direct disk read when codex-editor
 * isn't active yet (common during startup). Reads are always safe — the
 * "single writer" principle only governs writes.
 */
async function getExtensionVersionsViaCommand(): Promise<{
    success: boolean;
    versions?: { codexEditor?: string; frontierAuthentication?: string };
    error?: string;
}> {
    // Try via codex-editor command first (write-queue-aware, most reliable)
    const commandResult = await tryReadViaCommand();
    if (commandResult.success) {
        return commandResult;
    }

    // Fallback: read metadata.json directly from disk
    debug(`[getExtensionVersions] Command unavailable (${commandResult.error}), reading metadata.json directly`);
    return readVersionsFromDisk();
}

async function tryReadViaCommand(): Promise<{
    success: boolean;
    versions?: { codexEditor?: string; frontierAuthentication?: string };
    error?: string;
}> {
    try {
        const codexExtension = vscode.extensions.getExtension("project-accelerate.codex-editor-extension");
        if (!codexExtension) {
            return { success: false, error: "Codex Editor extension not available" };
        }

        // Never force-activate codex-editor here: this function is called from
        // the version-check command that codex-editor itself may await during its
        // own activation, which would create a circular-wait deadlock.
        if (!codexExtension.isActive) {
            return { success: false, error: "Codex Editor extension not yet active" };
        }

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

async function readVersionsFromDisk(): Promise<{
    success: boolean;
    versions?: { codexEditor?: string; frontierAuthentication?: string };
    error?: string;
}> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return { success: false, error: "No workspace folder open" };
        }

        const metadataPath = path.join(workspaceFolder.uri.fsPath, "metadata.json");
        const content = await fs.promises.readFile(metadataPath, "utf8");
        const text = content.trim();

        if (!text) {
            return { success: false, error: "metadata.json is empty" };
        }

        const metadata = JSON.parse(text);
        const versions = metadata?.meta?.requiredExtensions ?? {};
        return { success: true, versions };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            return { success: true, versions: {} };
        }
        return { success: false, error: `Direct read failed: ${(error as Error).message}` };
    }
}

export async function checkAndUpdateMetadataVersions(): Promise<MetadataVersionCheckResult> {
    try {
        debug("[MetadataVersionChecker] ═══ METADATA VERSION CHECK ═══");

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            console.warn("[MetadataVersionChecker] No workspace folder found");
            return { canSync: false, metadataUpdated: false, reason: "No workspace folder" };
        }

        const codexEditorVersion = getCurrentExtensionVersion("project-accelerate.codex-editor-extension");
        const frontierAuthVersion = getCurrentExtensionVersion("frontier-rnd.frontier-authentication");

        debug("[MetadataVersionChecker] Installed versions:");
        debug(`  - Codex Editor: ${codexEditorVersion || "not found"}`);
        debug(`  - Frontier Authentication: ${frontierAuthVersion || "not found"}`);

        if (!codexEditorVersion || !frontierAuthVersion) {
            const missingExtensions: string[] = [];
            if (!codexEditorVersion) missingExtensions.push("Codex Editor");
            if (!frontierAuthVersion) missingExtensions.push("Frontier Authentication");

            console.error(
                `[MetadataVersionChecker] Missing required extensions: ${missingExtensions.join(", ")}`
            );
            return {
                canSync: false,
                metadataUpdated: false,
                reason: `Missing required extensions: ${missingExtensions.join(", ")}`,
                needsUserAction: true,
            };
        }

        // Read-only: read versions from metadata.json (codex-editor owns all writes)
        const currentVersionsResult = await getExtensionVersionsViaCommand();
        if (!currentVersionsResult.success) {
            console.warn("[MetadataVersionChecker] Could not read metadata.json:", currentVersionsResult.error);
            return { canSync: false, metadataUpdated: false, reason: "Could not read metadata file" };
        }

        const currentVersions = currentVersionsResult.versions || {};
        const metadataCodexVersion = currentVersions.codexEditor;
        const metadataFrontierVersion = currentVersions.frontierAuthentication;

        debug("[MetadataVersionChecker] Metadata requires:");
        debug(`  - Codex Editor: ${metadataCodexVersion || "not set"}`);
        debug(`  - Frontier Authentication: ${metadataFrontierVersion || "not set"}`);

        // Compare installed vs required — only block if installed is explicitly older.
        // Missing versions in metadata are fine: codex-editor writes them on activation.
        const outdatedExtensions: ExtensionVersionInfo[] = [];

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
                    `[MetadataVersionChecker] Codex Editor outdated: ${codexEditorVersion} < ${metadataCodexVersion}`
                );
                outdatedExtensions.push({
                    extensionId: "project-accelerate.codex-editor-extension",
                    currentVersion: codexEditorVersion,
                    latestVersion: metadataCodexVersion,
                    isOutdated: true,
                    downloadUrl: "",
                    displayName: "Codex Editor",
                });
            }
            // kind === "invalid_required": logged inside helper; fall through (fail-open).
            // kind === "ok" && comparison >= 0: codex-editor owns writes via
            // MetadataManager.ensureExtensionVersionsRecorded on project open.
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
                    `[MetadataVersionChecker] Frontier Authentication outdated: ${frontierAuthVersion} < ${metadataFrontierVersion}`
                );
                outdatedExtensions.push({
                    extensionId: "frontier-rnd.frontier-authentication",
                    currentVersion: frontierAuthVersion,
                    latestVersion: metadataFrontierVersion,
                    isOutdated: true,
                    downloadUrl: "",
                    displayName: "Frontier Authentication",
                });
            }
        }

        if (outdatedExtensions.length > 0) {
            console.warn(
                `[MetadataVersionChecker] Sync blocked due to ${outdatedExtensions.length} outdated extension(s)`
            );
            return {
                canSync: false,
                metadataUpdated: false,
                reason: `Extensions need updating: ${outdatedExtensions
                    .map((ext) => `${ext.displayName} (${ext.currentVersion} → ${ext.latestVersion})`)
                    .join(", ")}`,
                needsUserAction: true,
                outdatedExtensions,
            };
        }

        debug("[MetadataVersionChecker] All extension versions compatible with metadata");
        return { canSync: true, metadataUpdated: false };
    } catch (error) {
        console.error("[MetadataVersionChecker] Error during metadata version check:", error);
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
        if (arr.length <= 1) { return arr[0] || ""; }
        if (arr.length === 2) { return `${arr[0]} and ${arr[1]}`; }
        return `${arr.slice(0, -1).join(", ")}, and ${arr[arr.length - 1]}`;
    };

    if (names.length === 0) { return "To sync, update:"; } // safety fallback
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
    // 1. Pin gate — delegate entirely to the Codex Conductor.
    //    If the Conductor is available (current Codex build), it owns the pin check.
    //    - Mismatches → notify and block.
    //    - No mismatches but pins exist → return true (pins satisfied; skip requiredExtensions
    //      entirely, since the pin takes precedence over any requiredExtensions constraint).
    //    - No pins → fall through to the requiredExtensions check below.
    //    If the Conductor is unavailable (older build) → fall through and rely on
    //    requiredExtensions alone.
    try {
        const mismatches = await vscode.commands.executeCommand<{
            extensionId: string;
            pinnedVersion: string;
            runningVersion: string | null;
        }[]>("codex.conductor.getPinMismatches");

        if (mismatches && mismatches.length > 0) {
            const summary = mismatches.map((m) => `${m.extensionId} running=${m.runningVersion} pinned=${m.pinnedVersion}`).join(", ");
            debug(`[PinVersionChecker] Conductor pin mismatch: ${summary}`);
            if (shouldShowVersionModal(context, isManualSync)) {
                const bullets = mismatches
                    .map((m) => `- ${extensionDisplayName(m.extensionId)} (pinned to v${m.pinnedVersion})`)
                    .join("\n");
                const message = `Extension version pin detected — sync paused.\n${bullets}`;
                vscode.window.showInformationMessage(message);
            }
            return false;
        }

        const effectivePins = await vscode.commands.executeCommand<Record<string, unknown>>(
            "codex.conductor.getEffectivePinnedExtensions"
        );
        if (effectivePins && Object.keys(effectivePins).length > 0) {
            // Pins are active and satisfied — requiredExtensions is not authoritative.
            return true;
        }
    } catch {
        // Conductor not available (older build) — fall through to requiredExtensions check.
        debug("[PinVersionChecker] Conductor unavailable, falling back to requiredExtensions");
    }

    // 2. requiredExtensions check (no active pins).
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

// ── Pinned extension sync gate ──────────────────────────────────────────────

export interface PinnedExtensionEntry {
    version: string;
    url: string;
}

export type PinnedExtensions = Record<string, PinnedExtensionEntry>;

/** Type guard to validate the PinnedExtensions structure. */
export function isPinnedExtensions(obj: unknown): obj is PinnedExtensions {
    if (!obj || typeof obj !== "object") {
        return false;
    }
    for (const [key, value] of Object.entries(obj)) {
        if (typeof key !== "string") {
            return false;
        }
        const entry = value as Partial<PinnedExtensionEntry>;
        if (typeof entry?.version !== "string" || typeof entry?.url !== "string") {
            return false;
        }
    }
    return true;
}

/**
 * Reads pinnedExtensions from the local metadata.json.
 * Returns the map if present, or undefined if absent/unreadable.
 */
export async function readLocalPinnedExtensions(): Promise<PinnedExtensions | undefined> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return undefined;
    }
    try {
        const metadataUri = vscode.Uri.joinPath(workspaceFolder.uri, "metadata.json");
        const content = await vscode.workspace.fs.readFile(metadataUri);
        const metadata = JSON.parse(new TextDecoder().decode(content));
        const pins = metadata?.meta?.pinnedExtensions;
        return isPinnedExtensions(pins) ? pins : undefined;
    } catch {
        return undefined;
    }
}

/** Strip publisher prefix and -extension suffix, title-case the rest. */
function extensionDisplayName(extensionId: string): string {
    const name = extensionId.includes(".")
        ? extensionId.slice(extensionId.indexOf(".") + 1)
        : extensionId;
    return name
        .replace(/-extension$/, "")
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
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
                    const dugiteGit = await import("../git/dugiteGit");
                    // Only fetch if git binary is configured (it may not be during tests)
                    if (dugiteGit.isGitBinaryConfigured()) {
                        // We need auth but don't have it here — skip fetch, rely on cached remote refs
                        // The SCMManager fetch in syncChanges will have updated refs already
                    }
                } catch {}

                let mismatch = false;
                try {
                    const dugiteGit = await import("../git/dugiteGit");
                    const currentBranch = await dugiteGit.currentBranch(workspacePath);
                    if (currentBranch) {
                        const remoteRef = `refs/remotes/origin/${currentBranch}`;
                        let remoteHead: string | undefined;
                        try { remoteHead = await dugiteGit.resolveRef(workspacePath, remoteRef); } catch {}
                        if (remoteHead) {
                            try {
                                const blob = await dugiteGit.readBlobAtRef(workspacePath, remoteHead, "metadata.json");
                                const text = new TextDecoder().decode(blob);
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

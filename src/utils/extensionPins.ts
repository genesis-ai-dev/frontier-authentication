import { getPinPolicy } from "./pinPolicy";
import { EXTENSION_PIN_POLICY } from "./extensionPinFeatureFlag";
import * as vscode from "vscode";

/** The editor owns metadata writes. Never fall back to a competing writer. */
export async function clearProjectPins(folder: vscode.Uri): Promise<boolean> {
    await getPinPolicy();
    if (!EXTENSION_PIN_POLICY.ignoreProjectPins) { return false; }
    try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, "metadata.json"));
    } catch (error) {
        if ((error as { code?: string }).code === "FileNotFound") { return false; }
        throw error;
    }
    const editor = vscode.extensions.getExtension("project-accelerate.codex-editor-extension");
    if (editor?.packageJSON.codexProjectPinPolicyVersion !== 2) { throw new Error("Install the coordinated Codex Editor build before cleaning project pins"); }
    // Do not await Editor.activate(): it may be awaiting this Frontier command.
    // Its cleanup command is registered before the first activation await.
    let commands = await vscode.commands.getCommands(true);
    for (let attempt = 0; !commands.includes("codex.clearProjectExtensionPins") && attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        commands = await vscode.commands.getCommands(true);
    }
    if (!commands.includes("codex.clearProjectExtensionPins")) {
        throw new Error("Codex Editor must be updated and ready before this project can be opened or synced. Please update Codex Editor and reload.");
    }
    return await vscode.commands.executeCommand<boolean>("codex.clearProjectExtensionPins", folder.toString());
}

export async function clearCurrentProjectPins(): Promise<void> {
    if (!EXTENSION_PIN_POLICY.ignoreProjectPins) { return; }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return; }
    await clearProjectPins(folder.uri);
    await clearConductorPinState();
}

/** Clear current-workspace Conductor storage only after the file is saved.
 * Missing commands are expected on older binaries / stock VS Code.
 * Errors from commands that exist must propagate rather than pretending success.
 */
export async function clearConductorPinState(): Promise<void> {
    if (!EXTENSION_PIN_POLICY.ignoreProjectPins) { return; }
    // The binary owns caches and profile recovery. Never synthesize pin signals.
    await vscode.commands.executeCommand("codex.conductor.reconcilePinPolicy");
}

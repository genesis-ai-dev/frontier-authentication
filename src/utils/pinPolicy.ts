import { validatePinDecisions } from "./pinDecisions";
import type { PinDecisions } from "./pinDecisions";
import * as vscode from "vscode";
import * as git from "../git/dugiteGit";
import { EXTENSION_PIN_POLICY } from "./extensionPinFeatureFlag";
export interface PinStatus {
    protocolVersion: number;
    workspace?: string;
    generation: number;
    pendingIntent?: boolean;
    remote?: { pins: PinDecisions };
    mode: "ignore" | "enforce";
    phase: "resolving" | "preparing" | "switching" | "ready" | "blocked";
    pins: PinDecisions;
    error?: string;
}
export async function getPinPolicy(): Promise<PinStatus | undefined> {
    if (!(await vscode.commands.getCommands(true)).includes("codex.conductor.getPinPolicyStatus")) {
        EXTENSION_PIN_POLICY.ignoreProjectPins = false;
        return undefined;
    }
    const status = await vscode.commands.executeCommand<PinStatus>("codex.conductor.getPinPolicyStatus");
    if (!status || status.protocolVersion !== 1) { throw new Error("Unsupported Codex pin-policy protocol"); }
    EXTENSION_PIN_POLICY.ignoreProjectPins = status.mode === "ignore";
    return status;
}
export type DiscoveryResult = { kind: "verified"; commit: string } | { kind: "unavailable" | "invalid" | "authentication-required" | "not-ready" | "local"; reason: string };

/** Fetch by the actual checked-out branch. Failures never submit an empty snapshot. */
const pendingDiscoveries = new Map<string, Promise<DiscoveryResult>>();

export async function discoverRemotePins(dir: string, token: string | undefined | (() => Promise<string | undefined>), reconcile = true): Promise<DiscoveryResult> {
    let pending = pendingDiscoveries.get(dir);
    if (!pending) {
        pending = discoverRemotePinsInternal(dir, token);
        pendingDiscoveries.set(dir, pending);
    }
    let result: DiscoveryResult;
    try { result = await pending; }
    finally { if (pendingDiscoveries.get(dir) === pending) { pendingDiscoveries.delete(dir); } }
    if (result.kind === "unavailable" || result.kind === "authentication-required") {
        const cached = await getPinPolicy();
        if (cached?.remote) {
            try { await persistAcceptedPins(dir, cached.generation); }
            catch (error) { return { kind: "invalid", reason: String(error) }; }
        }
    }
    if (reconcile && result.kind === "verified") { await vscode.commands.executeCommand("codex.conductor.reconcilePinPolicy"); }
    return result;
}

async function discoverRemotePinsInternal(dir: string, token: string | undefined | (() => Promise<string | undefined>)): Promise<DiscoveryResult> {
    let branch: string | undefined;
    let origin: string | undefined;
    try {
        branch = (await git.currentBranch(dir)) ?? undefined;
        origin = (await git.listRemotes(dir)).find(remote => remote.remote === "origin")?.url;
    } catch (error) {
        // A failed local lookup is not evidence that a previously accepted source disappeared.
        return { kind: "unavailable", reason: String(error) };
    }
    const ticket = await vscode.commands.executeCommand<{ session: string; request: number }>("codex.conductor.beginRemotePinCheck", { origin: origin ?? "", branch: branch ?? "" });
    if (!ticket) { return { kind: "not-ready", reason: "Pin coordinator unavailable" }; }
    if (!branch || !origin) { return { kind: "local", reason: "No remote branch; use local project pins" }; }
    let credential: string | undefined;
    let credentialTimer: ReturnType<typeof setTimeout> | undefined;
    let credentialTimedOut = false;
    try {
        credential = typeof token === "function" ? await Promise.race([
            token(),
            new Promise<undefined>(resolve => {
                credentialTimer = setTimeout(() => { credentialTimedOut = true; resolve(undefined); }, 5000);
            })
        ]) : token;
    } catch (error) { return { kind: "unavailable", reason: String(error) }; }
    finally { if (credentialTimer !== undefined) { clearTimeout(credentialTimer); } }
    if (credentialTimedOut) { return { kind: "unavailable", reason: "Credential discovery timed out; retain local policy" }; }
    if (!credential) { return { kind: "authentication-required", reason: "Sign in to check remote project pins" }; }
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
        await git.fetchOrigin(dir, { username: "oauth2", password: credential }, undefined, abort.signal);
    } catch (error) {
        return { kind: "unavailable", reason: String(error) };
    } finally { clearTimeout(timeout); }
    try {
        if (await git.currentBranch(dir) !== branch || (await git.listRemotes(dir)).find(remote => remote.remote === "origin")?.url !== origin) {
            return { kind: "not-ready", reason: "Repository changed during discovery" };
        }
        const commit = await git.resolveRef(dir, `refs/remotes/origin/${branch}`);
        const metadata = JSON.parse(new TextDecoder().decode(await git.readBlobAtRef(dir, commit, "metadata.json")));
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || (metadata.meta !== undefined && (!metadata.meta || typeof metadata.meta !== "object" || Array.isArray(metadata.meta)))) {
            throw new Error("Invalid remote metadata");
        }
        const result = await vscode.commands.executeCommand<{ accepted: boolean; generation: number; pendingIntent?: boolean }>("codex.conductor.acceptRemotePinSnapshot", {
            ...ticket, snapshot: { origin, branch, commit, pins: validatePinDecisions(metadata.meta?.pinnedExtensions === undefined ? {} : metadata.meta.pinnedExtensions) }
        });
        if (!result?.accepted) { return { kind: "not-ready", reason: "Remote response superseded" }; }
        await persistAcceptedPins(dir, result.generation);
        return { kind: "verified", commit };
    } catch (error) { return { kind: "invalid", reason: String(error) }; }
}

export async function persistAcceptedPins(dir: string, generation: number): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes("codex.applyRemoteProjectPins")) {
        await vscode.commands.executeCommand("codex.applyRemoteProjectPins", { generation });
    } else {
        // Native persistence shares the decision queue and does not depend on Editor activation.
        const metadataUri = vscode.Uri.joinPath(vscode.Uri.file(dir), "metadata.json");
        if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === metadataUri.toString() && doc.isDirty)) { throw new Error("Save metadata.json before applying project pins"); }
        await vscode.commands.executeCommand("codex.conductor.writeProjectPins", { generation });
    }
}

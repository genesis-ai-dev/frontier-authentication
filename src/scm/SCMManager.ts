import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ConflictedFile, GitService } from "../git/GitService";
import { GitLabService } from "../gitlab/GitLabService";
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { PublishWorkspaceOptions } from "../commands/scmCommands";
import { StateManager } from "../state";
import { ResolvedFile } from "../extension";
import { MediaFilesStrategy } from "../types/state";
import { checkMetadataVersionsForSync } from "../utils/extensionVersionChecker";
import {
    checkRequiredVersion,
    getInstalledExtensionVersions,
    handleOutdatedExtensionsForSync,
    ExtensionVersionInfo,
    checkPinnedExtensionsForSync,
} from "../utils/extensionVersionChecker";

export class SCMManager {
    private scmProvider: vscode.SourceControl;
    private workingTree: vscode.SourceControlResourceGroup;
    private staging: vscode.SourceControlResourceGroup;
    private fileSystemWatcher: vscode.FileSystemWatcher | undefined;
    public gitService: GitService;
    private gitLabService: GitLabService;
    private autoSyncEnabled: boolean = false;
    private autoSyncInterval: NodeJS.Timeout | undefined;
    private gitIgnorePatterns: string[] = [];
    private readonly context: vscode.ExtensionContext;
    private stateManager: StateManager;
    private syncStatusBarItem: vscode.StatusBarItem | undefined;
    private syncEventEmitter: vscode.EventEmitter<{
        status: "started" | "completed" | "error" | "skipped" | "progress";
        message?: string;
        progress?: {
            phase: string;
            loaded?: number;
            total?: number;
            description?: string;
        };
    }> = new vscode.EventEmitter();
    public readonly onSyncStatusChange = this.syncEventEmitter.event;

    constructor(gitLabService: GitLabService, context: vscode.ExtensionContext) {
        this.context = context;
        this.stateManager = StateManager.getInstance();
        this.gitService = new GitService(this.stateManager);
        this.gitLabService = gitLabService;

        // We'll initialize the SCM provider when we have a workspace
        this.scmProvider = vscode.scm.createSourceControl("frontier", "Frontier SCM");

        // Initialize resource groups
        this.workingTree = this.scmProvider.createResourceGroup("working", "Working Tree");
        this.staging = this.scmProvider.createResourceGroup("staging", "Staged Changes");

        // Set up input box for commit messages
        this.scmProvider.inputBox.placeholder = "Enter commit message";

        // Register sync commands
        this.registerCommands();
    }

    private getWorkspacePath(): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error("No workspace folder found");
        }
        const path = workspaceFolder.uri.fsPath;
        // console.log("Using workspace path:", path);
        return path;
    }

    private async readLocalMediaStrategy(workspacePath: string): Promise<MediaFilesStrategy | undefined> {
        try {
            const settingsPath = path.join(workspacePath, ".project", "localProjectSettings.json");
            const content = await fs.promises.readFile(settingsPath, "utf8");
            const settings = JSON.parse(content);
            return settings.currentMediaFilesStrategy ?? settings.mediaFilesStrategy;
        } catch {
            return undefined;
        }
    }

    private async readLocalLfsSourceUrl(workspacePath: string): Promise<string | undefined> {
        try {
            const settingsPath = path.join(workspacePath, ".project", "localProjectSettings.json");
            const content = await fs.promises.readFile(settingsPath, "utf8");
            const settings = JSON.parse(content);
            return settings.lfsSourceRemoteUrl;
        } catch {
            return undefined;
        }
    }

    private async clearLocalLfsSourceUrl(workspacePath: string): Promise<void> {
        try {
            const settingsPath = path.join(workspacePath, ".project", "localProjectSettings.json");
            const content = await fs.promises.readFile(settingsPath, "utf8");
            const settings = JSON.parse(content);
            if (!settings.lfsSourceRemoteUrl) { return; }
            delete settings.lfsSourceRemoteUrl;
            await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 4));
        } catch {
            // ignore
        }
    }

    private registerCommands(): void {
        // Manual sync command
        this.context.subscriptions.push(
            vscode.commands.registerCommand(
                "frontier.syncChanges",
                (options?: { commitMessage?: string }) => this.syncChanges(options, true)
            )
        );

        // Toggle auto-sync command
        this.context.subscriptions.push(
            vscode.commands.registerCommand("frontier.toggleAutoSync", () => this.toggleAutoSync())
        );

        // Commit changes command (used by SCM input box)
        this.context.subscriptions.push(
            vscode.commands.registerCommand("frontier.commitChanges", () => this.commitChanges())
        );

        this.context.subscriptions.push(
            vscode.commands.registerCommand(
                "frontier.completeMerge",
                (resolvedFiles: ResolvedFile[], workspacePath: string | undefined) =>
                    this.completeMerge(resolvedFiles, workspacePath)
            )
        );
    }

    async createAndCloneProject(options: {
        name: string;
        description?: string;
        visibility?: "private" | "internal" | "public";
        groupId?: string;
        workspacePath?: string;
        path?: string;
        openWorkspace?: boolean;
    }): Promise<void> {
        try {
            // Initialize GitLab service and create project
            await this.gitLabService.initializeWithRetry();

            // Create the project
            const project = await this.gitLabService.createProject({
                name: options.name,
                description: options.description,
                visibility: options.visibility,
                groupId: options.groupId,
            });

            // Get workspace path
            let workspacePath = options.workspacePath;
            if (!workspacePath) {
                workspacePath = await this.promptForWorkspacePath(options.name);
            }
            if (!workspacePath) {
                throw new Error("No workspace path selected");
            }

            // Clone the repository using the token for authentication
            await this.cloneRepository(project.url, workspacePath);

            // Conditionally open the workspace (default to true for backward compatibility)
            const shouldOpenWorkspace = options.openWorkspace !== false;
            if (shouldOpenWorkspace) {
                // Open the workspace
                await this.openWorkspace(workspacePath);

                // Initialize SCM
                await this.initializeSCM(workspacePath);
            }

            const action = project.url.includes("already exists") ? "cloned" : "created and cloned";
            vscode.window.showInformationMessage(`Project ${options.name} ${action} successfully!`);
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(
                    `Failed to create and clone project: ${error.message}`
                );
            }
            throw error;
        }
    }

    async cloneExistingRepository(
        repoUrl: string,
        cloneToPath?: string,
        openWorkspace: boolean = true,
        mediaStrategy?: "auto-download" | "stream-and-save" | "stream-only"
    ): Promise<void> {
        try {
            // Ensure GitLab service is initialized
            await this.gitLabService.initializeWithRetry();

            // Get GitLab credentials
            const gitlabToken = await this.gitLabService.getToken();
            if (!gitlabToken) {
                throw new Error("GitLab token not available");
            }

            // Extract project name from URL and construct authenticated URL
            const url = new URL(repoUrl);
            const projectName = url.pathname.split("/").pop()?.replace(".git", "") || "project";
            url.username = "oauth2";
            url.password = gitlabToken;

            // Get workspace path
            const workspacePath = cloneToPath || (await this.promptForWorkspacePath(projectName));
            if (!workspacePath) {
                throw new Error("No workspace path selected");
            }

            // Clone the repository with media strategy
            await this.cloneRepository(url.toString(), workspacePath, mediaStrategy);

            // Conditionally open the workspace
            if (openWorkspace) {
                await this.openWorkspace(workspacePath);

                // Initialize SCM only if workspace is opened
                await this.initializeSCM(workspacePath);
            }

            vscode.window.showInformationMessage("Repository cloned successfully!");
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to clone repository: ${error.message}`);
            }
            throw error;
        }
    }

    private async promptForWorkspacePath(defaultName: string): Promise<string | undefined> {
        vscode.window.showInformationMessage("Prompting for workspace path");
        // Use the default downloads directory or home directory
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        const defaultUri = vscode.Uri.file(path.join(homeDir || "", defaultName));

        const result = await vscode.window.showSaveDialog({
            defaultUri,
            title: "Select Workspace Location",
            filters: { "All Files": ["*"] },
        });

        if (result) {
            // Create the directory if it doesn't exist
            try {
                await vscode.workspace.fs.createDirectory(result);
                return result.fsPath;
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to create directory: ${
                        error instanceof Error ? error.message : "Unknown error"
                    }`
                );
                return undefined;
            }
        }
        return undefined;
    }

    private async cloneRepository(
        repoUrl: string,
        workspacePath: string, // this is the path to the local directory where the repository will be cloned
        mediaStrategy?: "auto-download" | "stream-and-save" | "stream-only"
    ): Promise<void> {
        try {
            const url = new URL(repoUrl);
            const gitlabToken = await this.gitLabService.getToken();
            if (!gitlabToken) {
                throw new Error("GitLab token not available");
            }

            // Set up authentication
            const auth = {
                username: "oauth2",
                password: gitlabToken,
            };

            // Persist repo strategy (defaults handled downstream)
            try {
                if (mediaStrategy) {
                    await this.stateManager.setRepoStrategy(workspacePath, mediaStrategy);
                }
            } catch {}

            // Clone the repository with media strategy
            await this.gitService.clone(repoUrl, workspacePath, auth, mediaStrategy);

            // Ensure remote is properly configured
            const remotes = await this.gitService.getRemotes(workspacePath);
            if (!remotes.some((r) => r.remote === "origin")) {
                await this.gitService.addRemote(workspacePath, "origin", repoUrl);
            }

            // console.log("Repository cloned successfully to:", workspacePath);
        } catch (error) {
            console.error("Clone error:", error);
            throw new Error(
                `Failed to clone repository: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }
    }

    async initializeSCM(workspacePath: string): Promise<void> {
        try {
            // Check if git is initialized
            const hasGit = await this.gitService.hasGitRepository(workspacePath);
            if (!hasGit) {
                await this.gitService.init(workspacePath);
            }

            // Get current user info and configure git
            const user = await this.gitLabService.getCurrentUser();
            const authorName = user.name || user.username;
            const authorEmail = user.email || `${user.username}@users.noreply.gitlab.com`;
            await this.gitService.configureAuthor(workspacePath, authorName, authorEmail);

            // Set up file watcher
            this.setupFileWatcher(workspacePath);

            // Load .gitignore patterns
            await this.loadGitIgnore(workspacePath);

            // Check remote configuration
            const remotes = await this.gitService.getRemotes(workspacePath);
            const remoteUrl = await this.gitService.getRemoteUrl(workspacePath);

            if (remoteUrl && !remotes.some((r) => r.remote === "origin")) {
                await this.gitService.addRemote(workspacePath, "origin", remoteUrl);
            }

            console.log("SCM initialized successfully");
        } catch (error) {
            console.error("SCM initialization error:", error);
            throw new Error(
                `Failed to initialize SCM: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }
    }

    private async openWorkspace(workspacePath: string): Promise<void> {
        const uri = vscode.Uri.file(workspacePath);
        await vscode.commands.executeCommand("vscode.openFolder", uri);
    }

    private async loadGitIgnore(workspacePath: string): Promise<void> {
        try {
            const gitIgnoreUri = vscode.Uri.file(path.join(workspacePath, ".gitignore"));
            try {
                const content = await vscode.workspace.fs.readFile(gitIgnoreUri);
                this.gitIgnorePatterns = Buffer.from(content)
                    .toString("utf8")
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line && !line.startsWith("#"));
            } catch (error) {
                // It's okay if .gitignore doesn't exist
                this.gitIgnorePatterns = [];
            }
        } catch (error) {
            console.error("Error loading .gitignore:", error);
            this.gitIgnorePatterns = [];
        }
    }

    private shouldIgnoreFile(filePath: string): boolean {
        const relativePath = vscode.workspace.asRelativePath(filePath);
        return this.gitIgnorePatterns.some((pattern) => {
            if (pattern.endsWith("/")) {
                return relativePath.startsWith(pattern);
            }
            return new RegExp(`^${pattern.replace(/\*/g, ".*")}$`).test(relativePath);
        });
    }

    private setupFileWatcher(workspacePath: string): void {
        // Dispose existing watcher if any
        this.fileSystemWatcher?.dispose();

        // Create new watcher for all files in workspace
        this.fileSystemWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspacePath, "**/*")
        );

        // Handle file changes
        this.fileSystemWatcher.onDidChange(async (uri) => {
            if (this.autoSyncEnabled && !this.shouldIgnoreFile(uri.fsPath)) {
                await this.syncChanges();
            }
        });

        this.fileSystemWatcher.onDidCreate(async (uri) => {
            if (this.autoSyncEnabled && !this.shouldIgnoreFile(uri.fsPath)) {
                await this.syncChanges();
            }
        });

        this.fileSystemWatcher.onDidDelete(async (uri) => {
            if (this.autoSyncEnabled && !this.shouldIgnoreFile(uri.fsPath)) {
                await this.syncChanges();
            }
        });
    }

    private async handleRemotePinValidation(
        remotePins: Record<string, { version: string; url: string }> | undefined,
        isManualSync: boolean
    ): Promise<{ canSync: boolean; pinnedIds: Set<string> }> {
        // Write remote pins to workspaceState so the Codex Conductor
        // (workbench contribution) can pick them up via IStorageService,
        // even if sync aborts before merge lands metadata.json on disk.
        await this.context.workspaceState.update("remotePinnedExtensions", remotePins);

        // Use the shared utility to check for mismatches, respect cooldowns, and show notifications.
        // This ensures remote pin detection behaves exactly like the local sync-gate.
        return await checkPinnedExtensionsForSync(this.context, isManualSync, remotePins);
    }

    async syncChanges(
        options?: { commitMessage?: string },
        isManualSync: boolean = false
    ): Promise<{
        hasConflicts: boolean;
        conflicts?: ConflictedFile[];
        /**
         * Optional diagnostics to help clients validate remote changes vs merged conflicts.
         */
        allChangedFilePaths?: string[];
        remoteChangedFilePaths?: string[];
    }> {
        // Check extension version compatibility with project metadata before syncing
        const canSync = await checkMetadataVersionsForSync(this.context, isManualSync);
        if (!canSync) {
            return { hasConflicts: false };
        }

        // Check if another sync is already in progress before firing 'started' event
        if (this.gitService.isSyncLocked()) {
            this.syncEventEmitter.fire({ status: "skipped", message: "Sync already in progress" });
            vscode.window.showInformationMessage(
                "Sync already in progress. Please wait for the current synchronization to complete."
            );
            return { hasConflicts: false };
        }

        // Fire sync started event (only if lock is free)
        this.syncEventEmitter.fire({ status: "started", message: "Synchronization started" });

        // Create or show the status bar item
        if (!this.syncStatusBarItem) {
            this.syncStatusBarItem = vscode.window.createStatusBarItem(
                vscode.StatusBarAlignment.Right,
                100
            );
        }

        // Start animation
        let animationFrame = 0;
        const animationFrames = ["$(cloud-upload)", "$(cloud)", "$(cloud-download)"];
        const animationInterval = setInterval(() => {
            if (this.syncStatusBarItem) {
                this.syncStatusBarItem.text = `${animationFrames[animationFrame]} Syncing...`;
                this.syncStatusBarItem.show();
                animationFrame = (animationFrame + 1) % animationFrames.length;
            }
        }, 500);

        let syncSucceeded = false;
        try {
            const token = await this.gitLabService.getToken();
            if (!token) {
                throw new Error("GitLab token not found. Please authenticate first.");
            }

            const auth = {
                username: "oauth2",
                password: token,
            };

            const workspacePath = this.getWorkspacePath();
            const user = await this.gitLabService.getCurrentUser();
            if (!user) {
                throw new Error("Could not get user information from GitLab");
            }

            const author = {
                name: user.name || user.username,
                email: user.email || `${user.username}@users.noreply.gitlab.com`,
            };

            // Fetch and check remote metadata.json requirements without merging
            try {
                // Fetch latest remote refs
                await git.fetch({
                    fs,
                    http,
                    dir: workspacePath,
                    onAuth: () => auth,
                });

                const currentBranch = await git.currentBranch({ fs, dir: workspacePath });
                if (currentBranch) {
                    const remoteRef = `refs/remotes/origin/${currentBranch}`;
                    let remoteHead: string | undefined;
                    try {
                        remoteHead = await git.resolveRef({
                            fs,
                            dir: workspacePath,
                            ref: remoteRef,
                        });
                    } catch (e) {
                        // No remote branch yet; skip remote metadata check
                    }

                    if (remoteHead) {
                        try {
                            const result = await git.readBlob({
                                fs,
                                dir: workspacePath,
                                oid: remoteHead,
                                filepath: "metadata.json",
                            });
                            const text = new TextDecoder().decode(result.blob);
                            const remoteMetadata = JSON.parse(text) as {
                                meta?: {
                                    requiredExtensions?: {
                                        codexEditor?: string;
                                        frontierAuthentication?: string;
                                    };
                                    pinnedExtensions?: Record<string, { version: string; url: string }>;
                                };
                            };

                            // Write remote pins to workspaceState and check for mismatches.
                            // Pins override requiredExtensions version checks.
                            const remotePins = remoteMetadata.meta?.pinnedExtensions;
                            const { canSync: canSyncPins, pinnedIds } =
                                await this.handleRemotePinValidation(remotePins, isManualSync);
                            if (!canSyncPins) {
                                return { hasConflicts: false };
                            }

                            const required = remoteMetadata.meta?.requiredExtensions;
                            if (required) {
                                const { codexEditorVersion, frontierAuthVersion } =
                                    getInstalledExtensionVersions();
                                const outdated: ExtensionVersionInfo[] = [];

                                if (
                                    required.codexEditor &&
                                    !pinnedIds.has("project-accelerate.codex-editor-extension") &&
                                    (() => {
                                        const codexCheck = checkRequiredVersion(
                                            codexEditorVersion,
                                            required.codexEditor,
                                            "Codex Editor"
                                        );
                                        return (
                                            codexCheck.kind === "unknown_current" ||
                                            (codexCheck.kind === "ok" && codexCheck.comparison < 0)
                                        );
                                    })()
                                ) {
                                    outdated.push({
                                        extensionId: "project-accelerate.codex-editor-extension",
                                        currentVersion: codexEditorVersion ?? "unknown",
                                        latestVersion: required.codexEditor,
                                        isOutdated: true,
                                        downloadUrl: "",
                                        displayName: "Codex Editor",
                                    });
                                }

                                if (
                                    required.frontierAuthentication &&
                                    !pinnedIds.has("frontier-rnd.frontier-authentication") &&
                                    (() => {
                                        const frontierCheck = checkRequiredVersion(
                                            frontierAuthVersion,
                                            required.frontierAuthentication,
                                            "Frontier Authentication"
                                        );
                                        return (
                                            frontierCheck.kind === "unknown_current" ||
                                            (frontierCheck.kind === "ok" && frontierCheck.comparison < 0)
                                        );
                                    })()
                                ) {
                                    outdated.push({
                                        extensionId: "frontier-rnd.frontier-authentication",
                                        currentVersion: frontierAuthVersion ?? "unknown",
                                        latestVersion: required.frontierAuthentication,
                                        isOutdated: true,
                                        downloadUrl: "",
                                        displayName: "Frontier Authentication",
                                    });
                                }

                                if (outdated.length > 0) {
                                    const allow = await handleOutdatedExtensionsForSync(
                                        this.context,
                                        outdated,
                                        isManualSync
                                    );
                                    if (!allow) {
                                        return { hasConflicts: false };
                                    }
                                }
                            }
                        } catch (readErr) {
                            // No metadata.json on remote or parse failure; proceed
                        }
                    }
                }
            } catch (remoteCheckErr) {
                // Remote fetch failed; continue to normal sync path
            }

            // Try to sync and get result with progress reporting
            const syncResult = await this.gitService.syncChanges(workspacePath, auth, author, {
                ...options,
                onProgress: (phase, loaded, total, description) => {
                    // Fire progress event to UI
                    this.syncEventEmitter.fire({
                        status: "progress",
                        message: description || `${phase}: ${loaded}/${total}`,
                        progress: {
                            phase,
                            loaded,
                            total,
                            description,
                        },
                    });
                },
            });

            // If sync was skipped due to a lock, inform the user and do not show "Synced"
            if (syncResult.skippedDueToLock) {
                clearInterval(animationInterval);
                if (this.syncStatusBarItem) {
                    this.syncStatusBarItem.text = `$(lock) Sync skipped (another sync in progress)`;
                    this.syncStatusBarItem.show();
                    setTimeout(() => {
                        this.syncStatusBarItem?.hide();
                    }, 4000);
                }
                vscode.window.showWarningMessage(
                    "Sync skipped: another synchronization appears to be in progress. If this persists, ensure .git/frontier-sync.lock does not exist."
                );
                // Fire sync skipped event
                this.syncEventEmitter.fire({
                    status: "skipped",
                    message: "Sync skipped: another sync in progress",
                });
                return { hasConflicts: false };
            }

            // If we have conflicts, return them to client
            if (syncResult.hadConflicts && syncResult.conflicts) {
                return {
                    hasConflicts: true,
                    conflicts: syncResult.conflicts,
                    allChangedFilePaths: syncResult.allChangedFilePaths,
                    remoteChangedFilePaths: syncResult.remoteChangedFilePaths,
                };
            }

            // Everything synced successfully
            syncSucceeded = true;
            return { hasConflicts: false };
        } catch (error) {
            console.error("Sync error:", error);
            // Fire sync error event
            this.syncEventEmitter.fire({
                status: "error",
                message: error instanceof Error ? error.message : "Sync error",
            });
            throw error;
        } finally {
            // Stop animation and update status
            clearInterval(animationInterval);
            if (this.syncStatusBarItem) {
                this.syncStatusBarItem.text = `$(cloud) Synced`;
                // Hide after a short delay
                setTimeout(() => {
                    if (this.syncStatusBarItem) {
                        this.syncStatusBarItem.hide();
                    }
                }, 3000);
            }
            // Fire sync completed event only if sync succeeded
            if (syncSucceeded) {
                this.syncEventEmitter.fire({
                    status: "completed",
                    message: "Synchronization complete",
                });
                // Signal to the Codex Conductor that a sync completed.
                // The conductor observes this via IStorageService to detect
                // mid-session pin changes in metadata.json.
                await this.context.workspaceState.update('syncCompletedAt', Date.now());
            }
        }
    }

    enableAutoSync(workspacePath: string, intervalMinutes: number = 5): void {
        this.autoSyncEnabled = true;
        this.autoSyncInterval = setInterval(
            () => {
                this.syncChanges().catch((error) => {
                    console.error("Auto-sync error:", error);
                    vscode.window.showErrorMessage(
                        `Auto-sync failed: ${
                            error instanceof Error ? error.message : "Unknown error"
                        }`
                    );
                });
            },
            intervalMinutes * 60 * 1000
        );
    }

    disableAutoSync(): void {
        this.autoSyncEnabled = false;
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = undefined;
        }
    }

    isAutoSyncEnabled(): boolean {
        return this.autoSyncEnabled;
    }

    private async commitChanges(): Promise<void> {
        try {
            const message = this.scmProvider.inputBox.value;
            if (!message) {
                throw new Error("Please enter a commit message");
            }

            const workspacePath = this.getWorkspacePath();

            // Get current user info for commit author details
            const user = await this.gitLabService.getCurrentUser();

            // Add all changes
            await this.gitService.addAll(workspacePath);

            // Commit
            await this.gitService.commit(workspacePath, message, {
                name: user.name || user.username,
                email: user.email || `${user.username}@users.noreply.gitlab.com`,
            });

            // Clear the input box
            this.scmProvider.inputBox.value = "";

            // Push changes
            const token = await this.gitLabService.getToken();
            if (!token) {
                throw new Error("GitLab token not found. Please authenticate first.");
            }

            const auth = {
                username: "oauth2",
                password: token,
            };

            await this.gitService.push(workspacePath, auth);

            vscode.window.showInformationMessage("Changes committed and pushed successfully");
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to commit changes: ${error.message}`);
            }
        }
    }

    private async toggleAutoSync(): Promise<void> {
        this.autoSyncEnabled = !this.autoSyncEnabled;
        vscode.window.showInformationMessage(
            `Auto-sync is now ${this.autoSyncEnabled ? "enabled" : "disabled"}`
        );
    }

    async publishWorkspace(options: {
        name: string;
        description?: string;
        visibility?: "private" | "internal" | "public";
        groupId?: string;
    }): Promise<void> {
        try {
            console.log("Starting workspace publish with options:", options);

            // Initialize GitLab service
            await this.gitLabService.initializeWithRetry();

            // Get workspace path
            const workspacePath = this.getWorkspacePath();
            console.log("Using workspace path:", workspacePath);

            // Create the project
            console.log("Creating GitLab project...");
            const project = await this.gitLabService.createProject({
                name: options.name,
                description: options.description,
                visibility: options.visibility,
                groupId: options.groupId,
            });
            console.log("Project created successfully:", project);

            // Initialize git repository if not already initialized
            const isGitRepo = await this.gitService.hasGitRepository(workspacePath);
            if (!isGitRepo) {
                console.log("Initializing git repository...");
                await this.gitService.init(workspacePath);
            }

            // Add remote if not already added
            const currentRemoteUrl = await this.gitService.getRemoteUrl(workspacePath);
            if (!currentRemoteUrl) {
                console.log("Adding git remote...");
                await this.gitService.addRemote(workspacePath, "origin", project.url);
            }

            // Acquire GitLab token before staging so LFS uploads can authenticate
            const gitlabToken = await this.gitLabService.getToken();
            if (!gitlabToken) {
                throw new Error("GitLab token not available");
            }

            // Sync media strategy from local project settings (if present)
            const localStrategy = await this.readLocalMediaStrategy(workspacePath);
            if (localStrategy) {
                await this.stateManager.setRepoStrategy(workspacePath, localStrategy);
            }

            // If stream-only/stream-and-save, temporarily download LFS bytes before publishing
            let restoreStrategy: MediaFilesStrategy | undefined;
            try {
                restoreStrategy = await this.gitService.prepareLfsBytesForPublish(workspacePath, {
                    username: "oauth2",
                    password: gitlabToken,
                });
            } catch (e) {
                throw new Error(
                    "Cannot publish in stream-only mode: LFS objects are missing. Switch to auto-download and retry."
                );
            }

            // If we have a source LFS remote URL, attempt to hydrate bytes before staging
            const sourceLfsUrl = await this.readLocalLfsSourceUrl(workspacePath);
            if (sourceLfsUrl) {
                const lfsBaseUrl = sourceLfsUrl.endsWith(".git") ? sourceLfsUrl : `${sourceLfsUrl}.git`;
                await this.gitService.downloadLfsObjectsForPublish(workspacePath, {
                    username: "oauth2",
                    password: gitlabToken,
                }, lfsBaseUrl);
            }

            // Add all files (LFS-aware)
            console.log("Adding files to git (LFS-aware)...");
            await this.gitService.addAllWithLFS(workspacePath, {
                username: "oauth2",
                password: gitlabToken,
            });

            // Restore original media strategy after staging
            if (restoreStrategy) {
                await this.gitService.restoreMediaStrategyAfterPublish(workspacePath, restoreStrategy);
            }

            // Create initial commit
            console.log("Creating initial commit...");
            const user = await this.gitLabService.getCurrentUser();
            await this.gitService.commit(workspacePath, "Initial commit", {
                name: user.name || user.username,
                email: user.email || `${user.username}@users.noreply.gitlab.com`,
            });

            // After creating the initial commit, run a full sync so publish behaves
            // exactly like our normal sync flow (fetch, fast-forward, merge, push).
            const auth = {
                username: "oauth2",
                password: gitlabToken,
            };
            const author = {
                name: user.name || user.username,
                email: user.email || `${user.username}@users.noreply.gitlab.com`,
            };

            console.log("Running full sync as part of publish...");
            const syncResult = await this.gitService.syncChanges(workspacePath, auth, author, {
                commitMessage: "Initial commit",
            });

            if (syncResult.hadConflicts) {
                throw new Error(
                    "Publish encountered merge conflicts with remote. Please resolve conflicts via sync before publishing."
                );
            }

            // Initialize SCM
            console.log("Initializing SCM...");
            await this.initializeSCM(workspacePath);

            // Clear LFS source URL after successful publish
            await this.clearLocalLfsSourceUrl(workspacePath);

            vscode.window.showInformationMessage(
                `Workspace published successfully to ${project.url}`
            );
        } catch (error) {
            console.error("Error in publishWorkspace:", error);
            if (error instanceof Error) {
                const errorMessage = error.message;
                vscode.window.showErrorMessage(`Failed to publish workspace: ${errorMessage}`);
                throw new Error(`Failed to publish workspace: ${errorMessage}`);
            }
            throw error;
        }
    }

    // Add new method to complete merge
    async completeMerge(
        resolvedFiles: ResolvedFile[],
        workspacePath: string | undefined
    ): Promise<void> {
        const token = await this.gitLabService.getToken();
        if (!token) {
            throw new Error("GitLab token not found");
        }

        const auth = {
            username: "oauth2",
            password: token,
        };

        const user = await this.gitLabService.getCurrentUser();
        if (!user) {
            throw new Error("Could not get user information");
        }

        const author = {
            name: user.name || user.username,
            email: user.email || `${user.username}@users.noreply.gitlab.com`,
        };

        if (!workspacePath) {
            workspacePath = this.getWorkspacePath();
        }
        await this.gitService.completeMerge(workspacePath, auth, author, resolvedFiles);
    }
}

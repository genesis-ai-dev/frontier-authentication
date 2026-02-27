// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { FrontierAuthProvider } from "./auth/AuthenticationProvider";
import { registerCommands } from "./commands";
import { registerGitLabCommands } from "./commands/gitlabCommands";
import { registerSCMCommands, getSCMManager } from "./commands/scmCommands";
import {
    registerVersionCheckCommands,
    resetVersionModalCooldown,
} from "./utils/extensionVersionChecker";
import { initialState, StateManager } from "./state";
import { AuthState } from "./types/state";
import { ConflictedFile, GitService as GitServiceClass } from "./git/GitService";
import * as gitBinaryManager from "./git/gitBinaryManager";
import * as dugiteGit from "./git/dugiteGit";
import * as path from "path";

// Module-level gitService instance
let gitServiceInstance: GitServiceClass | undefined;

export function getGitService(): GitServiceClass | undefined {
    return gitServiceInstance;
}

export type MediaFilesStrategy =
    | "auto-download" // Download and save media files automatically
    | "stream-and-save" // Stream media files and save in background
    | "stream-only"; // Stream media files without saving (read from network each time)

export interface FrontierAPI {
    authProvider: FrontierAuthProvider;
    gitLabService: any; // GitLabService instance for remote operations
    getAuthStatus: () => {
        isAuthenticated: boolean;
    };
    onAuthStatusChanged: (
        callback: (status: { isAuthenticated: boolean }) => void
    ) => vscode.Disposable;
    login: (username: string, password: string) => Promise<boolean>;
    register: (username: string, email: string, password: string) => Promise<boolean>;
    logout: () => Promise<void>;
    listProjects: (showUI?: boolean) => Promise<
        Array<{
            id: number;
            name: string;
            description: string | null;
            visibility: string;
            url: string;
            webUrl: string;
            lastActivity: string;
            namespace: string;
            owner: string;
        }>
    >;
    cloneRepository: (
        repositoryUrl: string,
        cloneToPath?: string,
        openWorkspace?: boolean,
        mediaStrategy?: MediaFilesStrategy
    ) => Promise<boolean>;
    /** Store per-repo media strategy preference */
    setRepoMediaStrategy: (workspacePath: string, strategy: MediaFilesStrategy) => Promise<void>;
    publishWorkspace: (options: {
        name?: string;
        description?: string;
        visibility?: "private" | "internal" | "public";
        groupId?: string;
    }) => Promise<void>;
    getUserInfo: () => Promise<{
        email: string;
        username: string;
    }>;
    getLlmEndpoint: () => Promise<string | undefined>;
    getAsrEndpoint: () => Promise<string | undefined>;
    syncChanges: (options?: { commitMessage?: string }) => Promise<{
        hasConflicts: boolean;
        conflicts?: Array<ConflictedFile>;
        offline?: boolean;
        allChangedFilePaths?: string[];
        remoteChangedFilePaths?: string[];
    }>;
    completeMerge: (
        resolvedFiles: ResolvedFile[],
        workspacePath: string | undefined
    ) => Promise<void>;
    onSyncStatusChange: (
        callback: (status: {
            status: "started" | "completed" | "error" | "skipped" | "progress";
            message?: string;
            progress?: {
                phase: string;
                loaded?: number;
                total?: number;
                description?: string;
            };
        }) => void
    ) => vscode.Disposable;

    // Lock management API
    checkSyncLock: () => Promise<{
        exists: boolean;
        isDead: boolean;
        isStuck: boolean;
        age: number;
        progressAge: number;
        pid?: number;
        ownedByUs: boolean;
        phase?: string;
        progress?: { current: number; total: number; description?: string };
        status: "active" | "stuck" | "dead";
    }>;
    cleanupStaleLock: () => Promise<void>;
    checkWorkingCopyState: (workspacePath: string) => Promise<{
        isDirty: boolean;
        status?: any;
    }>;

    /**
     * Download a single LFS file by OID
     * @param projectPath - Path to the git repository
     * @param oid - SHA256 OID of the LFS object
     * @param size - Expected size of the object in bytes
     * @returns Buffer containing the file data
     * @throws Error if not authenticated, no remote URL, or download fails
     */
    downloadLFSFile: (projectPath: string, oid: string, size: number) => Promise<Buffer>;

    /**
     * Get repository tree (list files in a directory) from GitLab
     * @param projectUrl - The git URL of the project
     * @param path - The directory path to list (e.g., ".project/attachments/pointers")
     * @param ref - The branch, tag, or commit SHA (defaults to 'main')
     * @returns Array of file entries with name, path, and type
     */
    getRepositoryTree: (
        projectUrl: string,
        path?: string,
        ref?: string
    ) => Promise<Array<{ name: string; path: string; type: "blob" | "tree" }>>;

    /**
     * Get the path to the dugite-native git binary (downloaded at runtime).
     * Used by codex-editor to share the same binary without downloading again.
     */
    getGitBinaryPath: () => { localGitDir: string; execPath: string } | undefined;
    isGitBinaryAvailable: () => boolean;
    retryGitBinaryDownload: () => Promise<boolean>;
}

export interface ResolvedFile {
    filepath: string;
    resolution: "deleted" | "created" | "modified";
}

let authenticationProvider: FrontierAuthProvider;

function getApiEndpoint(): string {
    const config = vscode.workspace.getConfiguration("frontier");
    return config.get<string>("apiEndpoint") || "https://api.frontierrnd.com/api/v1";
}

const API_ENDPOINT = getApiEndpoint();
// const API_ENDPOINT = "http://localhost:8000/api/v1"; // Use this for local development when the frontier server is running locally

// FIXME: let's gracefully handle offline (block login, for instance)
// TODO: let's display status for the user - cloud sync available, AI online, etc.
// TODO: if the user wants to use an offline LLM, we should check the heartbeat, etc.

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    // Initialize state manager first
    const stateManager = StateManager.initialize(context);

    // Initialize auth provider with state manager
    authenticationProvider = new FrontierAuthProvider(context, API_ENDPOINT, stateManager);

    try {
        await authenticationProvider.initialize();
    } catch (error) {
        console.error("Error initializing authentication provider:", error);
        // Continue anyway, as initialization errors will be handled gracefully
        // and retried with exponential backoff as needed
    }

    // Initialize git binary (downloads dugite-native if needed).
    // Offers the user a manual retry when all automatic attempts are exhausted.
    let gitInitialized = false;
    while (!gitInitialized) {
        try {
            const gitPaths = await gitBinaryManager.ensureGitBinary(context);
            dugiteGit.setGitBinaryPath(gitPaths.localGitDir, gitPaths.execPath);

            const askpassPath = path.join(context.extensionPath, "dist", "askpass.js");
            try {
                await import("fs").then((fsModule) => fsModule.promises.chmod(askpassPath, 0o755));
            } catch {
                // May fail on read-only filesystems; git will fall back gracefully
            }
            dugiteGit.setAskpassPath(askpassPath);

            console.log("[Frontier] Git binary initialized:", gitPaths.localGitDir);
            gitInitialized = true;
        } catch (error) {
            console.error("[Frontier] Failed to initialize git binary:", error);
            const choice = await vscode.window.showErrorMessage(
                "Failed to download the sync runtime. You can still work offline, but syncing " +
                "will be unavailable until the runtime is installed. You can retry from Sync Settings.",
                "Retry Now",
                "Continue Offline",
            );
            if (choice !== "Retry Now") {
                break;
            }
            // Reset resolved paths so ensureGitBinary retries from scratch
            gitBinaryManager.resetResolvedPaths();
        }
    }

    // Create GitService for debug logging control
    const stateManagerInstance = StateManager.getInstance();
    const { GitService } = await import("./git/GitService");
    gitServiceInstance = new GitService(stateManagerInstance);

    // Create GitLab service instance for API exposure
    const { GitLabService } = await import("./gitlab/GitLabService");
    const gitLabService = new GitLabService(authenticationProvider);

    // Register commands - pass gitService for debug toggle
    registerCommands(context, authenticationProvider, gitServiceInstance);
    registerGitLabCommands(context, authenticationProvider);
    registerSCMCommands(context, authenticationProvider);
    registerVersionCheckCommands(context);

    // Store API endpoint for use by other components
    context.globalState.update("frontierApiEndpoint", API_ENDPOINT);

    // Reset version modal cooldown on extension activation
    await resetVersionModalCooldown(context);

    // Create and register status bar item immediately
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBarItem);

    // Update status bar when state changes
    stateManager.onDidChangeState(() => {
        updateStatusBar(statusBarItem, stateManager.getAuthState());
    });

    // Initial status bar update and show
    updateStatusBar(statusBarItem, stateManager.getAuthState());
    statusBarItem.show();

    // Only show activation message if not already authenticated
    if (!authenticationProvider.isAuthenticated) {
        vscode.window.showInformationMessage(
            "Frontier Authentication: Click the status bar icon to log in"
        );
    } else {
        // For existing authenticated users, try to cache user info if not already cached
        setTimeout(() => {
            authenticationProvider.fetchAndCacheUserInfo().catch((error) => {
                console.error("Error caching user info during activation:", error);
            });
        }, 1000); // Small delay to ensure initialization is complete
    }

    // Do not dispose the freshly created authentication provider here.
    // Disposing would unregister its event emitters and prevent VS Code's
    // Accounts UI from receiving session change events (e.g., on logout).

    // Register status bar item
    // Removed redundant registration here

    const frontierAPI: FrontierAPI = {
        // Export the authentication provider for other extensions
        authProvider: authenticationProvider,

        // Export GitLab service for remote operations
        gitLabService: gitLabService,

        // Export convenience methods
        getAuthStatus: () => authenticationProvider.getAuthStatus(),
        onAuthStatusChanged: (callback: (status: { isAuthenticated: boolean }) => void) =>
            authenticationProvider.onAuthStatusChanged(callback),

        // Export direct auth methods
        login: async (username: string, password: string) =>
            vscode.commands.executeCommand(
                "frontier.login",
                username,
                password
            ) as Promise<boolean>,
        register: async (username: string, email: string, password: string) =>
            vscode.commands.executeCommand(
                "frontier.register",
                username,
                email,
                password
            ) as Promise<boolean>,
        logout: async () => vscode.commands.executeCommand("frontier.logout"),
        listProjects: async (showUI = true) =>
            vscode.commands.executeCommand("frontier.listProjects", {
                showUI,
            }) as Promise<
                Array<{
                    id: number;
                    name: string;
                    description: string | null;
                    visibility: string;
                    url: string;
                    webUrl: string;
                    lastActivity: string;
                    namespace: string;
                    owner: string;
                }>
            >,
        cloneRepository: async (
            repositoryUrl: string,
            cloneToPath?: string,
            openWorkspace?: boolean,
            mediaStrategy?: MediaFilesStrategy
        ) =>
            vscode.commands.executeCommand<boolean>(
                "frontier.cloneRepository",
                repositoryUrl,
                cloneToPath,
                openWorkspace,
                mediaStrategy
            ),
        publishWorkspace: async (options: {
            name?: string;
            description?: string;
            visibility?: "private" | "internal" | "public";
            groupId?: string;
        }) => {
            try {
                await vscode.commands.executeCommand("frontier.publishWorkspace", {
                    ...options,
                });
            } catch (error: unknown) {
                throw error;
            }
        },
        getUserInfo: async () => {
            const { isAuthenticated } = authenticationProvider.getAuthStatus();
            if (isAuthenticated) {
                return vscode.commands.executeCommand("frontier.getUserInfo") as Promise<{
                    email: string;
                    username: string;
                }>;
            } else {
                return {
                    email: "",
                    username: "",
                };
            }
        },
        getLlmEndpoint: async () => {
            return API_ENDPOINT;
        },
        getAsrEndpoint: async () => {
            if (!authenticationProvider.isAuthenticated) {
                return undefined;
            }
            const url = new URL(API_ENDPOINT);
            url.pathname = "/api/v1/asr/transcribe";
            url.searchParams.set("source", "codex");
            return url.toString();
        },
        syncChanges: async (options?: { commitMessage?: string }) =>
            vscode.commands.executeCommand("frontier.syncChanges", options) as Promise<{
                hasConflicts: boolean;
                conflicts?: Array<ConflictedFile>;
                offline?: boolean;
                blocked?: boolean;
            }>,
        completeMerge: async (resolvedFiles: ResolvedFile[], workspacePath: string | undefined) =>
            vscode.commands.executeCommand(
                "frontier.completeMerge",
                resolvedFiles,
                workspacePath
            ) as Promise<void>,
        onSyncStatusChange: (
            callback: (status: {
                status: "started" | "completed" | "error" | "skipped" | "progress";
                message?: string;
                progress?: {
                    phase: string;
                    loaded?: number;
                    total?: number;
                    description?: string;
                };
            }) => void
        ) => {
            const scmManager = getSCMManager();
            if (!scmManager) {
                console.warn(
                    "SCMManager not initialized, sync status events will not be available"
                );
                return { dispose: () => {} };
            }
            return scmManager.onSyncStatusChange(callback);
        },

        // Lock management API
        checkSyncLock: async () => {
            const stateManager = StateManager.getInstance();
            return await stateManager.checkFilesystemLock();
        },
        cleanupStaleLock: async () => {
            const stateManager = StateManager.getInstance();
            await stateManager.cleanupStaleLock();
        },
        checkWorkingCopyState: async (workspacePath: string) => {
            const gitService = getGitService();
            if (!gitService) {
                return { isDirty: false };
            }
            const state = await gitService.getWorkingCopyState(workspacePath);
            return { isDirty: state.isDirty, status: state.status };
        },

        downloadLFSFile: async (
            projectPath: string,
            oid: string,
            size: number
        ): Promise<Buffer> => {
            // Import GitService and downloadLFSObject
            const { GitService } = await import("./git/GitService");
            const gitService = new GitService(stateManager);

            // Validate inputs
            if (!projectPath) {
                throw new Error("Project path is required");
            }
            if (!oid || !/^[a-f0-9]{64}$/i.test(oid)) {
                throw new Error("Invalid OID format (expected 64-character hex string)");
            }
            if (!size || size <= 0) {
                throw new Error("Invalid size (must be positive number)");
            }

            // Get remote URL
            const remoteUrl = await gitService.getRemoteUrl(projectPath);
            if (!remoteUrl) {
                throw new Error(
                    "No remote URL found for project. This project may not be connected to a remote repository."
                );
            }

            // Parse URL and prepare auth
            const { GitService: GitServiceStatic } = await import("./git/GitService");
            const { cleanUrl, auth: embedded } = GitServiceStatic.parseGitUrl(remoteUrl);
            const lfsBaseUrl = cleanUrl.endsWith(".git") ? cleanUrl : `${cleanUrl}.git`;

            // Prefer embedded auth in remote URL if present; otherwise, fetch token from GitLabService
            let auth: { username?: string; password?: string; token?: string } | undefined =
                embedded;
            if (!auth || !auth.password) {
                try {
                    const { GitLabService } = await import("./gitlab/GitLabService");
                    const gl = new GitLabService(authenticationProvider);
                    // Ensure service is initialized (handles retries)
                    await gl.initializeWithRetry?.();
                    const token = await gl.getToken();
                    if (!token) {
                        throw new Error(
                            "Not authenticated. Please log in to download media files."
                        );
                    }
                    auth = { username: "oauth2", password: token };
                } catch (e) {
                    throw new Error("Not authenticated. Please log in to download media files.");
                }
            }

            // Download LFS object using the internal function
            // We need to import and call downloadLFSObject directly
            const { downloadLFSObject } = await import("./git/GitService");

            try {
                const bytes = await downloadLFSObject(
                    {
                        url: lfsBaseUrl,
                        headers: {},
                        auth,
                    },
                    { oid, size }
                );

                return Buffer.from(bytes);
            } catch (error) {
                // Provide more context in error message
                const errorMsg = error instanceof Error ? error.message : String(error);

                if (errorMsg.includes("404") || errorMsg.includes("not found")) {
                    throw new Error(
                        `Media file not found on server (OID: ${oid.substring(0, 8)}...)`
                    );
                } else if (errorMsg.includes("401") || errorMsg.includes("403")) {
                    throw new Error("Authentication failed. Please log in again.");
                } else if (errorMsg.includes("timeout") || errorMsg.includes("ETIMEDOUT")) {
                    throw new Error("Download timed out. Please check your internet connection.");
                } else {
                    throw new Error(`Failed to download media file: ${errorMsg}`);
                }
            }
        },

        getRepositoryTree: async (
            projectUrl: string,
            path: string = "",
            ref: string = "main"
        ): Promise<Array<{ name: string; path: string; type: "blob" | "tree" }>> => {
            try {
                // Extract project path from URL
                // URL format: https://gitlab.com/group/subgroup/project.git
                // Need to extract everything after the domain: group/subgroup/project
                const cleanUrl = projectUrl.replace(/\.git$/, "");
                const urlObj = new URL(cleanUrl);
                // pathname is /group/subgroup/project, remove leading slash
                const projectPath = urlObj.pathname.replace(/^\//, "");
                
                console.log(`[FrontierAPI] getRepositoryTree: projectPath=${projectPath}, treePath=${path}`);
                
                const tree = await gitLabService.getRepositoryTree(projectPath, path, ref);
                return tree.map((item: { name: string; path: string; type: string }) => ({
                    name: item.name,
                    path: item.path,
                    type: item.type as "blob" | "tree",
                }));
            } catch (error) {
                console.error("Error fetching repository tree:", error);
                return [];
            }
        },

        setRepoMediaStrategy: async (
            workspacePath: string,
            strategy: MediaFilesStrategy
        ): Promise<void> => {
            try {
                await stateManager.setRepoStrategy(workspacePath, strategy);
            } catch (e) {
                console.warn("Failed to set repo media strategy:", e);
                throw e;
            }
        },

        getGitBinaryPath: () => gitBinaryManager.getResolvedPath(),

        isGitBinaryAvailable: () => gitBinaryManager.getResolvedPath() !== undefined,

        retryGitBinaryDownload: async (): Promise<boolean> => {
            try {
                gitBinaryManager.resetResolvedPaths();
                const gitPaths = await gitBinaryManager.ensureGitBinary(context);
                dugiteGit.setGitBinaryPath(gitPaths.localGitDir, gitPaths.execPath);
                console.log("[Frontier] Git binary downloaded via retry:", gitPaths.localGitDir);
                return true;
            } catch (error) {
                console.error("[Frontier] Git binary retry failed:", error);
                return false;
            }
        },
    };

    return frontierAPI;
}

function updateStatusBar(statusBarItem: vscode.StatusBarItem, authState: AuthState) {
    if (authState.isAuthenticated) {
        statusBarItem.text = "$(check) Frontier: Logged In";
        statusBarItem.tooltip = "Click to log out";
        statusBarItem.command = "frontier.logout";
    } else {
        statusBarItem.text = "$(sign-in) Frontier: Sign In";
        statusBarItem.tooltip = "Click to log in";
        statusBarItem.command = "frontier.login";
    }
    statusBarItem.show(); // Always show the status bar item
}

// This method is called when your extension is deactivated
export async function deactivate() {
    console.log("[Frontier] Extension deactivating...");

    try {
        const stateManager = StateManager.getInstance();
        await stateManager.releaseSyncLock();
        console.log("[Frontier] Released sync lock on deactivation");
    } catch (error) {
        console.error("[Frontier] Error releasing sync lock on deactivation:", error);
    }

    if (authenticationProvider !== undefined) {
        authenticationProvider.dispose();
    }
}

// Expose the current auth provider instance for internal utilities/commands
export function getAuthProviderInstance(): FrontierAuthProvider | undefined {
    return authenticationProvider;
}

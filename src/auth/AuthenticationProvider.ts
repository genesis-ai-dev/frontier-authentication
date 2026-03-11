import * as vscode from "vscode";
import { StateManager } from "../state";
import { UserInfo } from "../types/state";

// Add interface for token response
interface TokenResponse {
    access_token: string;
    token_type: string;
    gitlab_token: string;
    gitlab_url: string;
}

// Add interface for stored session data
interface FrontierSessionData {
    accessToken: string;
    gitlabToken: string;
    gitlabUrl: string;
}

// Add at the top of the file with other interfaces
interface ExtendedAuthSession extends vscode.AuthenticationSession {
    gitlabToken?: string;
    gitlabUrl?: string;
}

// Define a type for the outcome of token validation
interface TokenValidityResult {
    isValid: boolean;
    isNetworkError: boolean; // True if the failure was due to network/server issues, not explicit invalidation
    isInvalidAuth: boolean; // True if server responded with 401 or 403
    userInfo?: any; // User information from /auth/me endpoint
}

export class FrontierAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
    private static readonly AUTH_TYPE = "frontier";
    private static readonly AUTH_NAME = "Frontier Authentication";

    private static readonly SESSION_SECRET_KEY = "frontier-session-data";

    private _onDidChangeSessions =
        new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    readonly onDidChangeSessions = this._onDidChangeSessions.event;

    private _sessions: ExtendedAuthSession[] = [];
    private _initialized = false;
    private initializePromise: Promise<void> | null = null;

    private _onDidChangeAuthentication = new vscode.EventEmitter<void>();
    readonly onDidChangeAuthentication = this._onDidChangeAuthentication.event;

    private readonly stateManager: StateManager;

    // Connectivity-based revalidation tracking
    private _needsConnectivityRevalidation = false;
    private _connectivityCheckInterval: NodeJS.Timeout | null = null;
    private _lastRevalidationTime = 0;
    private static readonly REVALIDATION_DEBOUNCE_MS = 5000; // 5 seconds
    private static readonly CONNECTIVITY_CHECK_INTERVAL_MS = 30000; // 30 seconds

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly apiEndpoint: string,
        stateManager: StateManager
    ) {
        this.stateManager = stateManager;

        // Register the auth provider
        context.subscriptions.push(
            vscode.authentication.registerAuthenticationProvider(
                FrontierAuthProvider.AUTH_TYPE,
                FrontierAuthProvider.AUTH_NAME,
                this
            )
        );
    }

    public async initialize(): Promise<void> {
        if (this.initializePromise) {
            return this.initializePromise;
        }

        this.initializePromise = (async () => {
            let sessionDataStr: string | undefined;
            let sessionData: FrontierSessionData | undefined;
            let parseError = false;

            try {
                sessionDataStr = await this.context.secrets.get(
                    FrontierAuthProvider.SESSION_SECRET_KEY
                );

                if (sessionDataStr) {
                    try {
                        sessionData = JSON.parse(sessionDataStr);
                    } catch (jsonError) {
                        // Corrupted session data - this IS a reason to clear the session
                        console.error("Failed to parse stored session data (corrupted):", jsonError);
                        parseError = true;
                    }
                }
            } catch (secretsError) {
                // Error accessing secrets storage - this is NOT a reason to clear the session
                // The secrets might just be temporarily unavailable during extension reload
                console.error("Failed to access secrets storage:", secretsError);
                // Continue without session - don't clear anything
            }

            // If we had a parse error, clear the corrupted data
            if (parseError) {
                try {
                    await this.context.secrets.delete(FrontierAuthProvider.SESSION_SECRET_KEY);
                    console.log("Cleared corrupted session data");
                } catch (deleteError) {
                    console.error("Failed to delete corrupted session data:", deleteError);
                }
                this._sessions = [];
                await this.stateManager.updateAuthState({
                    isAuthenticated: false,
                    gitlabCredentials: undefined,
                    gitlabInfo: undefined,
                    userInfo: undefined,
                });
                this._initialized = true;
                return;
            }

            if (sessionData) {
                // We have valid session data - restore the session optimistically
                // Network errors during validation should NOT clear the session
                let userLabel = "Frontier User";
                let userInfo = undefined;
                let shouldClearSession = false;
                let hadNetworkError = false;

                try {
                    const validity = await this.checkTokenValidity(sessionData.accessToken);
                    if (validity.isValid && validity.userInfo) {
                        userLabel = this.getUserDisplayName(validity.userInfo);
                        // Cache user info for offline access
                        userInfo = {
                            email: validity.userInfo.email || "",
                            username: validity.userInfo.username || userLabel,
                            name: validity.userInfo.name,
                        };
                    } else if (validity.isInvalidAuth) {
                        // Server explicitly rejected the token (401/403) - clear session
                        console.log("Token explicitly rejected by server, will clear session");
                        shouldClearSession = true;
                    } else if (validity.isNetworkError) {
                        // Network error - mark for revalidation when connectivity is restored
                        hadNetworkError = true;
                    }
                } catch (error) {
                    // Network or other transient error - keep the session for offline access
                    console.warn("Could not validate token during initialization (keeping session):", error);
                    hadNetworkError = true;
                }

                if (shouldClearSession) {
                    // Token was explicitly invalidated by server - clear everything
                    try {
                        await this.context.secrets.delete(FrontierAuthProvider.SESSION_SECRET_KEY);
                    } catch (deleteError) {
                        console.error("Failed to delete invalid session:", deleteError);
                    }
                    this._sessions = [];
                    await this.stateManager.updateAuthState({
                        isAuthenticated: false,
                        gitlabCredentials: undefined,
                        gitlabInfo: undefined,
                        userInfo: undefined,
                    });
                    // Note: No need to fire session change events here since no sessions
                    // were added yet during this initialization flow
                } else {
                    // Restore the session (even if we couldn't validate - for offline support)
                    this._sessions = [
                        {
                            id: "frontier-session",
                            accessToken: sessionData.accessToken,
                            account: {
                                id: "frontier-user",
                                label: userLabel,
                            },
                            scopes: ["token"],
                            gitlabToken: sessionData.gitlabToken,
                            gitlabUrl: sessionData.gitlabUrl,
                        },
                    ];

                    await this.stateManager.updateAuthState({
                        isAuthenticated: true,
                        gitlabCredentials: {
                            token: sessionData.gitlabToken,
                            url: sessionData.gitlabUrl,
                        },
                        userInfo: userInfo, // Cache user info for offline access
                        // gitlabInfo will be updated by verifyAndRefreshSessionDetails
                    });

                    this._onDidChangeSessions.fire({
                        added: this._sessions,
                        removed: [],
                        changed: [],
                    });
                    this._onDidChangeAuthentication.fire();

                    // Start background verification and automatic session refresh
                    this.verifyAndRefreshSessionDetails(sessionData.accessToken).catch((error) => {
                        console.error("Error during background session verification:", error);
                    });

                    // Automatically refresh session to ensure correct username and clean up duplicates
                    setTimeout(() => {
                        this.autoRefreshSessionWithUserInfo(sessionData.accessToken).catch(
                            (error) => {
                                console.error("Error during automatic session refresh:", error);
                            }
                        );
                    }, 2000); // Delay to ensure VS Code has processed the session

                    // Fallback: cache user info if it wasn't cached during init (e.g., network was down)
                    // This has an early-return if userInfo is already cached, so it's essentially free
                    setTimeout(() => {
                        this.fetchAndCacheUserInfo().catch((error) => {
                            console.error("Error during user info caching:", error);
                        });
                    }, 3000);

                    // If we had a network error during init, start periodic connectivity check
                    // This allows revalidation even when webviews aren't open
                    if (hadNetworkError) {
                        this._needsConnectivityRevalidation = true;
                        this.startConnectivityCheck();
                        console.log("Started periodic connectivity check for session revalidation");
                    }
                }
            } else {
                // No stored session, ensure state is clean
                await this.stateManager.updateAuthState({
                    isAuthenticated: false,
                    gitlabCredentials: undefined,
                    gitlabInfo: undefined,
                    userInfo: undefined,
                });
            }

            this._initialized = true;
        })();

        return this.initializePromise;
    }

    private getUserDisplayName(userInfo: any): string {
        // Try to get the best display name from user info
        if (userInfo?.username) {
            return userInfo.username;
        } else if (userInfo?.email) {
            return userInfo.email;
        } else if (userInfo?.name) {
            return userInfo.name;
        }
        // Fallback to generic name if no user info available
        return "Frontier User";
    }

    private async checkTokenValidity(
        token: string
    ): Promise<TokenValidityResult & { userInfo?: any }> {
        try {
            const response = await fetch(`${this.apiEndpoint}/auth/me`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                },
            });

            if (response.ok) {
                const userInfo = await response.json();
                return { isValid: true, isNetworkError: false, isInvalidAuth: false, userInfo };
            } else if (response.status === 401 || response.status === 403) {
                console.warn(`Token validation failed with status: ${response.status}`);
                return { isValid: false, isNetworkError: false, isInvalidAuth: true };
            } else {
                // Other HTTP errors are treated as network/server issues for now
                console.error(
                    `Token validation encountered server error: ${response.status}`,
                    await response.text()
                );
                return { isValid: false, isNetworkError: true, isInvalidAuth: false };
            }
        } catch (error) {
            console.error("Token validation failed due to network error:", error);
            return { isValid: false, isNetworkError: true, isInvalidAuth: false };
        }
    }

    private async verifyAndRefreshSessionDetails(accessToken: string): Promise<void> {
        const validity = await this.checkTokenValidity(accessToken);

        if (!validity.isValid) {
            if (validity.isInvalidAuth) {
                // Token is explicitly invalid (401/403), clear the session
                console.log("Authentication token is invalid. Clearing session.");
                await this.context.secrets.delete(FrontierAuthProvider.SESSION_SECRET_KEY);
                const removedSessions = this._sessions;
                this._sessions = [];
                await this.stateManager.updateAuthState({
                    isAuthenticated: false,
                    gitlabCredentials: undefined,
                    gitlabInfo: undefined, // Ensure cleared here as well
                    userInfo: undefined, // Clear cached user info
                });
                if (removedSessions.length > 0) {
                    this._onDidChangeSessions.fire({
                        added: [],
                        removed: removedSessions,
                        changed: [],
                    });
                    this._onDidChangeAuthentication.fire();
                }
            } else if (validity.isNetworkError) {
                // Network error, keep the cached session for now.
                console.warn(
                    "Network error during token validation. Keeping cached session for now."
                );
            }
            return; // Stop further processing if token is not valid or network error
        }

        // Token is valid. Update session with user info if available
        if (this._sessions.length > 0 && validity.userInfo) {
            const userLabel = this.getUserDisplayName(validity.userInfo);
            if (userLabel !== this._sessions[0].account.label && userLabel !== "Frontier User") {
                // Remove the old session and create a new one with updated info
                const oldSession = this._sessions[0];
                const updatedSession = {
                    ...oldSession,
                    account: {
                        ...oldSession.account,
                        label: userLabel,
                    },
                };

                this._sessions = [updatedSession];
                this._onDidChangeSessions.fire({
                    added: [updatedSession],
                    removed: [oldSession],
                    changed: [],
                });
            }

            // Update cached user info for offline access
            const userInfo = {
                email: validity.userInfo.email || "",
                username: validity.userInfo.username || userLabel,
                name: validity.userInfo.name,
            };

            await this.stateManager.updateAuthState({
                isAuthenticated: true, // Reaffirm authentication
                gitlabInfo: undefined, // Explicitly set to undefined as we are no longer fetching it.
                userInfo: userInfo, // Update cached user info
            });
        } else {
            // Token is valid but no user info available, just reaffirm authentication
            await this.stateManager.updateAuthState({
                isAuthenticated: true, // Reaffirm authentication
                gitlabInfo: undefined, // Explicitly set to undefined as we are no longer fetching it.
            });
        }
        // If no session exists here but token was valid (e.g. called directly after a token set but before session obj update),
        // the primary session creation/update flows in login/setTokens/initialize handle state updates.
        // This function primarily ensures that for an *existing, validated* session, gitlabInfo is cleared and userInfo is updated.
    }

    // Update getSessions to ensure initialization is complete
    async getSessions(): Promise<vscode.AuthenticationSession[]> {
        if (!this._initialized) {
            await this.initialize();
        }
        return [...this._sessions];
    }

    async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
        // This would be where you implement your login flow
        // For now, we'll just throw as this should be handled by your webview
        throw new Error("Please use the login button in the Frontier sidebar to sign in");
    }

    async removeSession(sessionId: string): Promise<void> {
        // Remove ALL sessions to prevent duplicates, not just the matching one
        if (this._sessions.length > 0) {
            const removed = [...this._sessions];
            this._sessions = [];
            await this.context.secrets.delete(FrontierAuthProvider.SESSION_SECRET_KEY);
            this._onDidChangeSessions.fire({ added: [], removed, changed: [] });
            this._onDidChangeAuthentication.fire();
            // Also clear from state manager
            await this.stateManager.updateAuthState({
                isAuthenticated: false,
                gitlabCredentials: undefined,
                gitlabInfo: undefined,
            });
        }
    }

    // Helper methods for your extension to use
    get isAuthenticated(): boolean {
        return this._sessions.length > 0;
    }

    async getToken(): Promise<string | undefined> {
        if (!this._initialized) {
            await this.initialize();
        }
        return this._sessions[0]?.accessToken;
    }

    async setToken(token: string): Promise<void> {
        try {
            await this.context.secrets.store("auth-token", token);

            // Try to get user info for proper display name
            let userLabel = "Frontier User";
            try {
                const validity = await this.checkTokenValidity(token);
                if (validity.isValid && validity.userInfo) {
                    userLabel = this.getUserDisplayName(validity.userInfo);
                }
            } catch (error) {
                console.warn("Could not fetch user info for display name:", error);
            }

            // Remove existing sessions to prevent duplicates
            const removedSessions = [...this._sessions];

            const session: vscode.AuthenticationSession = {
                id: "frontier-session",
                accessToken: token,
                account: {
                    id: "frontier-user",
                    label: userLabel,
                },
                scopes: ["token"],
            };

            this._sessions = [session];
            this._onDidChangeSessions.fire({
                added: [session],
                removed: removedSessions,
                changed: [],
            });
            this._onDidChangeAuthentication.fire();
        } catch (error) {
            console.error("Failed to store authentication token:", error);
            throw new Error("Failed to save login session");
        }
    }

    async logout(): Promise<void> {
        await this.removeSession("frontier-session");
        await this.stateManager.updateAuthState({
            isAuthenticated: false,
            gitlabInfo: undefined,
            userInfo: undefined, // Clear cached user info on logout
        });
    }

    async login(username: string, password: string): Promise<boolean> {
        try {
            const formData = new URLSearchParams({
                username: username,
                password: password,
                grant_type: "password",
                scope: "",
            });

            const response = await fetch(`${this.apiEndpoint}/auth/token`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "application/json",
                },
                body: formData,
            });

            if (!response.ok) {
                return false;
            }

            const result = await response.json();

            // Validate required fields
            if (!result.gitlab_token || !result.gitlab_url) {
                throw new Error("Invalid server response: missing GitLab credentials");
            }

            // Store all tokens with user info
            await this.setTokens(result, username);

            // Get state manager instance and update GitLab credentials
            await this.stateManager.updateGitLabCredentials({
                token: result.gitlab_token,
                url: result.gitlab_url,
            });

            // Auto-refresh session to ensure clean state for users
            setTimeout(() => {
                this.autoRefreshSessionWithUserInfo(result.access_token).catch((error) => {
                    console.error("Error during post-login session refresh:", error);
                });
            }, 1000);

            return true;
        } catch (error) {
            console.error("Login error:", error);
            return false;
        }
    }

    private validatePassword(password: string) {
        if (password.length < 8) {
            throw new Error("Password must be at least 8 characters long");
        }
        // Add any other password validation rules here
    }

    private async handleResponse<T>(response: Response): Promise<T> {
        if (!response.ok) {
            const errorText = await response.text();
            const error = new Error(
                `Request failed with status ${response.status}: ${errorText || "Server returned an error"}`
            ) as any;
            error.status = response.status;
            error.errorText = errorText; // Store original error text if needed later
            throw error;
        }
        return response.json();
    }

    async register(username: string, email: string, password: string): Promise<boolean> {
        try {
            this.validatePassword(password);

            const response = await fetch(`${this.apiEndpoint}/auth/register`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({
                    username,
                    email,
                    password,
                }),
            });

            const result = await this.handleResponse<TokenResponse>(response);

            // Validate required fields
            if (!result.gitlab_token || !result.gitlab_url) {
                throw new Error("Invalid server response: missing GitLab credentials");
            }

            // Store all tokens with user info
            await this.setTokens(result, username);

            // Get state manager instance and update GitLab credentials
            await this.stateManager.updateGitLabCredentials({
                token: result.gitlab_token,
                url: result.gitlab_url,
            });

            // Auto-refresh session to ensure clean state for users
            setTimeout(() => {
                this.autoRefreshSessionWithUserInfo(result.access_token).catch((error) => {
                    console.error("Error during post-registration session refresh:", error);
                });
            }, 1000);

            // Fetch GitLab info and update state
            // await this.fetchGitLabInfo(); // NOTE: now we just access gitlab directly with the user's gitlab token create during registration, so we don't need this anymore.

            return true;
        } catch (error) {
            console.error("Registration error:", error);
            throw error; // Re-throw to let the command handler show the error
        }
    }

    getAuthStatus(): { isAuthenticated: boolean; gitlabInfo?: any } {
        return {
            isAuthenticated: this.isAuthenticated,
            gitlabInfo: this.stateManager.getAuthState().gitlabInfo,
        };
    }

    onAuthStatusChanged(
        callback: (status: { isAuthenticated: boolean; gitlabInfo?: any }) => void
    ): vscode.Disposable {
        return this._onDidChangeAuthentication.event(() => {
            callback(this.getAuthStatus());
        });
    }

    /**
     * Automatically refresh session with user info to ensure correct username and clean up duplicates
     * This runs in the background to fix authentication display issues without user intervention
     */
    private async autoRefreshSessionWithUserInfo(accessToken: string): Promise<void> {
        // Check if auto-refresh is enabled
        const config = vscode.workspace.getConfiguration("frontier");
        const autoRefreshEnabled = config.get<boolean>("autoRefreshAuthSessions", true);

        if (!autoRefreshEnabled) {
            console.log("Auto-refresh of authentication sessions is disabled");
            return;
        }

        try {
            // Get user info from the API
            const validity = await this.checkTokenValidity(accessToken);

            if (!validity.isValid || !validity.userInfo) {
                console.log("Cannot auto-refresh session: invalid token or no user info");
                return;
            }

            const userLabel = this.getUserDisplayName(validity.userInfo);

            // Only refresh if we need to update the username (avoid "Frontier User" entries)
            if (userLabel !== "Frontier User" && this._sessions.length > 0) {
                const currentLabel = this._sessions[0].account.label;

                // If current label is "Frontier User" or we have duplicates, refresh the session
                if (currentLabel === "Frontier User" || this._sessions.length > 1) {
                    console.log(`Auto-refreshing session: "${currentLabel}" → "${userLabel}"`);

                    // Clear all existing sessions and create a fresh one
                    const removedSessions = [...this._sessions];

                    const refreshedSession: ExtendedAuthSession = {
                        id: "frontier-session",
                        accessToken: accessToken,
                        account: {
                            id: "frontier-user",
                            label: userLabel,
                        },
                        scopes: ["token"],
                        gitlabToken: (this._sessions[0] as any)?.gitlabToken,
                        gitlabUrl: (this._sessions[0] as any)?.gitlabUrl,
                    };

                    this._sessions = [refreshedSession];

                    this._onDidChangeSessions.fire({
                        added: [refreshedSession],
                        removed: removedSessions,
                        changed: [],
                    });

                    // Update cached user info during auto-refresh
                    const userInfo = {
                        email: validity.userInfo.email || "",
                        username: validity.userInfo.username || userLabel,
                        name: validity.userInfo.name,
                    };

                    await this.stateManager.updateAuthState({
                        userInfo: userInfo,
                    });

                    console.log(`Session auto-refreshed successfully with username: ${userLabel}`);
                }
            }
        } catch (error) {
            console.warn("Auto-refresh session failed:", error);
        }
    }

    /**
     * Clean up any duplicate sessions that might exist
     * This helps fix the issue where VS Code shows multiple authentication entries
     */
    async cleanupDuplicateSessions(): Promise<void> {
        if (this._sessions.length <= 1) {
            return; // No duplicates to clean up
        }

        // Keep only the first session and remove the rest
        const sessionToKeep = this._sessions[0];
        const sessionsToRemove = this._sessions.slice(1);

        this._sessions = [sessionToKeep];

        this._onDidChangeSessions.fire({
            added: [],
            removed: sessionsToRemove,
            changed: [],
        });

        console.log(`Cleaned up ${sessionsToRemove.length} duplicate session(s)`);
    }

    /**
     * Fetch and cache user info for authenticated users who don't have it cached yet
     * This helps users who were authenticated before we added user info caching
     */
    async fetchAndCacheUserInfo(): Promise<void> {
        if (!this.isAuthenticated) {
            return;
        }

        const currentUserInfo = this.stateManager.getUserInfo();
        if (currentUserInfo) {
            return; // Already cached
        }

        try {
            const token = await this.getToken();
            if (token) {
                const validity = await this.checkTokenValidity(token);
                if (validity.isValid && validity.userInfo) {
                    const userInfo: UserInfo = {
                        email: validity.userInfo.email || "",
                        username:
                            validity.userInfo.username ||
                            this.getUserDisplayName(validity.userInfo),
                        name: validity.userInfo.name,
                    };

                    await this.stateManager.updateAuthState({
                        userInfo: userInfo,
                    });

                    console.log("User info fetched and cached for existing authenticated user");
                }
            }
        } catch (error) {
            console.warn("Could not fetch user info for caching:", error);
            // Don't throw - this is a background enhancement
        }
    }

    /**
     * Re-validate session when connectivity is restored.
     * Called by webview when network status changes from offline to online,
     * or by periodic connectivity check when webviews aren't open.
     * - If token is valid: cache userInfo if missing, stop connectivity checks
     * - If token is explicitly invalid (401/403): clear the session
     * - If network error: do nothing (transient issue, keep checking)
     */
    async revalidateSessionOnConnectivityRestored(): Promise<void> {
        // Debounce: ignore if we revalidated recently
        const now = Date.now();
        if (now - this._lastRevalidationTime < FrontierAuthProvider.REVALIDATION_DEBOUNCE_MS) {
            console.log("Skipping revalidation - debounced (too recent)");
            return;
        }
        this._lastRevalidationTime = now;

        if (!this.isAuthenticated || this._sessions.length === 0) {
            console.log("Connectivity restored but no session to revalidate");
            this._needsConnectivityRevalidation = false;
            this.stopConnectivityCheck();
            return;
        }

        console.log("Connectivity restored - revalidating session...");

        try {
            const token = await this.getToken();
            if (!token) {
                console.warn("No token available for revalidation");
                return;
            }

            const validity = await this.checkTokenValidity(token);

            if (validity.isValid && validity.userInfo) {
                // Token is valid - cache user info if not already cached
                const currentUserInfo = this.stateManager.getUserInfo();
                if (!currentUserInfo) {
                    const userInfo: UserInfo = {
                        email: validity.userInfo.email || "",
                        username:
                            validity.userInfo.username ||
                            this.getUserDisplayName(validity.userInfo),
                        name: validity.userInfo.name,
                    };

                    await this.stateManager.updateAuthState({
                        userInfo: userInfo,
                    });

                    console.log("Session revalidated and user info cached after connectivity restored");
                } else {
                    console.log("Session revalidated successfully after connectivity restored");
                }

                // Also update session label if needed (e.g., was "Frontier User" due to offline init)
                if (this._sessions[0].account.label === "Frontier User") {
                    const userLabel = this.getUserDisplayName(validity.userInfo);
                    if (userLabel !== "Frontier User") {
                        await this.autoRefreshSessionWithUserInfo(token);
                    }
                }

                // Success! Stop the connectivity check
                this._needsConnectivityRevalidation = false;
                this.stopConnectivityCheck();
            } else if (validity.isInvalidAuth) {
                // Token was explicitly rejected by server (401/403) - user may have been
                // logged out server-side while offline. Clear the session.
                console.log("Token rejected by server after connectivity restored - clearing session");

                // Stop connectivity checks since we're clearing the session
                this._needsConnectivityRevalidation = false;
                this.stopConnectivityCheck();

                try {
                    await this.context.secrets.delete(FrontierAuthProvider.SESSION_SECRET_KEY);
                } catch (deleteError) {
                    console.error("Failed to delete invalid session:", deleteError);
                }

                const removedSessions = [...this._sessions];
                this._sessions = [];

                await this.stateManager.updateAuthState({
                    isAuthenticated: false,
                    gitlabCredentials: undefined,
                    gitlabInfo: undefined,
                    userInfo: undefined,
                });

                this._onDidChangeSessions.fire({
                    added: [],
                    removed: removedSessions,
                    changed: [],
                });
                this._onDidChangeAuthentication.fire();

                // Notify user that they need to log in again
                vscode.window.showWarningMessage(
                    "Your session has expired. Please log in again."
                );
            } else if (validity.isNetworkError) {
                // Network error even though we thought we were online - transient issue
                // Keep the connectivity check running
                console.log("Network error during revalidation - will retry later");
            }
        } catch (error) {
            console.warn("Error during session revalidation after connectivity restored:", error);
            // Don't throw - this is a background operation
        }
    }

    /**
     * Start periodic connectivity check to revalidate session when network returns.
     * This is a fallback for when webviews aren't open to detect connectivity changes.
     */
    private startConnectivityCheck(): void {
        // Don't start if already running
        if (this._connectivityCheckInterval) {
            return;
        }

        this._connectivityCheckInterval = setInterval(async () => {
            if (!this._needsConnectivityRevalidation) {
                this.stopConnectivityCheck();
                return;
            }

            console.log("Periodic connectivity check - attempting revalidation...");
            await this.revalidateSessionOnConnectivityRestored();
        }, FrontierAuthProvider.CONNECTIVITY_CHECK_INTERVAL_MS);
    }

    /**
     * Stop the periodic connectivity check.
     */
    private stopConnectivityCheck(): void {
        if (this._connectivityCheckInterval) {
            clearInterval(this._connectivityCheckInterval);
            this._connectivityCheckInterval = null;
            console.log("Stopped periodic connectivity check");
        }
    }

    dispose() {
        this.stopConnectivityCheck();
        this._onDidChangeSessions.dispose();
        this._onDidChangeAuthentication.dispose();
    }

    // Add methods to get GitLab credentials
    async getGitLabToken(): Promise<string | undefined> {
        return (this._sessions[0] as any)?.gitlabToken;
    }

    async getGitLabUrl(): Promise<string | undefined> {
        return (this._sessions[0] as any)?.gitlabUrl;
    }

    async setTokens(tokenResponse: TokenResponse, username?: string): Promise<void> {
        try {
            const sessionData: FrontierSessionData = {
                accessToken: tokenResponse.access_token,
                gitlabToken: tokenResponse.gitlab_token,
                gitlabUrl: tokenResponse.gitlab_url,
            };

            // Store all session data as JSON string
            await this.context.secrets.store(
                FrontierAuthProvider.SESSION_SECRET_KEY,
                JSON.stringify(sessionData)
            );

            // Try to get user info to set proper display name and cache it
            let userLabel = username || "Frontier User";
            let userInfo = undefined;
            if (!username) {
                try {
                    const validity = await this.checkTokenValidity(tokenResponse.access_token);
                    if (validity.isValid && validity.userInfo) {
                        userLabel = this.getUserDisplayName(validity.userInfo);
                        // Cache the user info for offline use
                        userInfo = {
                            email: validity.userInfo.email || "",
                            username: validity.userInfo.username || userLabel,
                            name: validity.userInfo.name,
                        };
                    }
                } catch (error) {
                    console.warn("Could not fetch user info for display name:", error);
                }
            } else {
                // If username was provided directly (e.g., from registration), cache it
                userInfo = {
                    email: "", // Will be updated when token validation succeeds
                    username: username,
                };
            }

            const session: ExtendedAuthSession = {
                id: "frontier-session",
                accessToken: tokenResponse.access_token,
                account: {
                    id: "frontier-user",
                    label: userLabel,
                },
                scopes: ["token"],
                // Add GitLab properties
                gitlabToken: tokenResponse.gitlab_token,
                gitlabUrl: tokenResponse.gitlab_url,
            };

            // Remove existing sessions to prevent duplicates
            const removedSessions = [...this._sessions];

            this._sessions = [session];
            this._onDidChangeSessions.fire({
                added: [session],
                removed: removedSessions,
                changed: [],
            });
            this._onDidChangeAuthentication.fire();

            await this.stateManager.updateAuthState({
                isAuthenticated: true,
                gitlabCredentials: {
                    token: sessionData.gitlabToken,
                    url: sessionData.gitlabUrl,
                },
                gitlabInfo: undefined, // Will be updated by GitLab info fetch after login/register
                userInfo: userInfo, // Cache user info for offline access
            });

            // After setting new tokens (login/register), immediately verify and fetch GitLab info
            this.verifyAndRefreshSessionDetails(tokenResponse.access_token).catch((error) => {
                console.error("Error during post-token-set session verification:", error);
            });
        } catch (error) {
            console.error("Failed to store authentication tokens:", error);
            throw new Error("Failed to save login session");
        }
    }
}

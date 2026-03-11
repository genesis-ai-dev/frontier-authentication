import * as vscode from "vscode";
import { FrontierAuthProvider } from "../auth/AuthenticationProvider";
import { GitLabService } from "../gitlab/GitLabService";
import { GitService } from "../git/GitService";

export async function loginWithCredentials(
    authProvider: FrontierAuthProvider,
    username: string,
    password: string
): Promise<boolean> {
    try {
        return await authProvider.login(username, password);
    } catch (error) {
        console.error("Login error:", error);
        return false;
    }
}

export async function registerUser(
    authProvider: FrontierAuthProvider,
    username: string,
    email: string,
    password: string
): Promise<boolean> {
    try {
        await authProvider.register(username, email, password);
        return true;
    } catch (error) {
        if (error instanceof Error) {
            vscode.window.showErrorMessage(`Registration failed: ${error.message}`);
            return false;
        } else {
            vscode.window.showErrorMessage("Registration failed. Please try again.");
            return false;
        }
    }
}

export function registerCommands(
    context: vscode.ExtensionContext,
    authProvider: FrontierAuthProvider,
    gitService?: GitService // Add gitService parameter to allow debug logging control
) {
    context.subscriptions.push(
        // Register login command with input handling
        vscode.commands.registerCommand(
            "frontier.login",
            async (username?: string, password?: string) => {
                try {
                    // If credentials are provided, use them directly
                    if (username && password) {
                        const success = await loginWithCredentials(
                            authProvider,
                            username,
                            password
                        );
                        if (success) {
                            vscode.window.showInformationMessage("Successfully logged in");
                        } else {
                            vscode.window.showErrorMessage(
                                "Login failed. Please check your credentials and try again."
                            );
                        }
                        return success;
                    }

                    // Otherwise, prompt for credentials
                    const usernameInput = await vscode.window.showInputBox({
                        prompt: "Enter your username",
                        placeHolder: "Username",
                    });

                    if (!usernameInput) {
                        return false;
                    }

                    const passwordInput = await vscode.window.showInputBox({
                        prompt: "Enter your password",
                        password: true,
                        placeHolder: "Password",
                    });

                    if (!passwordInput) {
                        return false;
                    }

                    const success = await loginWithCredentials(
                        authProvider,
                        usernameInput,
                        passwordInput
                    );
                    if (success) {
                        vscode.window.showInformationMessage("Successfully logged in");
                    } else {
                        vscode.window.showErrorMessage(
                            "Login failed. Please check your credentials and try again."
                        );
                    }
                    return success;
                } catch (error) {
                    vscode.window.showErrorMessage(
                        "An error occurred during login. Please try again."
                    );
                    console.error("Login error:", error);
                    return false;
                }
            }
        ),

        // Register registration command
        vscode.commands.registerCommand(
            "frontier.register",
            async (username?: string, email?: string, password?: string) => {
                try {
                    // If all credentials are provided, use them directly
                    if (username && email && password) {
                        const success = await registerUser(authProvider, username, email, password);
                        if (success) {
                            vscode.window.showInformationMessage("Successfully registered");
                        } else {
                            vscode.window.showErrorMessage(
                                "Registration failed. Please try again."
                            );
                        }
                        return success;
                    }

                    // Otherwise, prompt for credentials
                    const usernameInput = await vscode.window.showInputBox({
                        prompt: "Enter your username",
                        placeHolder: "Username",
                    });

                    if (!usernameInput) {
                        return false;
                    }

                    const emailInput = await vscode.window.showInputBox({
                        prompt: "Enter your email",
                        placeHolder: "Email",
                    });

                    if (!emailInput) {
                        return false;
                    }

                    const passwordInput = await vscode.window.showInputBox({
                        prompt: "Enter your password",
                        password: true,
                        placeHolder: "Password",
                    });

                    if (!passwordInput) {
                        return false;
                    }

                    const success = await registerUser(
                        authProvider,
                        usernameInput,
                        emailInput,
                        passwordInput
                    );
                    if (success) {
                        vscode.window.showInformationMessage("Successfully registered");
                    } else {
                        vscode.window.showErrorMessage("Registration failed. Please try again.");
                    }
                    return success;
                } catch (error) {
                    vscode.window.showErrorMessage(
                        "An error occurred during registration. Please try again."
                    );
                    console.error("Registration error:", error);
                    return false;
                }
            }
        ),

        // Register logout command
        vscode.commands.registerCommand("frontier.logout", async () => {
            const choice = await vscode.window.showWarningMessage(
                "Are you sure you want to log out?",
                { modal: true },
                "Log Out",
                "Cancel"
            );

            if (choice === "Log Out") {
                await authProvider.logout();
                vscode.window.showInformationMessage("Successfully logged out");
                return true;
            }
            return false;
        }),

        // Get auth status command
        vscode.commands.registerCommand("frontier.getAuthStatus", () => {
            return authProvider.getAuthStatus();
        }),

        // Add getUserInfo command
        vscode.commands.registerCommand("frontier.getUserInfo", async () => {
            try {
                // Get cached user info from state manager - no API calls needed!
                const authState = authProvider.getAuthStatus();

                if (!authState.isAuthenticated) {
                    return { email: "", username: "" };
                }

                // Use cached user info from authentication
                const { StateManager } = await import("../state");
                const stateManager = StateManager.getInstance();
                let userInfo = stateManager.getUserInfo();

                // If no cached user info exists, try to fetch and cache it
                if (!userInfo) {
                    console.log("No cached user info found, attempting to fetch and cache...");
                    try {
                        await authProvider.fetchAndCacheUserInfo();
                        userInfo = stateManager.getUserInfo(); // Try again after caching
                    } catch (error) {
                        console.warn("Could not fetch user info for caching:", error);
                    }
                }

                if (userInfo) {
                    return {
                        email: userInfo.email,
                        username: userInfo.username,
                    };
                }

                // Fallback: if no cached user info, try to get from session display name
                const sessions = await authProvider.getSessions();
                const session = sessions[0];
                if (session && session.account.label !== "Frontier User") {
                    return {
                        email: "", // Not available without API call
                        username: session.account.label,
                    };
                }

                // Final fallback
                return { email: "", username: "" };
            } catch (error) {
                console.error("Error getting cached user info:", error);
                return { email: "", username: "" };
            }
        }),

        // Add debug logging toggle command
        vscode.commands.registerCommand("frontier.toggleDebugLogging", async () => {
            if (!gitService) {
                vscode.window.showErrorMessage("Sync service not available. Please restart and try again.");
                return;
            }

            const config = vscode.workspace.getConfiguration("frontier");
            const currentSetting = config.get<boolean>("debugGitLogging", false);
            const newSetting = !currentSetting;

            await config.update("debugGitLogging", newSetting, vscode.ConfigurationTarget.Global);
            gitService.setDebugLogging(newSetting);

            const status = newSetting ? "enabled" : "disabled";
            vscode.window.showInformationMessage(`Detailed logging ${status}.`);

            return newSetting;
        }),

        // Add command to clean up duplicate authentication sessions
        vscode.commands.registerCommand("frontier.cleanupDuplicateSessions", async () => {
            try {
                await authProvider.cleanupDuplicateSessions();
                vscode.window.showInformationMessage(
                    "Duplicate login sessions cleaned up."
                );
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to clean up duplicate login sessions: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }),

        // Add command to force session refresh with correct username
        vscode.commands.registerCommand("frontier.refreshAuthSession", async () => {
            try {
                if (!authProvider.isAuthenticated) {
                    vscode.window.showWarningMessage("You're not signed in. Please log in first.");
                    return;
                }

                // Force a session refresh by getting a new token with user info
                const token = await authProvider.getToken();
                if (token) {
                    // This will recreate the session with the correct user info
                    await authProvider.setToken(token);
                    vscode.window.showInformationMessage(
                        "Your login session has been refreshed."
                    );
                } else {
                    vscode.window.showErrorMessage("Could not refresh your login. Please try signing in again.");
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to refresh your login. Please try signing in again.`
                );
            }
        }),

        // Add command to refresh user info cache
        vscode.commands.registerCommand("frontier.refreshUserInfo", async () => {
            try {
                if (!authProvider.isAuthenticated) {
                    vscode.window.showWarningMessage("You're not signed in. Please log in first.");
                    return;
                }

                // Force refresh user info cache
                await authProvider.fetchAndCacheUserInfo();
                vscode.window.showInformationMessage("Your account information has been updated.");
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Couldn't update your account information. Please try again.`
                );
            }
        }),

        // Handle connectivity restored - revalidate session
        vscode.commands.registerCommand("frontier.onConnectivityRestored", async () => {
            try {
                await authProvider.revalidateSessionOnConnectivityRestored();
            } catch (error) {
                console.error("Error handling connectivity restored:", error);
            }
        }),

        // Add command to set API endpoint
        vscode.commands.registerCommand("frontier.setApiEndpoint", async () => {
            const config = vscode.workspace.getConfiguration("frontier");
            const current =
                config.get<string>("apiEndpoint") || "https://api.frontierrnd.com/api/v1";

            const input = await vscode.window.showInputBox({
                prompt: "Enter the Frontier server address",
                value: current,
                ignoreFocusOut: true,
            });

            if (input !== undefined && input !== current) {
                // Determine target: Workspace if available, otherwise Global
                const target = vscode.workspace.workspaceFolders
                    ? vscode.ConfigurationTarget.Workspace
                    : vscode.ConfigurationTarget.Global;

                await config.update("apiEndpoint", input, target);

                const selection = await vscode.window.showInformationMessage(
                    `Server address updated. Please reload the window for changes to take effect.`,
                    "Reload Window"
                );

                if (selection === "Reload Window") {
                    vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
            }
        })
    );
}

import * as vscode from "vscode";
import { SCMManager } from "../scm/SCMManager";
import { GitLabService } from "../gitlab/GitLabService";
import { FrontierAuthProvider } from "../auth/AuthenticationProvider";

export interface PublishWorkspaceOptions {
    name: string;
    description?: string;
    visibility?: "private" | "internal" | "public";
    groupId?: number;
}

// Store the SCM manager instance for API access
let scmManagerInstance: SCMManager | undefined;

export function getSCMManager(): SCMManager | undefined {
    return scmManagerInstance;
}

export function registerSCMCommands(
    context: vscode.ExtensionContext,
    authProvider: FrontierAuthProvider
) {
    const gitLabService = new GitLabService(authProvider);
    const scmManager = new SCMManager(gitLabService, context);
    
    // Store the instance for API access
    scmManagerInstance = scmManager;

    // Register list projects command
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.listProjects", async ({ showUI = true } = {}) => {
            // console.log("Listing projects...");
            try {
                await gitLabService.initialize();
                const projects = await gitLabService.listProjects({
                    orderBy: "last_activity_at",
                    sort: "desc",
                });

                // Transform projects into a consistent return format
                const formattedProjects = projects.map((project) => ({
                    id: project.id,
                    name: project.name,
                    description: project.description,
                    visibility: project.visibility,
                    isArchived: project.archived ?? false,
                    url: project.http_url_to_repo,
                    webUrl: project.web_url,
                    lastActivity: project.last_activity_at,
                    namespace: project.namespace.full_path,
                    owner: project.owner?.name || project.namespace.name,
                }));

                if (!showUI) {
                    return formattedProjects;
                }

                if (projects.length === 0) {
                    vscode.window.showInformationMessage("No projects found.");
                    return [];
                }

                // Show projects in QuickPick
                const selectedProject = await vscode.window.showQuickPick(
                    projects.map((project) => ({
                        label: project.name,
                        description: project.description || "",
                        detail: `Last activity: ${new Date(
                            project.last_activity_at
                        ).toLocaleDateString()} | Owner: ${
                            project.owner?.name || project.namespace.name
                        }`,
                        project: project,
                    })),
                    {
                        placeHolder: "Select a project to view details",
                        matchOnDescription: true,
                        matchOnDetail: true,
                    }
                );

                if (selectedProject) {
                    // Show project details
                    const detailsMessage = [
                        `Name: ${selectedProject.project.name}`,
                        `Description: ${selectedProject.project.description || "No description"}`,
                        `Visibility: ${selectedProject.project.visibility}`,
                        `URL: ${selectedProject.project.web_url}`,
                        `Last Activity: ${new Date(
                            selectedProject.project.last_activity_at
                        ).toLocaleString()}`,
                        `Owner: ${
                            selectedProject.project.owner?.name ||
                            selectedProject.project.namespace.name
                        }`,
                    ].join("\n");

                    const action = await vscode.window.showInformationMessage(
                        detailsMessage,
                        "Clone Repository"
                    );

                    if (action === "Clone Repository") {
                        await vscode.commands.executeCommand(
                            "frontier.cloneRepository",
                            selectedProject.project.http_url_to_repo
                        );
                    }
                }

                return formattedProjects;
            } catch (error) {
                if (showUI) {
                    vscode.window.showErrorMessage(
                        `Failed to list projects: ${
                            error instanceof Error ? error.message : "Unknown error"
                        }`
                    );
                    return [];
                }
                // When called programmatically (showUI=false), propagate the error
                // so callers (e.g., codex-editor's fetchRemoteProjects) can distinguish
                // "no projects found" from "server unreachable" and avoid incorrectly
                // marking local projects as orphaned/Remote Missing.
                throw error;
            }
        })
    );

    // Register create and clone project command
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.createAndCloneProject", async () => {
            try {
                // Get project name
                const name = await vscode.window.showInputBox({
                    prompt: "Enter project name",
                    validateInput: (value: string) => {
                        if (!value) {
                            return "Project name is required";
                        }
                        if (!/^[\w.-]+$/.test(value)) {
                            return "Invalid project name";
                        }
                        return null;
                    },
                });
                if (!name) {
                    return;
                }

                // Get description (optional)
                const description = await vscode.window.showInputBox({
                    prompt: "Enter project description (optional)",
                });

                // Get visibility
                const visibility = (await vscode.window.showQuickPick(
                    ["private", "internal", "public"],
                    { placeHolder: "Select project visibility" }
                )) as "private" | "internal" | "public" | undefined;
                if (!visibility) {
                    return;
                }

                // Try to create as personal project first
                try {
                    await scmManager.createAndCloneProject({
                        name,
                        description,
                        visibility,
                    });
                } catch (error) {
                    // If personal project creation fails, try with group
                    if (
                        error instanceof Error &&
                        !error.message.includes("authentication failed")
                    ) {
                        const groups = await gitLabService.listGroups();
                        if (groups.length > 0) {
                            const selectedGroup = await vscode.window.showQuickPick(
                                groups.map((group) => ({
                                    label: group.name,
                                    description: group.path,
                                    id: group.id,
                                    path: group.path,
                                })),
                                {
                                    placeHolder: "Select a group",
                                }
                            );

                            if (selectedGroup) {
                                await scmManager.createAndCloneProject({
                                    name,
                                    description,
                                    visibility,
                                    groupId: selectedGroup.id.toString(),
                                    path: selectedGroup.path,
                                });
                                return;
                            }
                        }
                    }
                    throw error;
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to create project: ${
                        error instanceof Error ? error.message : "Unknown error"
                    }`
                );
            }
        })
    );

    // Get all groups the user is at least a member of
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.listGroupsUserIsAtLeastMemberOf", async () => {
            try {
                await gitLabService.initializeWithRetry();
                console.log("Fetching groups from GitLab...");
                const groups = await gitLabService.listGroups();
                console.log(`Successfully retrieved ${groups.length} groups`);

                if (groups.length === 0) {
                    vscode.window.showInformationMessage(
                        "No groups found. You may need to be added to a group by your GitLab administrator."
                    );
                }

                return groups as {
                    id: number;
                    name: string;
                    path: string;
                }[];
            } catch (error) {
                console.error("Failed to list groups:", error);
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                vscode.window.showErrorMessage(
                    `Failed to list groups: ${errorMessage}. Please check your GitLab access permissions.`
                );
                return [];
            }
        })
    );

    // Register clone existing repository command
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "frontier.cloneRepository",
            async (url?: string, cloneToPath?: string, openWorkspace: boolean = true, mediaStrategy?: string) => {
                console.log("cloneRepository123", { url, cloneToPath, openWorkspace, mediaStrategy });
                try {
                    // Initialize GitLab service
                    await gitLabService.initializeWithRetry();

                    let repositoryUrl = url;
                    // If no URL is provided, prompt the user to select from their GitLab projects
                    if (!repositoryUrl) {
                        // Display list of user's projects
                        const projects = await gitLabService.listProjects();

                        if (projects.length === 0) {
                            vscode.window.showInformationMessage(
                                "You don't have any GitLab projects yet. Create one first!"
                            );
                            return false;
                        }

                        const quickPickItems = projects.map((p) => ({
                            label: p.name,
                            description: p.description || "",
                            detail: `Last updated: ${new Date(p.last_activity_at).toLocaleString()}`,
                            url: p.http_url_to_repo,
                        }));

                        const selectedProject = await vscode.window.showQuickPick(quickPickItems, {
                            placeHolder: "Select a project to clone",
                            matchOnDescription: true,
                            matchOnDetail: true,
                        });

                        if (!selectedProject) {
                            // User canceled
                            return false;
                        }

                        repositoryUrl = selectedProject.url;
                    }

                    // Clone the repository
                    await scmManager.cloneExistingRepository(
                        repositoryUrl,
                        cloneToPath,
                        openWorkspace,
                        mediaStrategy as "auto-download" | "stream-and-save" | "stream-only" | undefined
                    );
                    return true;
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Failed to clone repository: ${error instanceof Error ? error.message : "Unknown error"}`
                    );
                    return false;
                }
            }
        )
    );

    // Register publish workspace command
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "frontier.publishWorkspace",
            async (options: {
                name?: string;
                description?: string;
                visibility?: "private" | "internal" | "public";
                groupId?: number;
            }) => {
                try {
                    await gitLabService.initializeWithRetry();

                    // Get the workspace folders
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders || workspaceFolders.length === 0) {
                        throw new Error("No workspace is open");
                    }

                    // Get project name if not provided
                    let name = options.name;
                    if (!name) {
                        // Default to workspace folder name
                        const defaultName = workspaceFolders[0].name;
                        name = await vscode.window.showInputBox({
                            prompt: "Enter project name",
                            value: defaultName,
                            validateInput: (value: string) => {
                                if (!value) {
                                    return "Project name is required";
                                }
                                if (!/^[\w.-]+$/.test(value)) {
                                    return "Invalid project name";
                                }
                                return null;
                            },
                        });
                        if (!name) {
                            vscode.window.showInformationMessage("Project creation cancelled.");
                            return false; // User cancelled
                        }
                    }

                    // Get description if not provided
                    let description = options.description;
                    // Note: just removing this prompt for now
                    // if (description === undefined) {
                    //     description = await vscode.window.showInputBox({
                    //         prompt: "Enter project description (optional)",
                    //     });
                    //     // Description can be empty, so we don't check for null/undefined here
                    // }

                    // Get visibility if not provided
                    let visibility = options.visibility;
                    if (!visibility) {
                        visibility = (await vscode.window.showQuickPick(
                            ["private", "internal", "public"],
                            {
                                placeHolder: "Select project visibility",
                                canPickMany: false,
                            }
                        )) as "private" | "internal" | "public" | undefined;

                        if (!visibility) {
                            vscode.window.showInformationMessage("Project creation cancelled.");
                            return false; // User cancelled
                        }
                    }

                    // Get group if not provided
                    let groupId = options.groupId;
                    if (!groupId) {
                        // First ask if they want to create a personal or group project
                        const projectType = await vscode.window.showQuickPick(
                            [
                                { label: "Group Project", value: "group" },
                                { label: "Personal Project", value: "personal" },
                            ],
                            {
                                placeHolder: "Select project type",
                                canPickMany: false,
                            }
                        );

                        if (!projectType) {
                            vscode.window.showInformationMessage("Project creation cancelled.");
                            return false; // User cancelled
                        }

                        if (projectType.value === "personal") {
                            const confirm = await vscode.window.showWarningMessage(
                                "Are you sure you want to create a personal project?",
                                { modal: true },
                                "Yes, continue",
                                "No, cancel"
                            );

                            if (confirm !== "Yes, continue") {
                                return false;
                            }
                        }

                        if (projectType.value === "group") {
                            // Get list of groups
                            const groups = await gitLabService.listGroups();

                            if (groups.length === 0) {
                                vscode.window.showInformationMessage(
                                    "You don't have access to any GitLab groups. Please create a group or ask your administrator to add you to a group."
                                );
                                return false;
                            } else {
                                // Ask user to select a group
                                const selectedGroup = await vscode.window.showQuickPick(
                                    groups.map((group) => ({
                                        label: group.name,
                                        description: group.path,
                                        id: group.id,
                                    })),
                                    {
                                        placeHolder: "Select a group",
                                        canPickMany: false,
                                    }
                                );

                                if (!selectedGroup) {
                                    vscode.window.showInformationMessage(
                                        "Project creation cancelled."
                                    );
                                    return false; // User cancelled
                                }

                                groupId = selectedGroup.id;
                            }
                        }
                        // If personal project, groupId remains undefined
                    }

                    // Now we have all the information we need to publish
                    await scmManager.publishWorkspace({
                        name,
                        description,
                        visibility,
                        groupId: groupId?.toString(),
                    });

                    return true;
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Failed to publish workspace: ${error instanceof Error ? error.message : "Unknown error"}`
                    );
                    throw error;
                }
            }
        )
    );
}

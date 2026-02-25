import * as vscode from "vscode";
import { FrontierAuthProvider } from "../auth/AuthenticationProvider";

interface GitLabUser {
    id: number;
    username: string;
    name: string;
    email: string;
    group?: string;
}

export interface GitLabProjectOptions {
    name: string;
    description?: string;
    visibility?: "private" | "internal" | "public";
    groupId?: string;
}

interface GitLabGroup {
    id: number;
    name: string;
    path: string;
    full_path: string;
    parent_id: number | null;
    visibility: "private" | "internal" | "public";
}

interface GitLabProject {
    id: number;
    name: string;
    description: string | null;
    visibility: "private" | "internal" | "public";
    isArchived?: boolean;
    http_url_to_repo: string;
    web_url: string;
    created_at: string;
    last_activity_at: string;
    owner: {
        id: number;
        name: string;
        username: string;
    } | null;
    namespace: {
        id: number;
        name: string;
        path: string;
        kind: string;
        full_path: string;
    };
}

export class GitLabService {
    private gitlabToken: string | undefined;
    private gitlabBaseUrl: string | undefined;

    constructor(private authProvider: FrontierAuthProvider) {}

    async initialize(): Promise<void> {
        const sessions = await this.authProvider.getSessions();
        const session = sessions[0];
        if (!session) {
            throw new Error("No active session");
        }
        this.gitlabToken = (session as any).gitlabToken;
        this.gitlabBaseUrl = (session as any).gitlabUrl;

        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            throw new Error("GitLab credentials not found in session");
        }
    }

    async initializeWithRetry(maxRetries = 3, initialDelay = 1000): Promise<void> {
        let retries = 0;
        let lastError;

        while (retries < maxRetries) {
            try {
                const sessions = await this.authProvider.getSessions();
                const session = sessions[0];
                if (!session) {
                    throw new Error("No active session");
                }
                this.gitlabToken = (session as any).gitlabToken;
                this.gitlabBaseUrl = (session as any).gitlabUrl;

                if (!this.gitlabToken || !this.gitlabBaseUrl) {
                    throw new Error("GitLab credentials not found in session");
                }

                // Successfully initialized
                return;
            } catch (error) {
                lastError = error;
                retries++;

                // If this is not the last retry, wait before trying again
                if (retries < maxRetries) {
                    const delay = initialDelay * Math.pow(2, retries - 1);
                    console.log(
                        `GitLab service initialization failed, retrying in ${delay}ms (attempt ${retries}/${maxRetries})`
                    );
                    await new Promise((resolve) => setTimeout(resolve, delay));
                } else {
                    console.error("All GitLab service initialization retries failed:", lastError);
                }
            }
        }

        throw lastError;
    }

    async getCurrentUser(): Promise<GitLabUser> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            throw new Error("GitLab not initialized");
        }

        const response = await fetch(`${this.gitlabBaseUrl}/api/v4/user`, {
            headers: {
                Authorization: `Bearer ${this.gitlabToken}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to get user info: ${response.statusText}`);
        }

        const user = (await response.json()) as GitLabUser;
        // console.log("USER IN GITLAB", JSON.stringify(user, null, 2));
        return user;
    }

    async getProject(name: string, groupId?: string): Promise<{ id: string; url: string } | null> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initializeWithRetry();
        }

        try {
            let endpoint: string;
            if (groupId) {
                endpoint = `${this.gitlabBaseUrl}/api/v4/groups/${groupId}/projects?search=${encodeURIComponent(name)}`;
            } else {
                endpoint = `${this.gitlabBaseUrl}/api/v4/users/${(await this.getCurrentUser()).id}/projects?search=${encodeURIComponent(name)}`;
            }

            const response = await fetch(endpoint, {
                headers: {
                    Authorization: `Bearer ${this.gitlabToken}`,
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to get project: ${response.statusText}`);
            }

            const projects = await response.json();
            const project = projects.find((p: any) => p.name.toLowerCase() === name.toLowerCase());

            return project
                ? {
                      id: project.id,
                      url: project.http_url_to_repo,
                  }
                : null;
        } catch (error) {
            console.error("Error getting project:", error);
            return null;
        }
    }

    async createProject(options: GitLabProjectOptions): Promise<{ id: string; url: string }> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initializeWithRetry();
        }

        try {
            // First check if project already exists
            const existingProject = await this.getProject(options.name, options.groupId);
            if (existingProject) {
                return existingProject;
            }

            const name =
                options.name.replace(/ /g, "-").replace(/\./g, "-") || vscode.workspace.name;
            const description = options.description || "";
            const visibility = options.visibility || "private";

            const endpoint = `${this.gitlabBaseUrl}/api/v4/projects`;

            const body: Record<string, any> = {
                name,
                description,
                visibility,
                // Do NOT initialize with a README. We want a truly empty repository so that
                // the client's initial publish/sync can create the first commit without
                // immediately diverging from a server-created README commit.
                initialize_with_readme: false,
                default_branch_protection: 0,
            };

            if (options.groupId) {
                body.namespace_id = options.groupId;
            }

            console.log(`Creating project with options:`, JSON.stringify(body, null, 2));
            console.log(`Making request to: ${endpoint}`);
            console.log(`Request headers:`, {
                Authorization: `Bearer ${this.gitlabToken}`,
                "Content-Type": "application/json",
            });

            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.gitlabToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                const errorMessage = errorData?.message || errorData?.error || response.statusText;
                console.error("GitLab API error:", {
                    status: response.status,
                    statusText: response.statusText,
                    errorData,
                    requestBody: body,
                    requestUrl: endpoint,
                    requestHeaders: {
                        Authorization: `Bearer ${this.gitlabToken}`,
                        "Content-Type": "application/json",
                    },
                });
                throw new Error(`Failed to create project (${response.status}): ${errorMessage}`);
            }

            const project = await response.json();

            // Add detailed logging of the project response
            console.log("Project creation response:", {
                projectId: project.id,
                projectName: project.name,
                namespace: project.namespace,
                fullResponse: project,
            });

            // Verify the project was created in the correct namespace
            if (options.groupId && project.namespace?.id?.toString() !== options.groupId) {
                throw new Error(
                    `Project was created in incorrect namespace. Expected group ID ${options.groupId}, got ${project.namespace?.id}. Full namespace: ${JSON.stringify(project.namespace)}`
                );
            }

            console.log("Project created successfully:", {
                id: project.id,
                name: project.name,
                url: project.http_url_to_repo,
                namespace: project.namespace,
            });

            return {
                id: project.id,
                url: project.http_url_to_repo,
            };
        } catch (error) {
            console.error("Error in createProject:", error);
            if (error instanceof Error) {
                throw new Error(`Failed to create project: ${error.message}`);
            }
            throw error;
        }
    }

    async listGroups(): Promise<Array<{ id: number; name: string; path: string }>> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initializeWithRetry();
        }

        try {
            const allGroups: Array<{ id: number; name: string; path: string }> = [];
            let currentPage = 1;
            let hasNextPage = true;

            while (hasNextPage) {
                const params = new URLSearchParams({
                    min_access_level: "10",
                    page: currentPage.toString(),
                    per_page: "100",
                }).toString();

                const response = await fetch(`${this.gitlabBaseUrl}/api/v4/groups?${params}`, {
                    headers: {
                        Authorization: `Bearer ${this.gitlabToken}`,
                        "Content-Type": "application/json",
                    },
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`GitLab API error (${response.status}):`, errorText);
                    throw new Error(
                        `Failed to list groups: ${response.statusText} (${response.status})`
                    );
                }

                const groups = await response.json();
                console.log(`Retrieved ${groups.length} groups from page ${currentPage}`);
                allGroups.push(
                    ...groups.map((group: any) => ({
                        id: group.id,
                        name: group.full_name,
                        path: group.path,
                    }))
                );

                const nextPage = response.headers.get("X-Next-Page");
                hasNextPage = !!nextPage;
                currentPage++;
            }

            console.log(`Total groups found: ${allGroups.length}`);
            return allGroups;
        } catch (error) {
            console.error("Failed to list groups:", error);
            throw error;
        }
    }

    async listProjects(
        options: {
            owned?: boolean;
            membership?: boolean;
            search?: string;
            orderBy?: "id" | "name" | "path" | "created_at" | "updated_at" | "last_activity_at";
            sort?: "asc" | "desc";
        } = {}
    ): Promise<GitLabProject[]> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initializeWithRetry();
        }

        try {
            const allProjects: GitLabProject[] = [];
            let currentPage = 1;
            let hasNextPage = true;

            while (hasNextPage) {
                const queryParams = new URLSearchParams({
                    ...(options.owned !== undefined && { owned: options.owned.toString() }),
                    ...(options.membership !== undefined && {
                        membership: options.membership.toString(),
                    }),
                    ...(options.search && { search: options.search }),
                    ...(options.orderBy && { order_by: options.orderBy }),
                    ...(options.sort && { sort: options.sort }),
                    page: currentPage.toString(),
                    per_page: "100",
                });

                const response = await fetch(
                    `${this.gitlabBaseUrl}/api/v4/projects?${queryParams}`,
                    {
                        headers: {
                            Authorization: `Bearer ${this.gitlabToken}`,
                            "Content-Type": "application/json",
                        },
                    }
                );

                if (!response.ok) {
                    throw new Error(`Failed to list projects: ${response.statusText}`);
                }

                const projects = (await response.json()) as GitLabProject[];
                allProjects.push(...projects);

                const nextPage = response.headers.get("X-Next-Page");
                hasNextPage = !!nextPage;
                currentPage++;
            }

            return allProjects;
        } catch (error) {
            console.error("Error listing projects:", error);
            throw new Error(
                `Failed to list projects: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    async getToken(): Promise<string | undefined> {
        if (!this.gitlabToken) {
            await this.initializeWithRetry();
        }
        return this.gitlabToken;
    }

    getBaseUrl(): string | undefined {
        return this.gitlabBaseUrl;
    }

    async getUserInfo(): Promise<{ email: string; username: string; group?: string }> {
        try {
            const user = await this.getCurrentUser();
            return {
                email: user.email,
                username: user.username,
                group: user.group,
            };
        } catch (error) {
            console.error("Failed to get user info:", error);
            throw new Error("Failed to get user information");
        }
    }

    /**
     * Fetch a raw file from a repository
     * @param projectId - The GitLab project ID (can be numeric or URL-encoded path like "group%2Fproject")
     * @param filePath - The path to the file in the repository (will be URL-encoded)
     * @param ref - The branch, tag, or commit SHA (defaults to 'main')
     * @returns The raw file content as a string
     */
    async getRepositoryFile(
        projectId: string,
        filePath: string,
        ref: string = "main"
    ): Promise<string> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initializeWithRetry();
        }

        try {
            // URL-encode the file path for the API call
            const encodedFilePath = encodeURIComponent(filePath);
            const encodedProjectId = encodeURIComponent(projectId);
            const endpoint = `${this.gitlabBaseUrl}/api/v4/projects/${encodedProjectId}/repository/files/${encodedFilePath}/raw?ref=${encodeURIComponent(ref)}`;

            const response = await fetch(endpoint, {
                headers: {
                    Authorization: `Bearer ${this.gitlabToken}`,
                },
            });

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error(`File not found: ${filePath}`);
                }
                throw new Error(`Failed to fetch file: ${response.statusText}`);
            }

            return await response.text();
        } catch (error) {
            console.error("Error fetching repository file:", error);
            throw new Error(
                `Failed to fetch repository file: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    /**
     * Get repository tree (list files in a directory)
     * @param projectId - The GitLab project ID (can be numeric or URL-encoded path like "group%2Fproject")
     * @param path - The directory path to list (e.g., ".project/attachments/pointers")
     * @param ref - The branch, tag, or commit SHA (defaults to 'main')
     * @param recursive - Whether to list recursively (defaults to true)
     * @returns Array of file entries with name, path, type, and mode
     */
    async getRepositoryTree(
        projectId: string,
        path: string = "",
        ref: string = "main",
        recursive: boolean = true
    ): Promise<Array<{ name: string; path: string; type: "blob" | "tree"; mode: string }>> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initializeWithRetry();
        }

        const allItems: Array<{ name: string; path: string; type: "blob" | "tree"; mode: string }> = [];
        let currentPage = 1;
        const perPage = 100; // Max allowed by GitLab

        try {
            const encodedProjectId = encodeURIComponent(projectId);

            while (true) {
                const params = new URLSearchParams({
                    ref,
                    recursive: String(recursive),
                    page: currentPage.toString(),
                    per_page: perPage.toString(),
                });
                if (path) {
                    params.set("path", path);
                }
                const endpoint = `${this.gitlabBaseUrl}/api/v4/projects/${encodedProjectId}/repository/tree?${params.toString()}`;

                const response = await fetch(endpoint, {
                    headers: {
                        Authorization: `Bearer ${this.gitlabToken}`,
                    },
                });

                if (!response.ok) {
                    if (response.status === 404) {
                        // Directory doesn't exist - return empty array
                        return [];
                    }
                    throw new Error(`Failed to fetch repository tree: ${response.statusText}`);
                }

                const items = await response.json();
                if (!Array.isArray(items) || items.length === 0) {
                    break;
                }

                allItems.push(...items);

                // If we got fewer items than per_page, we're on the last page
                if (items.length < perPage) {
                    break;
                }

                currentPage++;
            }

            return allItems;
        } catch (error) {
            console.error("Error fetching repository tree:", error);
            // Return what we have so far on error - don't fail the whole operation
            return allItems;
        }
    }

    /**
     * Get list of contributors for a project
     * @param projectId - The GitLab project ID (can be numeric or URL-encoded path like "group%2Fproject")
     * @returns Array of contributors with username, name, email, and commit count
     */
    async getProjectContributors(
        projectId: string
    ): Promise<Array<{ username: string; name: string; email: string; commits: number }>> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initializeWithRetry();
        }

        try {
            const encodedProjectId = encodeURIComponent(projectId);
            const endpoint = `${this.gitlabBaseUrl}/api/v4/projects/${encodedProjectId}/repository/contributors`;

            const response = await fetch(endpoint, {
                headers: {
                    Authorization: `Bearer ${this.gitlabToken}`,
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch contributors: ${response.statusText}`);
            }

            const contributors = await response.json();
            return contributors.map((contributor: any) => ({
                username: contributor.username || contributor.name,
                name: contributor.name,
                email: contributor.email,
                commits: contributor.commits,
            }));
        } catch (error) {
            console.error("Error fetching project contributors:", error);
            throw new Error(
                `Failed to fetch project contributors: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    /**
     * Get list of ALL members for a project (including those who haven't contributed)
     * This includes inherited members from parent groups
     * @param projectId - The GitLab project ID (can be numeric or URL-encoded path like "group%2Fproject")
     * @returns Array of members with username, name, email, and access level/role
     */
    async getProjectMembers(projectId: string): Promise<
        Array<{
            username: string;
            name: string;
            email: string;
            accessLevel: number;
            roleName: string;
        }>
    > {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initializeWithRetry();
        }

        try {
            const encodedProjectId = encodeURIComponent(projectId);
            const allMembers: any[] = [];
            let page = 1;
            const perPage = 100; // Max per page

            // Fetch all pages of members
            while (true) {
                // Use 'all' endpoint to include inherited members from groups
                const endpoint = `${this.gitlabBaseUrl}/api/v4/projects/${encodedProjectId}/members/all?per_page=${perPage}&page=${page}`;

                const response = await fetch(endpoint, {
                    headers: {
                        Authorization: `Bearer ${this.gitlabToken}`,
                        "Content-Type": "application/json",
                    },
                });

                if (!response.ok) {
                    throw new Error(`Failed to fetch project members: ${response.statusText}`);
                }

                const members = await response.json();

                if (!Array.isArray(members) || members.length === 0) {
                    // No more members to fetch
                    break;
                }

                allMembers.push(...members);

                // Check if there are more pages
                const totalPages = response.headers.get("x-total-pages");
                if (totalPages && page >= parseInt(totalPages, 10)) {
                    break;
                }

                // If we got fewer results than per_page, we're on the last page
                if (members.length < perPage) {
                    break;
                }

                page++;
            }

            console.log(`Fetched ${allMembers.length} total members for project ${projectId}`);

            return allMembers.map((member: any) => ({
                username: member.username,
                name: member.name,
                email: member.email || member.public_email || "",
                accessLevel: member.access_level,
                roleName: this.getAccessLevelName(member.access_level),
            }));
        } catch (error) {
            console.error("Error fetching project members:", error);
            throw new Error(
                `Failed to fetch project members: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    /**
     * Convert GitLab access level number to human-readable role name
     * @param accessLevel - Numeric access level from GitLab API
     * @returns Human-readable role name
     */
    private getAccessLevelName(accessLevel: number): string {
        switch (accessLevel) {
            case 0:
                return "No access";
            case 5:
                return "Minimal access";
            case 10:
                return "Guest";
            case 20:
                return "Reporter";
            case 30:
                return "Developer";
            case 40:
                return "Maintainer";
            case 50:
                return "Owner";
            case 60:
                return "Admin";
            default:
                return `Unknown (${accessLevel})`;
        }
    }
}

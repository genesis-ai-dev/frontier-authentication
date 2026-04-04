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
    archived?: boolean;
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

const NETWORK_ERROR_DESCRIPTIONS: Record<string, string> = {
    ENOTFOUND: "DNS lookup failed - hostname not found",
    ECONNREFUSED: "Connection refused - server may be down",
    ECONNRESET: "Connection reset by server",
    ETIMEDOUT: "Connection timed out",
    EPIPE: "Connection broken",
    UND_ERR_CONNECT_TIMEOUT: "Connection timed out",
    UND_ERR_SOCKET: "Socket error",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "SSL certificate verification failed",
    DEPTH_ZERO_SELF_SIGNED_CERT: "Self-signed SSL certificate rejected",
    CERT_HAS_EXPIRED: "SSL certificate has expired",
    ERR_TLS_CERT_ALTNAME_INVALID: "SSL certificate hostname mismatch",
};

/** Per-request timeout for GitLab API calls (30 seconds) */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Extract meaningful network error details from a fetch TypeError.
 * Node.js undici wraps the real cause (ENOTFOUND, ECONNREFUSED, SSL errors, etc.)
 * in error.cause, which is lost when only using error.message.
 */
const getNetworkErrorDetails = (error: unknown): string => {
    if (!(error instanceof Error)) {
        return String(error);
    }

    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
        return `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s - connection may be unstable`;
    }

    const cause = (error as Error & { cause?: Error }).cause;
    if (!cause) {
        return error.message;
    }

    const causeCode = (cause as NodeJS.ErrnoException).code;
    const causeMessage = cause.message;
    const description = causeCode ? NETWORK_ERROR_DESCRIPTIONS[causeCode] : undefined;

    const parts = [error.message];
    if (description) {
        parts.push(description);
    }
    if (causeMessage && causeMessage !== error.message) {
        parts.push(causeMessage);
    }
    if (causeCode && !description) {
        parts.push(`(${causeCode})`);
    }

    return parts.join(" - ");
};

const isRetryableNetworkError = (error: unknown): boolean => {
    if (error instanceof TypeError && error.message === "fetch failed") return true;
    if (error instanceof DOMException && error.name === "AbortError") return true;
    if (error instanceof Error && error.name === "TimeoutError") return true;
    return false;
};

const isRetryableStatusCode = (status: number): boolean =>
    status >= 500 || status === 429;

interface RetryConfig {
    maxRetries: number;
    initialDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = { maxRetries: 3, initialDelayMs: 1000 };

export class GitLabService {
    private gitlabToken: string | undefined;
    private gitlabBaseUrl: string | undefined;

    constructor(private authProvider: FrontierAuthProvider) {}

    /**
     * Central fetch wrapper with automatic auth, retry with exponential backoff + jitter,
     * and safe error reporting (never leaks tokens).
     */
    private async fetchWithRetry(
        endpoint: string,
        options: RequestInit = {},
        retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
    ): Promise<Response> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initializeWithRetry();
        }

        const { maxRetries, initialDelayMs } = retryConfig;
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.gitlabToken}`,
            "Content-Type": "application/json",
            ...(options.headers as Record<string, string> | undefined),
        };

        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const baseDelay = initialDelayMs * Math.pow(2, attempt - 1);
                const jitter = baseDelay * (0.5 + Math.random() * 0.5);
                const delay = Math.round(jitter);
                console.log(
                    `[GitLabService] Retry ${attempt}/${maxRetries} for ${options.method ?? "GET"} ${endpoint} after ${delay}ms`,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            }

            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
                REQUEST_TIMEOUT_MS,
            );

            try {
                const response = await fetch(endpoint, {
                    ...options,
                    headers,
                    signal: controller.signal,
                });

                clearTimeout(timer);

                if (isRetryableStatusCode(response.status) && attempt < maxRetries) {
                    const body = await response.text().catch(() => "");
                    lastError = new Error(
                        `Server error (${response.status}): ${response.statusText}${body ? ` - ${body.slice(0, 200)}` : ""}`,
                    );
                    console.warn(
                        `[GitLabService] Retryable ${response.status} from ${options.method ?? "GET"} ${endpoint}`,
                    );
                    continue;
                }

                return response;
            } catch (error) {
                clearTimeout(timer);

                if (!isRetryableNetworkError(error) || attempt >= maxRetries) {
                    const details = getNetworkErrorDetails(error);
                    const totalAttempts = attempt + 1;
                    throw new Error(
                        `Network request to ${endpoint} failed after ${totalAttempts} attempt(s): ${details}`,
                    );
                }

                lastError = error instanceof Error ? error : new Error(String(error));
                console.warn(
                    `[GitLabService] Network error on attempt ${attempt + 1} for ${endpoint}: ${getNetworkErrorDetails(error)}`,
                );
            }
        }

        throw lastError ?? new Error("Unexpected retry loop exit");
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initializeWithRetry();
        }
    }

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
        await this.ensureInitialized();
        const response = await this.fetchWithRetry(`${this.gitlabBaseUrl}/api/v4/user`);

        if (!response.ok) {
            throw new Error(`Failed to get user info: ${response.statusText}`);
        }

        return (await response.json()) as GitLabUser;
    }

    async getProject(name: string, groupId?: string): Promise<{ id: string; url: string } | null> {
        try {
            await this.ensureInitialized();
            const endpoint = groupId
                ? `${this.gitlabBaseUrl}/api/v4/groups/${groupId}/projects?search=${encodeURIComponent(name)}`
                : `${this.gitlabBaseUrl}/api/v4/users/${(await this.getCurrentUser()).id}/projects?search=${encodeURIComponent(name)}`;

            const response = await this.fetchWithRetry(endpoint);

            if (!response.ok) {
                throw new Error(`Failed to get project (${response.status}): ${response.statusText}`);
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
            console.error("[GitLabService] Error getting project:", error instanceof Error ? error.message : error);
            throw error;
        }
    }

    async createProject(options: GitLabProjectOptions): Promise<{ id: string; url: string }> {
        // First check if project already exists
        const existingProject = await this.getProject(options.name, options.groupId);
        if (existingProject) {
            return existingProject;
        }

        await this.ensureInitialized();
        const name =
            options.name.replace(/ /g, "-").replace(/\./g, "-") || vscode.workspace.name;
        const description = options.description || "";
        const visibility = options.visibility || "private";

        const endpoint = `${this.gitlabBaseUrl}/api/v4/projects`;

        const body: Record<string, string | number | boolean | undefined> = {
            name,
            description,
            visibility,
            // Truly empty repository so the client's initial publish/sync can create
            // the first commit without diverging from a server-created README commit.
            initialize_with_readme: false,
            default_branch_protection: 0,
        };

        if (options.groupId) {
            body.namespace_id = options.groupId;
        }

        console.log(`[GitLabService] Creating project at: ${endpoint}`, JSON.stringify(body, null, 2));

        const response = await this.fetchWithRetry(endpoint, {
            method: "POST",
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            const errorMessage = errorData?.message || errorData?.error || response.statusText;
            console.error("[GitLabService] API error creating project:", {
                status: response.status,
                statusText: response.statusText,
                errorData,
                requestUrl: endpoint,
            });
            throw new Error(`Failed to create project (${response.status}): ${errorMessage}`);
        }

        const project = await response.json();

        // Verify the project was created in the correct namespace
        if (options.groupId && project.namespace?.id?.toString() !== options.groupId) {
            throw new Error(
                `Project was created in incorrect namespace. Expected group ID ${options.groupId}, got ${project.namespace?.id}. Full namespace: ${JSON.stringify(project.namespace)}`,
            );
        }

        console.log("[GitLabService] Project created:", {
            id: project.id,
            name: project.name,
            url: project.http_url_to_repo,
            namespace: project.namespace?.full_path,
        });

        return {
            id: project.id,
            url: project.http_url_to_repo,
        };
    }

    async listGroups(): Promise<Array<{ id: number; name: string; path: string }>> {
        await this.ensureInitialized();
        const allGroups: Array<{ id: number; name: string; path: string }> = [];
        let currentPage = 1;
        let hasNextPage = true;

        while (hasNextPage) {
            const params = new URLSearchParams({
                min_access_level: "10",
                page: currentPage.toString(),
                per_page: "100",
            }).toString();

            const response = await this.fetchWithRetry(
                `${this.gitlabBaseUrl}/api/v4/groups?${params}`,
            );

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[GitLabService] API error listing groups (${response.status}):`, errorText);
                throw new Error(
                    `Failed to list groups (${response.status}): ${response.statusText}`,
                );
            }

            const groups = await response.json();
            allGroups.push(
                ...groups.map((group: any) => ({
                    id: group.id,
                    name: group.full_name,
                    path: group.path,
                })),
            );

            const nextPage = response.headers.get("X-Next-Page");
            hasNextPage = !!nextPage;
            currentPage++;
        }

        console.log(`[GitLabService] Total groups found: ${allGroups.length}`);
        return allGroups;
    }

    async listProjects(
        options: {
            owned?: boolean;
            membership?: boolean;
            search?: string;
            orderBy?: "id" | "name" | "path" | "created_at" | "updated_at" | "last_activity_at";
            sort?: "asc" | "desc";
        } = {},
    ): Promise<GitLabProject[]> {
        await this.ensureInitialized();
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

            const response = await this.fetchWithRetry(
                `${this.gitlabBaseUrl}/api/v4/projects?${queryParams}`,
            );

            if (!response.ok) {
                throw new Error(`Failed to list projects (${response.status}): ${response.statusText}`);
            }

            const projects = (await response.json()) as GitLabProject[];
            allProjects.push(...projects);

            const nextPage = response.headers.get("X-Next-Page");
            hasNextPage = !!nextPage;
            currentPage++;
        }

        return allProjects;
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
        ref: string = "main",
    ): Promise<string> {
        await this.ensureInitialized();
        const encodedFilePath = encodeURIComponent(filePath);
        const encodedProjectId = encodeURIComponent(projectId);
        const endpoint = `${this.gitlabBaseUrl}/api/v4/projects/${encodedProjectId}/repository/files/${encodedFilePath}/raw?ref=${encodeURIComponent(ref)}`;

        const response = await this.fetchWithRetry(endpoint);

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error(`File not found: ${filePath}`);
            }
            throw new Error(`Failed to fetch file (${response.status}): ${response.statusText}`);
        }

        return await response.text();
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
        recursive: boolean = true,
    ): Promise<Array<{ name: string; path: string; type: "blob" | "tree"; mode: string }>> {
        const allItems: Array<{ name: string; path: string; type: "blob" | "tree"; mode: string }> = [];
        let currentPage = 1;
        const perPage = 100;

        try {
            await this.ensureInitialized();
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

                const response = await this.fetchWithRetry(endpoint);

                if (!response.ok) {
                    if (response.status === 404) {
                        return [];
                    }
                    throw new Error(`Failed to fetch repository tree (${response.status}): ${response.statusText}`);
                }

                const items = await response.json();
                if (!Array.isArray(items) || items.length === 0) {
                    break;
                }

                allItems.push(...items);

                if (items.length < perPage) {
                    break;
                }

                currentPage++;
            }

            return allItems;
        } catch (error) {
            console.error("[GitLabService] Error fetching repository tree:", error instanceof Error ? error.message : error);
            return allItems;
        }
    }

    /**
     * Get list of contributors for a project
     * @param projectId - The GitLab project ID (can be numeric or URL-encoded path like "group%2Fproject")
     * @returns Array of contributors with username, name, email, and commit count
     */
    async getProjectContributors(
        projectId: string,
    ): Promise<Array<{ username: string; name: string; email: string; commits: number }>> {
        await this.ensureInitialized();
        const encodedProjectId = encodeURIComponent(projectId);
        const endpoint = `${this.gitlabBaseUrl}/api/v4/projects/${encodedProjectId}/repository/contributors`;

        const response = await this.fetchWithRetry(endpoint);

        if (!response.ok) {
            throw new Error(`Failed to fetch contributors (${response.status}): ${response.statusText}`);
        }

        const contributors = await response.json();
        return contributors.map((contributor: any) => ({
            username: contributor.username || contributor.name,
            name: contributor.name,
            email: contributor.email,
            commits: contributor.commits,
        }));
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
        await this.ensureInitialized();
        const encodedProjectId = encodeURIComponent(projectId);
        const allMembers: any[] = [];
        let page = 1;
        const perPage = 100;

        while (true) {
            const endpoint = `${this.gitlabBaseUrl}/api/v4/projects/${encodedProjectId}/members/all?per_page=${perPage}&page=${page}`;

            const response = await this.fetchWithRetry(endpoint);

            if (!response.ok) {
                throw new Error(`Failed to fetch project members (${response.status}): ${response.statusText}`);
            }

            const members = await response.json();

            if (!Array.isArray(members) || members.length === 0) {
                break;
            }

            allMembers.push(...members);

            const totalPages = response.headers.get("x-total-pages");
            if (totalPages && page >= parseInt(totalPages, 10)) {
                break;
            }

            if (members.length < perPage) {
                break;
            }

            page++;
        }

        return allMembers.map((member: any) => ({
            username: member.username,
            name: member.name,
            email: member.email || member.public_email || "",
            accessLevel: member.access_level,
            roleName: this.getAccessLevelName(member.access_level),
        }));
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

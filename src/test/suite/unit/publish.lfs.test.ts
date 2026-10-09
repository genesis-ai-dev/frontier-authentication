import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SCMManager } from "../../../scm/SCMManager";
import { GitLabService } from "../../../gitlab/GitLabService";

suite("Publish uses LFS during staging", () => {
    test("publishWorkspace calls addAllWithLFS and reuses token for push", async () => {
        const ctx: any = {
            subscriptions: [],
            workspaceState: { get: () => undefined, update: async () => {} },
        };

        const gl = new GitLabService({} as any);
        const scm = new SCMManager(gl, ctx) as any;

        // Use a temp directory for workspace path
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-publish-"));
        (scm as any).getWorkspacePath = () => workspaceDir;

        // Stub GitLab service calls
        (gl as any).initializeWithRetry = async () => {};
        (gl as any).createProject = async () => ({
            id: "1",
            url: "https://example.com/repo.git",
        });
        (gl as any).getToken = async () => "tkn";
        (gl as any).getCurrentUser = async () => ({
            username: "u",
            name: "User",
            email: "u@example.com",
        });

        // Spy on git service methods
        let addAllWithLFSCreds: any = null;
        let syncAuth: any = null;

        (scm.gitService as any).hasGitRepository = async () => true;
        (scm.gitService as any).getRemoteUrl = async () => undefined;
        (scm.gitService as any).addRemote = async () => {};
        (scm.gitService as any).addAllWithLFS = async (_dir: string, creds: any) => {
            addAllWithLFSCreds = creds;
        };
        (scm.gitService as any).commit = async () => {};
        // Stub syncChanges so publish can behave like a full sync without hitting
        // real network/lock logic, and so we can verify the auth that is used.
        (scm.gitService as any).syncChanges = async (
            _dir: string,
            auth: any,
            _author: any,
            _options?: any
        ) => {
            syncAuth = auth;
            return { hadConflicts: false, uploadedLfsFiles: [] };
        };
        (scm as any).initializeSCM = async () => {};

        await scm.publishWorkspace({ name: "proj" });

        assert.deepStrictEqual(
            addAllWithLFSCreds,
            { username: "oauth2", password: "tkn" },
            "addAllWithLFS should be called with oauth2 and token"
        );
        assert.deepStrictEqual(
            syncAuth,
            { username: "oauth2", password: "tkn" },
            "syncChanges should reuse the same token that was used for LFS"
        );
        // Cleanup temp dir
        try {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {}
    });
});

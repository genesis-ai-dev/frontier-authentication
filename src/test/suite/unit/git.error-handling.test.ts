import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { GitService } from "../../../git/GitService";

suite("GitService Error Handling", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-git-errors-"));
    let repoDir: string;

    const stateStub: any = {
        isSyncLocked: () => false,
        acquireSyncLock: async () => true,
        releaseSyncLock: async () => {},
    };

    const service = new GitService(stateStub);

    suiteSetup(() => {
        dugiteGit.useEmbeddedGitBinary();
    });

    setup(async () => {
        repoDir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
        await service.init(repoDir);
        await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
        
        // Create initial commit
        const testFile = path.join(repoDir, "test.txt");
        await fs.promises.writeFile(testFile, "initial content", "utf8");
        await dugiteGit.add(repoDir, "test.txt");
        await dugiteGit.commit(repoDir, "Initial commit", { name: "Test", email: "test@example.com" });

        // Bypass the network connectivity check so mocked fetch/push are reached
        (service as any).isOnline = async () => true;
    });

    teardown(async () => {
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    });

    suite("syncChanges - Network Failures", () => {
        test("fetch fails with ENOTFOUND error", async () => {
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            (dugiteGit as any).fetchOrigin = async () => {
                const error: any = new Error("getaddrinfo ENOTFOUND example.com");
                error.code = "ENOTFOUND";
                throw error;
            };

            try {
                await assert.rejects(
                    async () => {
                        await service.syncChanges(
                            repoDir,
                            { username: "oauth2", password: "token" },
                            { name: "Test", email: "test@example.com" }
                        );
                    },
                    (error: Error) => {
                        return error.message.includes("Cannot reach server");
                    },
                    "Should throw user-friendly network error"
                );
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
            }
        });

        test("fetch fails with ETIMEDOUT error", async () => {
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            (dugiteGit as any).fetchOrigin = async () => {
                const error: any = new Error("ETIMEDOUT");
                error.code = "ETIMEDOUT";
                throw error;
            };

            try {
                await assert.rejects(
                    async () => {
                        await service.syncChanges(
                            repoDir,
                            { username: "oauth2", password: "token" },
                            { name: "Test", email: "test@example.com" }
                        );
                    },
                    (error: Error) => {
                        return error.message.includes("Connection timeout");
                    },
                    "Should throw user-friendly timeout error"
                );
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
            }
        });

        test("fetch fails with 401 authentication error", async () => {
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            (dugiteGit as any).fetchOrigin = async () => {
                const error: any = new Error("401 Unauthorized");
                error.statusCode = 401;
                throw error;
            };

            try {
                await assert.rejects(
                    async () => {
                        await service.syncChanges(
                            repoDir,
                            { username: "oauth2", password: "token" },
                            { name: "Test", email: "test@example.com" }
                        );
                    },
                    (error: Error) => {
                        return error.message.includes("Authentication failed");
                    },
                    "Should throw user-friendly auth error"
                );
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
            }
        });

        test("fetch fails with 403 forbidden error", async () => {
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            (dugiteGit as any).fetchOrigin = async () => {
                const error: any = new Error("403 Forbidden");
                error.statusCode = 403;
                throw error;
            };

            try {
                await assert.rejects(
                    async () => {
                        await service.syncChanges(
                            repoDir,
                            { username: "oauth2", password: "token" },
                            { name: "Test", email: "test@example.com" }
                        );
                    },
                    (error: Error) => {
                        return error.message.includes("Access denied");
                    },
                    "Should throw user-friendly permission error"
                );
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
            }
        });

        test("push fails with network error", async () => {
            // Setup: fetch succeeds, push fails
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            const originalPush = dugiteGit.push;
            
            (dugiteGit as any).fetchOrigin = async () => {};
            (dugiteGit as any).push = async () => {
                const error: any = new Error("ECONNREFUSED");
                error.code = "ECONNREFUSED";
                throw error;
            };

            try {
                await assert.rejects(
                    async () => {
                        await service.syncChanges(
                            repoDir,
                            { username: "oauth2", password: "token" },
                            { name: "Test", email: "test@example.com" }
                        );
                    },
                    (error: Error) => {
                        return error.message.includes("push failed");
                    },
                    "Should throw push error"
                );
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
                (dugiteGit as any).push = originalPush;
            }
        });
    });

    suite("safePush - Error Scenarios", () => {
        test("push rejected due to branch protection (non-fast-forward)", async () => {
            const originalPush = dugiteGit.push;
            (dugiteGit as any).push = async () => {
                const error: any = new Error("One or more branches were not updated: refs/heads/main: failed to update ref");
                error.name = "GitPushError";
                throw error;
            };

            try {
                await assert.rejects(
                    async () => {
                        await service.push(repoDir, { username: "oauth2", password: "token" });
                    },
                    (error: Error) => {
                        return error.message.includes("Remote branch changed since last sync");
                    },
                    "Should throw user-friendly branch protection error"
                );
            } finally {
                (dugiteGit as any).push = originalPush;
            }
        });

        test("push rejected because remote changed (specific error message)", async () => {
            const originalPush = dugiteGit.push;
            (dugiteGit as any).push = async () => {
                const error: any = new Error("failed to update ref");
                error.name = "GitPushError";
                throw error;
            };

            try {
                await assert.rejects(
                    async () => {
                        await service.push(repoDir, { username: "oauth2", password: "token" });
                    },
                    (error: Error) => {
                        return error.message.includes("Remote branch changed since last sync");
                    },
                    "Should throw user-friendly remote changed error"
                );
            } finally {
                (dugiteGit as any).push = originalPush;
            }
        });

        test("push timeout handling", async function() {
            this.timeout(10000); // Longer timeout for test
            
            const originalPush = dugiteGit.push;
            let pushCalled = false;
            (dugiteGit as any).push = async () => {
                pushCalled = true;
                // Simulate timeout by throwing timeout error
                const error: any = new Error("ETIMEDOUT");
                error.code = "ETIMEDOUT";
                throw error;
            };

            try {
                await assert.rejects(
                    async () => {
                        await service.push(repoDir, { username: "oauth2", password: "token" });
                    },
                    (error: Error) => {
                        // Should handle timeout error
                        return error.message.includes("timeout") || error.message.includes("Timeout") || error.message.includes("push failed");
                    },
                    "Should handle timeout"
                );
                assert.strictEqual(pushCalled, true, "Push should be called");
            } finally {
                (dugiteGit as any).push = originalPush;
            }
        });

        test("push with invalid credentials", async () => {
            const originalPush = dugiteGit.push;
            (dugiteGit as any).push = async () => {
                const error: any = new Error("401 authentication failed");
                error.statusCode = 401;
                throw error;
            };

            try {
                await assert.rejects(
                    async () => {
                        await service.push(repoDir, { username: "oauth2", password: "invalid" });
                    },
                    (error: Error) => {
                        return error.message.includes("Authentication failed");
                    },
                    "Should throw authentication error"
                );
            } finally {
                (dugiteGit as any).push = originalPush;
            }
        });

        test("push when remote ref changed between fetch and push (race condition)", async () => {
            const originalFetchOrigin = dugiteGit.fetchOrigin;
            const originalPush = dugiteGit.push;
            
            let fetchCount = 0;
            (dugiteGit as any).fetchOrigin = async () => {
                fetchCount++;
            };
            
            (dugiteGit as any).push = async () => {
                // Simulate race: remote changed after fetch
                const error: any = new Error("One or more branches were not updated: refs/heads/main: failed to update ref");
                error.name = "GitPushError";
                throw error;
            };

            try {
                await assert.rejects(
                    async () => {
                        await service.syncChanges(
                            repoDir,
                            { username: "oauth2", password: "token" },
                            { name: "Test", email: "test@example.com" }
                        );
                    },
                    (error: Error) => {
                        return error.message.includes("Remote branch changed since last sync");
                    },
                    "Should handle race condition gracefully"
                );
            } finally {
                (dugiteGit as any).fetchOrigin = originalFetchOrigin;
                (dugiteGit as any).push = originalPush;
            }
        });
    });

    suite("getRemoteUrl", () => {
        test("returns correct URL when remote exists", async () => {
            const url = await service.getRemoteUrl(repoDir);
            assert.strictEqual(url, "https://example.com/repo.git");
        });

        test("returns undefined when remote doesn't exist", async () => {
            // Create a repo without remote
            const noRemoteDir = fs.mkdtempSync(path.join(tmpRoot, "no-remote-"));
            await service.init(noRemoteDir);
            
            const url = await service.getRemoteUrl(noRemoteDir);
            assert.strictEqual(url, undefined);
            
            // Cleanup
            fs.rmSync(noRemoteDir, { recursive: true, force: true });
        });

        test("handles multiple remotes and returns origin", async () => {
            // Add another remote
            await service.addRemote(repoDir, "upstream", "https://example.com/upstream.git");
            
            const url = await service.getRemoteUrl(repoDir);
            assert.strictEqual(url, "https://example.com/repo.git", "Should return origin URL");
        });

        test("handles error when getting remote URL", async () => {
            const originalListRemotes = dugiteGit.listRemotes;
            (dugiteGit as any).listRemotes = async () => {
                throw new Error("Failed to list remotes");
            };

            try {
                const url = await service.getRemoteUrl(repoDir);
                // Should return undefined on error (based on implementation)
                assert.strictEqual(url, undefined);
            } finally {
                (dugiteGit as any).listRemotes = originalListRemotes;
            }
        });
    });
});

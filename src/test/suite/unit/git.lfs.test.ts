import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { GitService } from "../../../git/GitService";

suite("Git LFS - Empty Pointer Handling", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-auth-lfs-"));
    let repoDir: string;

    // Minimal StateManager stub for GitService ctor
    const stateStub: any = {
        isSyncLocked: () => false,
        acquireSyncLock: async () => true,
        releaseSyncLock: async () => {},
    };

    const git = new GitService(stateStub);

    setup(async () => {
        repoDir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
        // Initialize repo and set remote
        await git.init(repoDir);
        await dugiteGit.disableLfsFilters(repoDir);
        await git.addRemote(repoDir, "origin", "https://example.com/repo.git");

        // Write .gitattributes marking pointers path as LFS-tracked
        const attrs = [".project/attachments/pointers/** filter=lfs"].join("\n");
        await fs.promises.writeFile(path.join(repoDir, ".gitattributes"), attrs, "utf8");

        // Create empty pointer file under pointers directory
        const pointerRel = ".project/attachments/pointers/audio/clip.wav";
        const pointerAbs = path.join(repoDir, pointerRel);
        await fs.promises.mkdir(path.dirname(pointerAbs), { recursive: true });
        await fs.promises.writeFile(pointerAbs, new Uint8Array());

        // Ensure corresponding files dir exists (no file written, so recovery cannot read real bytes)
        const filesDir = path.join(repoDir, ".project/attachments/files/audio");
        await fs.promises.mkdir(filesDir, { recursive: true });
    });

    teardown(async () => {
        // Cleanup repoDir
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    });

    test("addAllWithLFS skips empty pointer and moves it to corrupted without throwing", async () => {
        const pointerRel = ".project/attachments/pointers/audio/clip.wav";
        const pointerAbs = path.join(repoDir, pointerRel);

        // Sanity check
        assert.ok(fs.existsSync(pointerAbs), "Pointer file should exist before test");

        // Act: should not throw
        await assert.doesNotReject(async () => {
            await git.addAllWithLFS(repoDir, { username: "u", password: "p" });
        });

        // Assert: original pointer should be moved to files/corrupted/pointers
        const filesRoot = path.join(repoDir, ".project/attachments/files");
        const pointersRoot = path.join(repoDir, ".project/attachments/pointers");
        const relUnderPointers = path.relative(pointersRoot, pointerAbs);
        const corruptedPointerAbs = path.join(filesRoot, "corrupted", "pointers", relUnderPointers);

        assert.strictEqual(
            fs.existsSync(pointerAbs),
            false,
            "Empty pointer should be removed from pointers dir"
        );
        assert.strictEqual(
            fs.existsSync(corruptedPointerAbs),
            true,
            "Empty pointer should be recorded under files/corrupted/pointers"
        );
    });
});

suite("Git LFS - High Priority Scenarios", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-auth-lfs-hi-"));
    let repoDir: string;
    let originalFetch: any;

    // Minimal StateManager stub for GitService ctor
    const stateStub: any = {
        isSyncLocked: () => false,
        acquireSyncLock: async () => true,
        releaseSyncLock: async () => {},
    };

    const git = new GitService(stateStub);

    setup(async () => {
        repoDir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
        await git.init(repoDir);
        await dugiteGit.disableLfsFilters(repoDir);
        await git.addRemote(repoDir, "origin", "https://example.com/repo.git");
        const attrs = [".project/attachments/pointers/** filter=lfs"].join("\n");
        await fs.promises.writeFile(path.join(repoDir, ".gitattributes"), attrs, "utf8");
        originalFetch = (globalThis as any).fetch;
    });

    teardown(async () => {
        // restore fetch
        (globalThis as any).fetch = originalFetch;
        // Cleanup repoDir
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    });

    test("Blob in pointers workflow: detects blob, uploads and rewrites pointer; preserves files bytes in untracked file folder", async () => {
        const rel = ".project/attachments/pointers/audio/raw.bin";
        const abs = path.join(repoDir, rel);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        const blob = Buffer.from("hello world raw bytes");
        await fs.promises.writeFile(abs, blob);

        // Pre-create files dir with different content to ensure non-overwrite
        const filesAbs = path.join(repoDir, ".project/attachments/files/audio/raw.bin");
        await fs.promises.mkdir(path.dirname(filesAbs), { recursive: true });
        const preexisting = Buffer.from("do not overwrite");
        await fs.promises.writeFile(filesAbs, preexisting);

        // Capture requests
        const calls: Array<{ url: string; method?: string; headers?: Record<string, string> }> = [];

        (globalThis as any).fetch = async (input: any, init?: any) => {
            const url = typeof input === "string" ? input : String(input);
            const method = init?.method || "GET";
            const headers = Object.fromEntries(
                Object.entries(init?.headers || {}).map(([k, v]) => [
                    k.toString().toLowerCase(),
                    String(v),
                ])
            );
            calls.push({ url, method, headers });

            if (url.endsWith("/info/lfs/objects/batch") && method === "POST") {
                const bodyText = init?.body ? init.body.toString() : "";
                assert.ok(
                    bodyText.includes('"operation":"upload"'),
                    "Batch upload operation must be requested"
                );
                // Simulate server instructing upload
                const resp = {
                    objects: [
                        {
                            actions: {
                                upload: {
                                    href: "https://lfs-upload.example.com/obj1",
                                    header: { "content-type": "application/octet-stream" },
                                },
                            },
                        },
                    ],
                };
                return new Response(JSON.stringify(resp), {
                    status: 200,
                    headers: { "content-type": "application/vnd.git-lfs+json" },
                });
            }
            if (url.startsWith("https://lfs-upload.example.com/") && method === "PUT") {
                return new Response("", { status: 200 });
            }
            throw new Error(`Unexpected fetch ${method} ${url}`);
        };

        await git.addAllWithLFS(repoDir, { username: "u", password: "p" });

        // Pointer should now be in pointers path
        const pointerText = await fs.promises.readFile(abs, "utf8");
        assert.match(pointerText, /git-lfs\.github\.com\/spec\/v1/);
        assert.match(pointerText, /oid\s+sha256:[0-9a-f]{64}/);
        assert.match(pointerText, /size\s+\d+/);

        // Files dir content should remain preexisting (non-overwritten)
        const filesBytes = await fs.promises.readFile(filesAbs);
        assert.strictEqual(
            filesBytes.toString(),
            preexisting.toString(),
            "Existing files dir bytes must not be overwritten"
        );
    });

    test("Empty pointer with recoverable bytes uploads recovered content and does not mark corrupted", async () => {
        const rel = ".project/attachments/pointers/audio/recover.wav";
        const abs = path.join(repoDir, rel);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, new Uint8Array());
        const filesAbs = path.join(repoDir, ".project/attachments/files/audio/recover.wav");
        const recovered = Buffer.from("recovered-bytes");
        await fs.promises.mkdir(path.dirname(filesAbs), { recursive: true });
        await fs.promises.writeFile(filesAbs, recovered);

        (globalThis as any).fetch = async (input: any, init?: any) => {
            const url = typeof input === "string" ? input : String(input);
            if (url.endsWith("/info/lfs/objects/batch") && (init?.method || "GET") === "POST") {
                const resp = {
                    objects: [
                        {
                            actions: {
                                upload: {
                                    href: "https://lfs-upload.example.com/obj2",
                                    header: { "content-type": "application/octet-stream" },
                                },
                            },
                        },
                    ],
                };
                return new Response(JSON.stringify(resp), {
                    status: 200,
                    headers: { "content-type": "application/vnd.git-lfs+json" },
                });
            }
            if (
                url.startsWith("https://lfs-upload.example.com/") &&
                (init?.method || "GET") === "PUT"
            ) {
                return new Response("", { status: 200 });
            }
            throw new Error(`Unexpected fetch ${init?.method || "GET"} ${url}`);
        };

        await git.addAllWithLFS(repoDir, { username: "u", password: "p" });

        // Pointer remains at same path (not moved to corrupted)
        assert.strictEqual(
            fs.existsSync(abs),
            true,
            "Pointer should still exist (rewritten as valid pointer)"
        );
        const txt = await fs.promises.readFile(abs, "utf8");
        assert.match(txt, /git-lfs\.github\.com\/spec\/v1/);
        assert.match(txt, /size\s+\d+/);
        // Corrupted path should NOT exist for this file
        const filesRoot = path.join(repoDir, ".project/attachments/files");
        const pointersRoot = path.join(repoDir, ".project/attachments/pointers");
        const relUnderPointers = path.relative(pointersRoot, abs);
        const corruptedPointerAbs = path.join(filesRoot, "corrupted", "pointers", relUnderPointers);
        assert.strictEqual(
            fs.existsSync(corruptedPointerAbs),
            false,
            "Should not move recoverable pointer to corrupted"
        );
    });

    test("Existing pointer triggers download into files dir when missing", async () => {
        // Create a valid-looking pointer content (small stub matching spec)
        const rel = ".project/attachments/pointers/audio/need-download.wav";
        const abs = path.join(repoDir, rel);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        const fakeOid = "a".repeat(64);
        const pointerText = [
            "version https://git-lfs.github.com/spec/v1",
            `oid sha256:${fakeOid}`,
            "size 12",
        ].join("\n");
        await fs.promises.writeFile(abs, pointerText, "utf8");

        const filesAbs = path.join(repoDir, ".project/attachments/files/audio/need-download.wav");
        // Ensure files dir missing
        try {
            await fs.promises.unlink(filesAbs);
        } catch {}

        (globalThis as any).fetch = async (input: any, init?: any) => {
            const url = typeof input === "string" ? input : String(input);
            const method = init?.method || "GET";
            if (url.endsWith("/info/lfs/objects/batch") && method === "POST") {
                const resp = {
                    objects: [
                        {
                            oid: fakeOid,
                            size: 12,
                            actions: {
                                download: {
                                    href: "https://lfs-download.example.com/obj3",
                                    header: { accept: "application/octet-stream" },
                                },
                            },
                        },
                    ],
                };
                return new Response(JSON.stringify(resp), {
                    status: 200,
                    headers: { "content-type": "application/vnd.git-lfs+json" },
                });
            }
            if (url.startsWith("https://lfs-download.example.com/") && method === "GET") {
                return new Response(Buffer.from("hello-bytes"), { status: 200 });
            }
            return new Response("", { status: 200 });
        };

        await git.addAllWithLFS(repoDir, { username: "u", password: "p" });

        // After staging, ensure files dir now has bytes
        const bytes = await fs.promises.readFile(filesAbs);
        assert.strictEqual(bytes.toString(), "hello-bytes");
    });

    test("Auth headers: Basic used for batch, upload uses server-provided headers only", async () => {
        const rel = ".project/attachments/pointers/audio/auth.bin";
        const abs = path.join(repoDir, rel);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, Buffer.from("auth-bytes"));

        const seen = {
            batchAuth: undefined as string | undefined,
            uploadAuth: undefined as string | undefined,
        };

        (globalThis as any).fetch = async (input: any, init?: any) => {
            const url = typeof input === "string" ? input : String(input);
            const method = init?.method || "GET";
            const headers = Object.fromEntries(
                Object.entries(init?.headers || {}).map(([k, v]) => [
                    k.toString().toLowerCase(),
                    String(v),
                ])
            );

            if (url.endsWith("/info/lfs/objects/batch") && method === "POST") {
                seen.batchAuth = headers["authorization"]; // should be Basic ...
                const resp = {
                    objects: [
                        {
                            actions: {
                                upload: {
                                    href: "https://lfs-upload.example.com/auth-obj",
                                    header: { authorization: "Bearer storage-token" },
                                },
                            },
                        },
                    ],
                };
                return new Response(JSON.stringify(resp), {
                    status: 200,
                    headers: { "content-type": "application/vnd.git-lfs+json" },
                });
            }
            if (url.startsWith("https://lfs-upload.example.com/") && method === "PUT") {
                const headers = Object.fromEntries(
                    Object.entries(init?.headers || {}).map(([k, v]) => [
                        k.toString().toLowerCase(),
                        String(v),
                    ])
                );
                seen.uploadAuth = headers["authorization"]; // should be Bearer storage-token, not Basic
                return new Response("", { status: 200 });
            }
            throw new Error(`Unexpected fetch ${method} ${url}`);
        };

        await git.addAllWithLFS(repoDir, { username: "user", password: "pass" });

        assert.ok(
            seen.batchAuth && seen.batchAuth.startsWith("Basic "),
            "Batch must use Basic auth"
        );
        assert.strictEqual(
            seen.uploadAuth,
            "Bearer storage-token",
            "Upload must use server-provided header"
        );
    });
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
function loadDecisions() {
    const context = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/utils/pinDecisions.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context.exports;
}
function fixture({
    remotePins = {},
    offline = false,
    sourceUnavailable = false,
    cachedRemote = false,
    invalid = false,
    originChanged = false,
    token = "token",
    branch = "feature-pins",
    accepted = true,
    pendingIntent = false,
    editorReady = true,
    dirty = false,
    credentialTimeout = false,
} = {}) {
    const calls = [];
    let origins = 0;
    const git = {
        currentBranch: async () => {
            if (sourceUnavailable) {
                throw Error("Cannot read Git state");
            }
            return branch;
        },
        listRemotes: async () => [
            { remote: "origin", url: originChanged && origins++ ? "other" : "repo" },
        ],
        fetchOrigin: async () => {
            calls.push("fetch");
            if (offline) throw Error("offline");
        },
        resolveRef: async (_dir, ref) => {
            calls.push(ref);
            return "a".repeat(40);
        },
        readBlobAtRef: async () =>
            Buffer.from(invalid ? "{broken" : JSON.stringify({ meta: { pinnedExtensions: remotePins } })),
    };
    const host = {
        Uri: {
            file: (path) => path,
            joinPath: () => ({ toString: () => "/project/metadata.json" }),
        },
        workspace: {
            textDocuments: dirty
                ? [{ uri: { toString: () => "/project/metadata.json" }, isDirty: true }]
                : [],
        },
        commands: {
            getCommands: async () => [
                "codex.conductor.getPinPolicyStatus",
                ...(editorReady ? ["codex.applyRemoteProjectPins"] : []),
            ],
            executeCommand: async (id, arg) => {
                calls.push({ id, arg });
                if (id.endsWith("getPinPolicyStatus"))
                    return {
                        protocolVersion: 1,
                        mode: "enforce",
                        generation: 1,
                        remote: cachedRemote ? { pins: {} } : undefined,
                    };
                if (id.endsWith("beginRemotePinCheck")) return { session: "session", request: 1 };
                return { accepted, pendingIntent, generation: 1 };
            },
        },
    };
    const ctx = {
        exports: {},
        TextDecoder,
        setTimeout: credentialTimeout
            ? (fn, ms) => {
                  if (ms === 5000) {
                      queueMicrotask(fn);
                      return 0;
                  }
                  return setTimeout(fn, ms);
              }
            : setTimeout,
        clearTimeout,
        AbortController,
        console,
        require: (id) =>
            id.includes("pinDecisions") ? loadDecisions() : id === "vscode"
                ? host
                : id.includes("dugiteGit")
                  ? git
                  : { EXTENSION_PIN_POLICY: { ignoreProjectPins: false } },
    };
    vm.runInNewContext(
        ts.transpileModule(
            fs.readFileSync(path.join(__dirname, "../src/utils/pinPolicy.ts"), "utf8"),
            { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
        ).outputText,
        ctx,
    );
    return {
        calls,
        run: (reconcile = true) => ctx.exports.discoverRemotePins("/project", token, reconcile),
    };
}
test("offline discovery never submits an empty snapshot", async () => {
    const f = fixture({ offline: true });
    assert.equal((await f.run()).kind, "unavailable");
    assert.equal(
        f.calls.some((c) => c.id?.endsWith("acceptRemotePinSnapshot")),
        false,
    );
});
test("successful remote unpin is explicit and tied to actual branch and commit", async () => {
    const f = fixture();
    assert.equal((await f.run()).kind, "verified");
    assert.ok(f.calls.includes("refs/remotes/origin/feature-pins"));
    const submitted = f.calls.find((c) => c.id?.endsWith("acceptRemotePinSnapshot"));
    assert.equal(Object.keys(submitted.arg.snapshot.pins).length, 0);
    assert.equal(submitted.arg.snapshot.commit, "a".repeat(40));
});
test("malformed remote metadata cannot remove pins", async () => {
    const f = fixture({ invalid: true });
    assert.equal((await f.run()).kind, "invalid");
    assert.equal(
        f.calls.some((c) => c.id?.endsWith("acceptRemotePinSnapshot")),
        false,
    );
});
test("repository change during fetch invalidates discovery", async () => {
    const f = fixture({ originChanged: true });
    assert.equal((await f.run()).kind, "not-ready");
    assert.equal(
        f.calls.some((c) => c.id?.endsWith("acceptRemotePinSnapshot")),
        false,
    );
});
test("authentication absence is distinct from an authoritative unpin", async () => {
    const f = fixture({ token: "" });
    assert.equal((await f.run()).kind, "authentication-required");
    assert.equal(
        f.calls.some((c) => c.id?.endsWith("acceptRemotePinSnapshot")),
        false,
    );
    assert.equal(f.calls.includes("fetch"), false);
});
test("superseded response does not report successful discovery", async () => {
    const f = fixture({ accepted: false });
    assert.equal((await f.run()).kind, "not-ready");
});

test("startup discovery saves remote pins without recursively reconciling the waiting binary", async () => {
    const f = fixture();
    assert.equal((await f.run(false)).kind, "verified");
    assert.ok(f.calls.some((c) => c.id?.endsWith("applyRemoteProjectPins")));
    assert.equal(
        f.calls.some((c) => c.id?.endsWith("reconcilePinPolicy")),
        false,
    );
});

test("concurrent startup and sync discovery share one fetch without a circular recovery wait", async () => {
    const f = fixture();
    const results = await Promise.all([f.run(false), f.run(true)]);
    assert.ok(results.every((r) => r.kind === "verified"));
    assert.equal(f.calls.filter((c) => c === "fetch").length, 1);
    assert.equal(f.calls.filter((c) => c.id?.endsWith("acceptRemotePinSnapshot")).length, 1);
});

test("detached or local-only projects use local policy without a fetch", async () => {
    const f = fixture({ branch: "", token: "" });
    assert.equal((await f.run(false)).kind, "local");
    assert.equal(f.calls.includes("fetch"), false);
    assert.ok(f.calls.some((c) => c.id?.endsWith("beginRemotePinCheck")));
});
test("startup remote unpin does not depend on Editor activation ordering", async () => {
    const f = fixture({ editorReady: false });
    assert.equal((await f.run(false)).kind, "verified");
    assert.ok(f.calls.some((c) => c.id?.endsWith("writeProjectPins")));
    assert.equal(
        f.calls.some((c) => c.id?.endsWith("reconcilePinPolicy")),
        false,
    );
});
test("native startup fallback protects unsaved metadata", async () => {
    const f = fixture({ editorReady: false, dirty: true });
    assert.equal((await f.run(false)).kind, "invalid");
    assert.equal(
        f.calls.some((c) => c.id?.endsWith("writeProjectPins")),
        false,
    );
});
test("discovery delegates pending edits to the native per-extension merge", async () => {
    const f = fixture({ pendingIntent: true });
    assert.equal((await f.run(false)).kind, "verified");
    assert.equal(
        f.calls.some(
            (c) => c.id?.endsWith("writeProjectPins") || c.id?.endsWith("applyRemoteProjectPins"),
        ),
        true,
    );
});
test("source fencing runs before slow credential acquisition", async () => {
    let release;
    const credentials = new Promise((resolve) => (release = resolve));
    const f = fixture({ token: () => credentials });
    const pending = f.run(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(f.calls.some((c) => c.id?.endsWith("beginRemotePinCheck")));
    assert.equal(f.calls.includes("fetch"), false);
    release(undefined);
    assert.equal((await pending).kind, "authentication-required");
});

test("stalled credential lookup releases shared discovery with an offline result", async () => {
    const f = fixture({ token: () => new Promise(() => {}), credentialTimeout: true });
    assert.equal((await f.run(false)).kind, "unavailable");
    assert.equal((await f.run(false)).kind, "unavailable");
    assert.equal(f.calls.includes("fetch"), false);
});

test("unreadable Git identity does not erase a previously accepted source", async () => {
    const f = fixture({ sourceUnavailable: true });
    assert.equal((await f.run(false)).kind, "unavailable");
    assert.equal(
        f.calls.some(
            (c) =>
                c.id?.endsWith("beginRemotePinCheck") || c.id?.endsWith("acceptRemotePinSnapshot"),
        ),
        false,
    );
});

test("offline startup persists an accepted cached unpin before recovery", async () => {
    const f = fixture({ offline: true, cachedRemote: true, editorReady: false });
    assert.equal((await f.run(false)).kind, "unavailable");
    assert.ok(f.calls.some((c) => c.id?.endsWith("writeProjectPins")));
    assert.equal(
        f.calls.some((c) => c.id?.endsWith("acceptRemotePinSnapshot")),
        false,
    );
});

const decisions = loadDecisions();

test("timestamp decisions merge independently and removals survive stale pins", () => {
    const { mergePinDecisions, activePins } = decisions;
    const old = { version: "1", url: "https://example.invalid/1.vsix" };
    const next = { version: "2", url: "https://example.invalid/2.vsix" };
    const merged = mergePinDecisions({ editor: { timestamp: 20 }, frontier: { ...old, timestamp: 10 } }, { editor: { ...old, timestamp: 10 }, frontier: { ...next, timestamp: 30 } });
    assert.equal(merged.editor.timestamp, 20);
    assert.equal(merged.editor.version, undefined);
    assert.equal(merged.frontier.version, "2");
    assert.deepEqual(Object.keys(activePins(merged)), ["frontier"]);
    assert.equal(JSON.stringify(mergePinDecisions(merged, { editor: old })), JSON.stringify(merged));
    assert.equal(mergePinDecisions({ editor: old }, { editor: { timestamp: 0 } }).editor.timestamp, 0);
    assert.equal(mergePinDecisions({ editor: { timestamp: 0 } }, {}).editor.timestamp, 0);
    assert.equal(Object.keys(mergePinDecisions({ editor: old }, {})).length, 0);
});
test("explicit edits stamp only their extension and preserve clocks across merges", () => {
    const { editPinDecisions, mergePinDecisions } = decisions;
    const pin = { version: "1", url: "https://example.invalid/1.vsix" };
    const current = { editor: { ...pin, timestamp: 100 }, frontier: { ...pin, timestamp: 50 } };
    const removed = editPinDecisions(current, { editor: null }, 90);
    assert.equal(removed.editor.timestamp, 101);
    assert.deepEqual(Object.keys(removed.editor), ["timestamp"]);
    assert.equal(removed.frontier.timestamp, 50);
    const repinned = editPinDecisions(removed, { editor: pin }, 102);
    assert.equal(repinned.editor.timestamp, 102);
    assert.equal(repinned.editor.version, "1");
    assert.equal(mergePinDecisions(repinned, removed).editor.timestamp, 102);
});
test("invalid timestamps and incomplete pins fail closed", () => {
    for (const entry of [{ timestamp: -1 }, { timestamp: "1" }, { timestamp: NaN }, { timestamp: Infinity }, { timestamp: 1.5 }, { timestamp: Number.MAX_SAFE_INTEGER + 1 }, {}, { timestamp: 1, version: "1" }, { timestamp: 1, version: "", url: "" }]) {
        assert.throws(() => decisions.validatePinDecisions({ editor: entry }));
    }
});

test("discovery forwards independent timestamps and unpins without rewriting their clocks", async () => {
    const remotePins = { editor: { timestamp: 20 }, frontier: { timestamp: 10, version: "1", url: "https://example.invalid/1.vsix" } };
    const f = fixture({ remotePins, pendingIntent: true, editorReady: false });
    assert.equal((await f.run(false)).kind, "verified");
    const submitted = f.calls.find(c => c.id?.endsWith("acceptRemotePinSnapshot"));
    assert.deepEqual(JSON.parse(JSON.stringify(submitted.arg.snapshot.pins)), remotePins);
    assert.ok(f.calls.some(c => c.id?.endsWith("writeProjectPins")));
});
test("invalid per-extension timestamps block acceptance rather than synthesize removal", async () => {
    const f = fixture({ remotePins: { editor: { timestamp: -1 } } });
    assert.equal((await f.run()).kind, "invalid");
    assert.equal(f.calls.some(c => c.id?.endsWith("acceptRemotePinSnapshot")), false);
});

test("timestamp-only unpins do not bypass normal sync version requirements", async () => {
    const source = ts.createSourceFile("checker.ts", fs.readFileSync(path.join(__dirname, "../src/utils/extensionVersionChecker.ts"), "utf8"), ts.ScriptTarget.Latest, true);
    const fn = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === "checkMetadataVersionsForSync");
    const policy = { mode: "enforce", phase: "ready", pins: { editor: { timestamp: 20 }, frontier: { timestamp: 10, version: "1", url: "https://example.invalid/1.vsix" } } };
    let checked;
    const context = { exports: {}, console, Set, activePins: decisions.activePins,
        getPinPolicy: async () => policy,
        vscode: { commands: { executeCommand: async () => policy } },
        checkAndUpdateMetadataVersions: async ids => { checked = Array.from(ids); return { canSync: true }; },
        require: () => ({ getSCMManager: () => ({ discoverProjectPins: async () => ({ kind: "unavailable" }) }) }),
    };
    vm.runInNewContext(ts.transpileModule(fn.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
    assert.equal(await context.exports.checkMetadataVersionsForSync({}), true);
    assert.deepEqual(checked, ["frontier"]);
});
test("post-fast-forward persistence retains unpins and skips other workspaces", async () => {
    const source = ts.createSourceFile("git.ts", fs.readFileSync(path.join(__dirname, "../src/git/GitService.ts"), "utf8"), ts.ScriptTarget.Latest, true);
    const cls = source.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === "GitService");
    const method = cls.members.find(m => m.name?.getText(source) === "commitPinDecisions");
    const old = { editor: { timestamp: 10, version: "1", url: "https://example.invalid/1.vsix" } };
    const removal = { editor: { timestamp: 20 } };
    let disk = JSON.stringify({ meta: { pinnedExtensions: old } });
    let staged = 1, writes = 0, commits = 0;
    const policy = { remote: { pins: removal }, generation: 1, workspace: "/project" };
    const context = { exports: {}, JSON, TextDecoder, path,
        EXTENSION_PIN_POLICY: { ignoreProjectPins: false },
        getPinPolicy: async () => policy,
        persistAcceptedPins: async () => { writes++; disk = JSON.stringify({ meta: { pinnedExtensions: decisions.mergePinDecisions(JSON.parse(disk).meta.pinnedExtensions, removal) } }); },
        vscode: { Uri: { file: p => ({ toString: () => p }) } },
        fs: { promises: { readFile: async () => disk } },
        dugiteGit: { statusMatrix: async () => [["metadata.json", 1, 2, staged]], readBlobAtRef: async () => Buffer.from(JSON.stringify({ meta: { pinnedExtensions: old } })), add: async () => { staged = 2; } },
    };
    vm.runInNewContext(ts.transpileModule(`class Harness { ${method.getText(source)} }; exports.Harness = Harness;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
    const service = new context.exports.Harness(); service.commit = async () => { commits++; };
    await service.commitPinDecisions("/project", {});
    assert.deepEqual(JSON.parse(disk).meta.pinnedExtensions, removal);
    assert.equal(commits, 1);
    await service.commitPinDecisions("/different-project", {});
    assert.equal(writes, 1);
});

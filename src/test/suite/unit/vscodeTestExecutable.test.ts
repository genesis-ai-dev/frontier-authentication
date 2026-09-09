import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveVSCodeTestExecutable } from "../../vscodeTestExecutable";

suite("VS Code test executable resolution", () => {
    let root: string;
    let legacyPath: string;
    let modernPath: string;

    const executable = (filePath: string) => fs.writeFileSync(filePath, "test executable", { mode: 0o755 });

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-vscode-executable-"));
        const directory = path.join(root, "Visual Studio Code.app", "Contents", "MacOS");
        fs.mkdirSync(directory, { recursive: true });
        legacyPath = path.join(directory, "Electron");
        modernPath = path.join(directory, "Code");
    });

    teardown(() => fs.rmSync(root, { recursive: true, force: true }));

    test("uses Code when the downloader returns the missing Electron path", () => {
        executable(modernPath);
        assert.strictEqual(resolveVSCodeTestExecutable(legacyPath, "darwin"), modernPath);
    });

    test("keeps a valid supplied executable when both names exist", () => {
        executable(legacyPath);
        executable(modernPath);
        assert.strictEqual(resolveVSCodeTestExecutable(legacyPath, "darwin"), legacyPath);
        assert.strictEqual(resolveVSCodeTestExecutable(modernPath, "darwin"), modernPath);
    });

    test("supports an older bundle when a downloader expects the new name", () => {
        executable(legacyPath);
        assert.strictEqual(resolveVSCodeTestExecutable(modernPath, "darwin"), legacyPath);
    });

    test("never applies the macOS fallback on another platform", () => {
        executable(modernPath);
        assert.throws(() => resolveVSCodeTestExecutable(legacyPath, "linux"), /missing or not executable/);
        assert.strictEqual(resolveVSCodeTestExecutable(modernPath, "linux"), modernPath);
    });

    test("reports the checked paths when the cached executable is missing", () => {
        assert.throws(() => resolveVSCodeTestExecutable(legacyPath, "darwin"), (error: Error) => {
            return error.message.includes(legacyPath) && error.message.includes(modernPath);
        });
    });

    test("does not mistake a directory for an executable", () => {
        fs.mkdirSync(modernPath);
        assert.throws(() => resolveVSCodeTestExecutable(legacyPath, "darwin"), /missing or not executable/);
    });
});

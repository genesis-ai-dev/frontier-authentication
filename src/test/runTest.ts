import * as path from "path";
import * as fs from "fs";

import {
    downloadAndUnzipVSCode,
    runTests,
} from "@vscode/test-electron";
import { resolveVSCodeTestExecutable } from "./vscodeTestExecutable";

async function cleanupTestUserData(testUserDataDir: string) {
    if (fs.existsSync(testUserDataDir)) {
        try {
            fs.rmSync(testUserDataDir, { recursive: true, force: true });
        } catch (error) {
            console.warn("Failed to cleanup test user data:", error);
        }
    }
}

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, "../../");
        const extensionTestsPath = path.resolve(__dirname, "./suite/index");
        const testUserDataDir = path.resolve(__dirname, "../test-data");
        const workspacePath = extensionDevelopmentPath;

        // Cleanup before running tests
        await cleanupTestUserData(testUserDataDir);

        await runTests({
            vscodeExecutablePath: resolveVSCodeTestExecutable(await downloadAndUnzipVSCode()),
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                workspacePath,
                "--disable-extensions",
                "--disable-telemetry",
                "--user-data-dir",
                testUserDataDir,
            ],
            extensionTestsEnv: {
                VSCODE_TEST_MODE: "true",
                NODE_ENV: "test",
            },
        });
    } catch (err) {
        console.error("Failed to run tests:", err);
        process.exit(1);
    }
}

main();

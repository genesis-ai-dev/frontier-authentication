import * as fs from "fs";
import * as path from "path";

/** Resolve executable names used by older and newer VS Code macOS bundles. */
export function resolveVSCodeTestExecutable(
    downloadedPath: string,
    platform: NodeJS.Platform = process.platform,
): string {
    const candidates = [downloadedPath];
    const directory = path.dirname(downloadedPath);
    const name = path.basename(downloadedPath);
    if (platform === "darwin" && path.basename(directory) === "MacOS" &&
        (name === "Electron" || name === "Code")) {
        candidates.push(path.join(directory, name === "Electron" ? "Code" : "Electron"));
    }

    for (const candidate of candidates) {
        try {
            if (!fs.statSync(candidate).isFile()) {
                continue;
            }
            fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
            return candidate;
        } catch {
            // Try only the alternate executable in the same macOS app bundle.
        }
    }

    throw new Error(
        `VS Code test executable is missing or not executable. Checked: ${candidates.join(", ")}. ` +
        "Check the cached VS Code installation before retrying the tests.",
    );
}

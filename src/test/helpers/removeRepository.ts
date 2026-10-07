import * as fs from "fs";
import * as path from "path";

/**
 * Native git writes loose objects read-only, and Windows refuses to delete a
 * read-only file until the attribute is cleared. Make the tree writable first.
 */
export function removeRepository(dir: string): void {
    const makeWritable = (entry: string): void => {
        const stat = fs.lstatSync(entry);
        if (stat.isSymbolicLink()) { return; }
        fs.chmodSync(entry, stat.isDirectory() ? 0o777 : 0o666);
        if (stat.isDirectory()) {
            for (const child of fs.readdirSync(entry)) { makeWritable(path.join(entry, child)); }
        }
    };
    makeWritable(dir);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

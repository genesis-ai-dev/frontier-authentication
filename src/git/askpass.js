#!/usr/bin/env node
/**
 * GIT_ASKPASS helper script for dugite credential injection.
 *
 * Git calls this script with a prompt string like:
 *   "Username for 'https://gitlab.com': "
 *   "Password for 'https://oauth2@gitlab.com': "
 *
 * We return the value from the corresponding environment variable.
 */

const prompt = (process.argv[2] || "").toLowerCase();

if (prompt.includes("username")) {
    process.stdout.write(process.env.FRONTIER_GIT_USERNAME || "");
} else if (prompt.includes("password")) {
    process.stdout.write(process.env.FRONTIER_GIT_PASSWORD || "");
} else {
    // Unknown prompt — return empty to avoid hanging
    process.stdout.write("");
}

process.exit(0);

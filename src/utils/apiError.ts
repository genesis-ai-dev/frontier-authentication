/**
 * Error thrown by GitLab API calls. Carries the response body, URL, method,
 * and operation label so that codex-editor's "Copy Error Details" toast can
 * surface the underlying GitLab message (e.g. "Your password expired...")
 * to support staff. Without this, an opaque "Forbidden" status text is the
 * only thing users see, which makes diagnostics impossible.
 */
export class GitLabApiError extends Error {
    public readonly name = "GitLabApiError";
    public readonly timestamp: string = new Date().toISOString();

    constructor(
        public readonly operation: string,
        public readonly status: number,
        public readonly statusText: string,
        public readonly url: string,
        public readonly method: string,
        public readonly body: string,
    ) {
        super(buildShortMessage(operation, status, statusText, body));
    }
}

/**
 * Build a short, human-readable summary suitable for the `.message` field.
 * Uses the parsed JSON `message`/`error` from a GitLab error body when present,
 * otherwise falls back to the raw body, otherwise just the status line.
 */
function buildShortMessage(
    operation: string,
    status: number,
    statusText: string,
    body: string,
): string {
    let detail = "";
    if (body) {
        try {
            const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
            const msg = parsed.message ?? parsed.error;
            detail = typeof msg === "string" ? msg : JSON.stringify(msg ?? body);
        } catch {
            detail = body;
        }
    }
    const trimmed = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
    const head = `Failed to ${operation}: ${status} ${statusText}`;
    return trimmed ? `${head} — ${trimmed}` : head;
}

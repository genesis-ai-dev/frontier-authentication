import * as vscode from "vscode";
import {
    GlobalState,
    AuthState,
    GitLabInfo,
    GitLabCredentials,
    UserInfo,
    MediaFilesStrategy,
} from "../types/state";
import * as fs from "fs";
import * as path from "path";

// Lock detection thresholds
export const HEARTBEAT_INTERVAL = 15 * 1000;           // 15 seconds
const HEARTBEAT_DEAD_THRESHOLD = 45 * 1000;     // 3 missed heartbeats = DEAD
const PROGRESS_STUCK_THRESHOLD = 2 * 60 * 1000; // 2 minutes no progress = STUCK
const PHASE_GRACE_PERIOD = 3 * 60 * 1000;       // 3 minutes for CPU-bound phases

export const initialState: GlobalState = {
    auth: {
        isAuthenticated: false,
        connectionStatus: "disconnected",
        currentView: "login",
        gitlabInfo: undefined,
        gitlabCredentials: undefined,
        lastSyncTimestamp: undefined,
    },
    metrics: {
        lfsHealAttempted: 0,
        lfsHealSucceeded: 0,
        lfsHealFailed: 0,
    },
};

export class StateManager {
    private static instance: StateManager;
    private state: GlobalState;
    private readonly stateKey = "frontier.globalState";
    private lockFilePath: string | undefined;
    private hasAcquiredLock: boolean = false;
    private isPidAlive(pid: number): boolean {
        try {
            // Signal 0 checks for existence without killing the process
            process.kill(pid, 0);
            return true;
        } catch (err: any) {
            if (err && (err.code === "ESRCH" || err.code === "ENOENT")) {
                return false; // no such process
            }
            // EPERM or others mean it exists but we don't have permission
            return true;
        }
    }

    private constructor(private context: vscode.ExtensionContext) {
        // Initialize with stored state or defaults
        const storedState = this.context.globalState.get<GlobalState>(this.stateKey);
        this.state = storedState || initialState;

        // Clean up any stale lock files on initialization
        this.cleanupStaleLockFiles();
    }

    static initialize(context: vscode.ExtensionContext): StateManager {
        if (!StateManager.instance) {
            StateManager.instance = new StateManager(context);
        }
        return StateManager.instance;
    }

    static getInstance(): StateManager {
        if (!StateManager.instance) {
            throw new Error("StateManager not initialized");
        }
        return StateManager.instance;
    }

    private async persistState(): Promise<void> {
        await this.context.globalState.update(this.stateKey, this.state);
    }

    getAuthState(): AuthState {
        return { ...this.state.auth };
    }

    async updateAuthState(update: Partial<AuthState>): Promise<void> {
        this.state.auth = {
            ...this.state.auth,
            ...update,
        };
        await this.persistState();
        this.notifyStateChange();
    }

    async updateGitLabCredentials(credentials: GitLabCredentials | undefined): Promise<void> {
        await this.updateAuthState({
            gitlabCredentials: credentials,
        });
    }

    async updateGitLabInfo(info: GitLabInfo | undefined): Promise<void> {
        await this.updateAuthState({
            gitlabInfo: info,
        });
    }

    async updateLastSyncTimestamp(): Promise<void> {
        await this.updateAuthState({
            lastSyncTimestamp: Date.now(),
        });
    }

    getGitLabCredentials(): GitLabCredentials | undefined {
        return this.state.auth.gitlabCredentials;
    }

    getGitLabInfo(): GitLabInfo | undefined {
        return this.state.auth.gitlabInfo;
    }

    getUserInfo(): UserInfo | undefined {
        return this.state.auth.userInfo;
    }

    // ========== Metrics ==========
    incrementMetric(key: keyof NonNullable<GlobalState["metrics"]>): void {
        const current = this.state.metrics || {
            lfsHealAttempted: 0,
            lfsHealSucceeded: 0,
            lfsHealFailed: 0,
        };
        const value = (current[key] || 0) + 1;
        this.state.metrics = { ...current, [key]: value } as any;
        void this.persistState();
        this.notifyStateChange();
    }
    getMetrics(): NonNullable<GlobalState["metrics"]> {
        return (
            this.state.metrics || {
                lfsHealAttempted: 0,
                lfsHealSucceeded: 0,
                lfsHealFailed: 0,
            }
        );
    }

    // ========== Media Strategy per repository ==========
    getRepoStrategy(workspacePath: string): MediaFilesStrategy | undefined {
        return this.state.repoStrategies?.[workspacePath];
    }

    async setRepoStrategy(workspacePath: string, strategy: MediaFilesStrategy): Promise<void> {
        const existing = this.state.repoStrategies || {};
        this.state.repoStrategies = { ...existing, [workspacePath]: strategy };
        await this.persistState();
        this.notifyStateChange();
    }

    // Sync lock methods
    async acquireSyncLock(workspacePath: string | undefined): Promise<boolean> {
        // Get workspace folder for lock file
        if (!workspacePath) {
            workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                console.log("No workspace folder found, cannot create lock file");
                return false;
            }
        }
        // Create lock file path in .git directory (do not mark acquired yet)
        const gitDir = path.join(workspacePath, ".git");
        const lockPath = path.join(gitDir, "frontier-sync.lock");

        try {
            // Try to create the lock file
            const payload = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
            await fs.promises.writeFile(lockPath, payload, { flag: "wx" });
            // Only now mark the lock as acquired and record the path
            this.lockFilePath = lockPath;
            this.hasAcquiredLock = true;
            console.log("Sync lock acquired");
            return true;
        } catch (error) {
            // Check if lock is stale (older than 5 minutes)
            try {
                const lockContent = await fs.promises.readFile(lockPath, "utf8");
                let lockTime: number | undefined;
                let lockPid: number | undefined;
                try {
                    const parsed = JSON.parse(lockContent);
                    lockTime = typeof parsed.timestamp === "number" ? parsed.timestamp : undefined;
                    lockPid = typeof parsed.pid === "number" ? parsed.pid : undefined;
                } catch {
                    // Legacy format: content is just the timestamp
                    const legacy = parseInt(lockContent);
                    lockTime = isNaN(legacy) ? undefined : legacy;
                }
                const now = Date.now();
                const fiveMinutesInMs = 5 * 60 * 1000;

                const isStale = typeof lockTime === "number" && now - lockTime > fiveMinutesInMs;
                const ownerGone = typeof lockPid === "number" ? !this.isPidAlive(lockPid) : false;
                const legacyAndStale = typeof lockPid !== "number" && isStale;

                if (ownerGone || legacyAndStale) {
                    // Lock is stale, force release it
                    console.log(
                        ownerGone
                            ? "Orphaned sync lock detected (owner process gone), releasing it"
                            : "Legacy stale sync lock detected, releasing it"
                    );
                    // Directly remove stale file (we don't own an acquired lock here)
                    try {
                        await fs.promises.unlink(lockPath);
                    } catch (unlinkErr) {
                        console.log("Error removing stale lock file:", unlinkErr);
                    }
                    // Try to acquire lock again
                    return this.acquireSyncLock(workspacePath);
                }
            } catch (readError) {
                console.log("Error reading lock file:", readError);
            }

            console.log("Sync already in progress, cannot acquire lock");
            this.hasAcquiredLock = false;
            return false;
        }
    }

    async releaseSyncLock(): Promise<void> {
        if (this.hasAcquiredLock && this.lockFilePath) {
            try {
                // Remove the lock file
                await fs.promises.unlink(this.lockFilePath);
                console.log("Sync lock released");
            } catch (error: any) {
                if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
                    // File already removed externally; treat as released
                    console.log("Lock file already removed; clearing in-memory lock state");
                } else {
                    console.log("Error releasing sync lock:", error);
                    // For non-ENOENT errors, still clear in-memory lock to avoid wedging the session
                }
            } finally {
                this.lockFilePath = undefined;
                this.hasAcquiredLock = false;
            }
        }
    }

    isSyncLocked(): boolean {
        return this.hasAcquiredLock === true;
    }

    private readonly stateChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeState = this.stateChangeEmitter.event;

    private notifyStateChange(): void {
        this.stateChangeEmitter.fire();
    }

    private async cleanupStaleLockFiles(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const gitDir = path.join(workspaceFolders[0].uri.fsPath, ".git");
        const lockFilePath = path.join(gitDir, "frontier-sync.lock");

        try {
            // Check if file exists
            await fs.promises.access(lockFilePath);
            
            // UNCONDITIONALLY delete - syncs NEVER resume
            // Reason: Sync doesn't resume after restart, it always restarts from scratch
            // Any lock from previous session is obsolete
            console.log("[StateManager] Removing sync lock from previous session (syncs restart from scratch)");
            await fs.promises.unlink(lockFilePath);
            console.log("[StateManager] ✓ Lock file cleaned up successfully");
            
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // File doesn't exist - perfect, nothing to do
                return;
            }
            
            // Other error - log but don't fail extension activation
            console.warn("[StateManager] Error accessing lock file during cleanup:", error);
            
            // Try to delete anyway (might be permission issue on access but delete works)
            try {
                await fs.promises.unlink(lockFilePath);
                console.log("[StateManager] ✓ Lock deleted despite access error");
            } catch (deleteError) {
                console.error("[StateManager] ✗ Could not delete lock file:", deleteError);
            }
        }
    }

    /**
     * Check filesystem lock with two-tier detection
     * Returns detailed lock status for decision-making
     */
    async checkFilesystemLock(workspacePath?: string): Promise<{
        exists: boolean;
        isDead: boolean;
        isStuck: boolean;
        age: number;
        progressAge: number;
        pid?: number;
        ownedByUs: boolean;
        phase?: string;
        progress?: { current: number; total: number; description?: string };
        status: 'active' | 'stuck' | 'dead';
    }> {
        if (!workspacePath) {
            workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                return { 
                    exists: false, 
                    isDead: false,
                    isStuck: false,
                    age: 0,
                    progressAge: 0,
                    ownedByUs: false,
                    status: 'active'
                };
            }
        }

        const gitDir = path.join(workspacePath, ".git");
        const lockPath = path.join(gitDir, "frontier-sync.lock");

        try {
            const lockContent = await fs.promises.readFile(lockPath, "utf8");
            
            let lockData: any;
            try {
                lockData = JSON.parse(lockContent);
            } catch {
                // Corrupted lock file - treat as dead
                console.warn("[StateManager] Corrupted lock file, treating as dead");
                return {
                    exists: true,
                    isDead: true,
                    isStuck: false,
                    age: Infinity,
                    progressAge: Infinity,
                    ownedByUs: false,
                    status: 'dead'
                };
            }

            const now = Date.now();
            const heartbeatAge = lockData.timestamp ? now - lockData.timestamp : Infinity;
            const progressAge = lockData.lastProgress ? now - lockData.lastProgress : heartbeatAge;
            const phaseAge = lockData.phaseChangedAt ? now - lockData.phaseChangedAt : progressAge;
            
            // Check ownership
            const ownedByUs = lockData.pid === process.pid && this.hasAcquiredLock;
            
            // TIER 1: Dead process detection (45 seconds)
            if (heartbeatAge > HEARTBEAT_DEAD_THRESHOLD) {
                return {
                    exists: true,
                    isDead: true,
                    isStuck: false,
                    age: heartbeatAge,
                    progressAge,
                    pid: lockData.pid,
                    ownedByUs,
                    phase: lockData.phase,
                    progress: lockData.progress,
                    status: 'dead'
                };
            }
            
            // TIER 2: Stuck detection (2 minutes no progress)
            // Grace period for CPU-bound operations that don't report progress
            const cpuBoundPhases = ['merging', 'analyzing', 'committing'];
            const inGracePeriod = cpuBoundPhases.includes(lockData.phase) && 
                                 phaseAge < PHASE_GRACE_PERIOD;
            
            if (progressAge > PROGRESS_STUCK_THRESHOLD && !inGracePeriod) {
                return {
                    exists: true,
                    isDead: false,
                    isStuck: true,
                    age: heartbeatAge,
                    progressAge,
                    pid: lockData.pid,
                    ownedByUs,
                    phase: lockData.phase,
                    progress: lockData.progress,
                    status: 'stuck'
                };
            }
            
            // Active sync
            return {
                exists: true,
                isDead: false,
                isStuck: false,
                age: heartbeatAge,
                progressAge,
                pid: lockData.pid,
                ownedByUs,
                phase: lockData.phase,
                progress: lockData.progress,
                status: 'active'
            };
            
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return { 
                    exists: false, 
                    isDead: false,
                    isStuck: false,
                    age: 0,
                    progressAge: 0,
                    ownedByUs: false,
                    status: 'active'
                };
            }
            
            console.error("[StateManager] Error reading lock file:", error);
            throw error;
        }
    }

    /**
     * Force cleanup of a lock (called after stale/dead detection)
     */
    async cleanupStaleLock(workspacePath?: string): Promise<void> {
        if (!workspacePath) {
            workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                return;
            }
        }
        
        const gitDir = path.join(workspacePath, ".git");
        const lockPath = path.join(gitDir, "frontier-sync.lock");
        
        try {
            await fs.promises.unlink(lockPath);
            console.log("[StateManager] Cleaned up sync lock");
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                console.error("[StateManager] Error cleaning up lock:", error);
            }
        }
    }

    /**
     * Update lock with heartbeat and optional progress
     * Called every 15 seconds and when progress is made
     */
    async updateLockHeartbeat(data?: {
        timestamp?: number;
        lastProgress?: number;
        phase?: string;
        progress?: { current: number; total: number; description?: string };
    }): Promise<void> {
        // Capture path locally so it can't become undefined between the guard
        // and the async fs calls if releaseSyncLock() runs concurrently.
        const filePath = this.lockFilePath;
        if (!this.hasAcquiredLock || !filePath) {
            return;
        }
        
        try {
            let existingData: any = { pid: process.pid };
            try {
                const content = await fs.promises.readFile(filePath, 'utf8');
                existingData = JSON.parse(content);
            } catch {
                // File missing or corrupted - will create fresh
            }

            // If lock was released while we were reading, bail out
            if (!this.hasAcquiredLock) {
                return;
            }
            
            const payload = JSON.stringify({
                ...existingData,
                pid: process.pid,
                timestamp: data?.timestamp || Date.now(),
                lastProgress: data?.lastProgress || existingData.lastProgress || Date.now(),
                phase: data?.phase || existingData.phase || 'syncing',
                phaseChangedAt: (data?.phase && data.phase !== existingData.phase) 
                    ? Date.now() 
                    : existingData.phaseChangedAt || Date.now(),
                ...(data?.progress && { progress: data.progress })
            });
            
            await fs.promises.writeFile(filePath, payload, { encoding: 'utf8' });
            
        } catch (error) {
            console.error("[StateManager] Failed to update lock heartbeat:", error);
            throw error;
        }
    }

    dispose(): void {
        this.stateChangeEmitter.dispose();
    }
}

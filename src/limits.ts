// Local limits on what an agent can start through this server process.
//
// The Gameye API has no per-token budget, so these are enforced here, before
// any request. Together they bound the worst case: at most maxSessions running
// at once, each living at most maxTtl, and at most maxLaunches per process.
// Every check fails closed: if the server can't tell how many of its sessions
// are still running, it refuses the launch.

import type { SessionLimits } from "./env.js";
import { AGENT_LABEL_KEY, AGENT_LABEL_VALUE, GuardError } from "./guards.js";
import type { GameyeClient } from "./client.js";
import type { SessionStatus } from "./types.js";

const ENDED: ReadonlySet<string> = new Set<SessionStatus>(["exited", "dead"]);

const UNITS_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };

/**
 * Parse a Gameye TTL (Go duration syntax, e.g. `30m`, `1h`, `2.5h`, `4h50m`) to
 * milliseconds. Returns undefined for anything else. `0` parses to 0.
 */
export function parseDurationMs(text: string): number | undefined {
  const value = text.trim();
  if (value === "0") return 0;
  if (!/^(\d+(\.\d+)?[hms])+$/.test(value)) return undefined;
  let ms = 0;
  for (const [, num, unit] of value.matchAll(/(\d+(?:\.\d+)?)([hms])/g)) {
    ms += Number(num) * UNITS_MS[unit];
  }
  return ms;
}

/** A slot held while one launch is in flight. Settle it exactly once. */
export interface LaunchReservation {
  /** The launch succeeded with this session ID. */
  started(id: string): void;
  /** The launch failed. `maybeStarted` when the outcome is unknown (timeout, network error). */
  failed(maybeStarted: boolean): void;
}

export class SessionLimiter {
  private inFlight = 0;
  private launches = 0;
  private unknownSeq = 0;
  /** Sessions this process started (or may have started) that may still run: id → expiry time. */
  private readonly live = new Map<string, number>();
  /** Every session ID this process started, for GAMEYE_STOP_OWN_ONLY. */
  private readonly own = new Set<string>();

  constructor(
    readonly limits: SessionLimits,
    private readonly client: Pick<GameyeClient, "listSessions">,
    private readonly now: () => number = Date.now
  ) {}

  /** Refuse a TTL above GAMEYE_MAX_TTL, a zero TTL, or one that can't be parsed. Returns it in ms. */
  checkTtl(ttl: string): number {
    const ms = parseDurationMs(ttl);
    if (ms === undefined) {
      throw new GuardError(
        `Launch refused: ttl "${ttl}" is not a duration like 30m, 1h or 2.5h. No session was started.`
      );
    }
    if (ms === 0 || ms > this.limits.maxTtlMs) {
      throw new GuardError(
        `Launch refused: ttl "${ttl}" is above this server's limit of ${this.limits.maxTtl} (GAMEYE_MAX_TTL). ` +
          `Pass a ttl of ${this.limits.maxTtl} or less. No session was started.`
      );
    }
    return ms;
  }

  /**
   * Hold a launch slot, or refuse with a GuardError. Counts this process's
   * sessions that are still running, plus launches in flight.
   */
  async reserve(ttlMs: number): Promise<LaunchReservation> {
    const { maxLaunches, maxSessions } = this.limits;
    if (this.launches + this.inFlight >= maxLaunches) {
      throw new GuardError(
        `Launch refused: this server has already started ${this.launches} session(s), its limit per run (GAMEYE_MAX_LAUNCHES=${maxLaunches}). ` +
          "Restart the MCP server to reset it, or ask the user to raise the limit. No session was started."
      );
    }

    this.inFlight++;
    let running: number;
    try {
      running = await this.countRunning();
    } catch (err) {
      this.inFlight--;
      const reason = err instanceof Error ? err.message : String(err);
      throw new GuardError(
        `Launch refused: couldn't check how many of this server's sessions are still running (${reason}). ` +
          "The session limit fails closed. Try again in a moment. No session was started."
      );
    }
    if (running + this.inFlight > maxSessions) {
      this.inFlight--;
      throw new GuardError(
        `Launch refused: ${running} session(s) started by this server are still running, and its limit is ${maxSessions} at once (GAMEYE_MAX_SESSIONS). ` +
          "Stop one you no longer need with gameye_stop_session, or wait for its TTL. No session was started."
      );
    }

    let settled = false;
    const settle = () => {
      if (settled) throw new Error("launch reservation settled twice");
      settled = true;
      this.inFlight--;
    };
    return {
      started: (id) => {
        settle();
        this.launches++;
        this.own.add(id);
        this.live.set(id, this.now() + ttlMs);
      },
      failed: (maybeStarted) => {
        settle();
        if (!maybeStarted) return;
        // The session may exist under an ID we never saw: count it until its TTL ends.
        this.launches++;
        this.live.set(`unknown-${++this.unknownSeq}`, this.now() + ttlMs);
      },
    };
  }

  /** True when this process started the session. */
  isOwn(id: string): boolean {
    return this.own.has(id);
  }

  /** The session was stopped: it no longer counts toward GAMEYE_MAX_SESSIONS. */
  stopped(id: string): void {
    this.live.delete(id);
  }

  /** Number of sessions this process started that may still be running. */
  private async countRunning(): Promise<number> {
    const now = this.now();
    for (const [id, expiresAt] of this.live) {
      if (expiresAt <= now) this.live.delete(id);
    }
    if (this.live.size === 0) return 0;

    // Labelled sessions report their status. Warm-pool sessions carry no label, so
    // they are missing from the list and keep counting until their TTL ends.
    const { items } = await this.client.listSessions({ all: true, filter: { [AGENT_LABEL_KEY]: AGENT_LABEL_VALUE } });
    for (const s of items) {
      if (ENDED.has(s.status)) this.live.delete(s.id);
    }
    return this.live.size;
  }
}

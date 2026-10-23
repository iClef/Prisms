import { createHash, randomUUID } from "node:crypto";
import {
  acquireLock,
  cacheGet,
  cacheSet,
  incrBy,
  cacheDel,
  setExpiry,
} from "../redis";
import { config } from "../config";

// ---------------------------------------------------------------------------
// Key prefix constants
// ---------------------------------------------------------------------------
const DEDUP_PREFIX = "grat:dedup:";
const RESULT_PREFIX = "grat:result:";
const FAILURE_PREFIX = "grat:dedup:failures:";
const BLACKLIST_PREFIX = "grat:dedup:blacklist:";

// ---------------------------------------------------------------------------
// Blacklist configuration
// ---------------------------------------------------------------------------

/** Number of consecutive failures before a fingerprint is blacklisted. */
export const BLACKLIST_FAILURE_THRESHOLD = 3;

/** How long (ms) a blacklisted fingerprint is blocked before it can be retried. */
export const BLACKLIST_COOLDOWN_MS = 10 * 60_000;

export class BlacklistedTransactionError extends Error {
  constructor(txHash: string) {
    super(
      `Transaction ${txHash} is temporarily blocked after repeated processing failures. Retry after the 10-minute cooldown.`,
    );
    this.name = "BlacklistedTransactionError";
  }
}

// ---------------------------------------------------------------------------
// Request fingerprinting
// ---------------------------------------------------------------------------

/**
 * Produces a deterministic SHA-256 fingerprint from the canonical fields of a
 * request.  Two requests with the same txHash + network + requestType will
 * always hash to the same value — this is the dedup key.
 */
export function fingerprint(
  txHash: string,
  network: string,
  requestType: string,
): string {
  const canonical = `${txHash.toLowerCase()}:${network.toLowerCase()}:${requestType.toLowerCase()}`;
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Dedup lifecycle
// ---------------------------------------------------------------------------

export interface DedupAcquireResult {
  /** Whether this caller "won" the lock and should do the work. */
  acquired: boolean;

  /** The fingerprint (dedup key). */
  fingerprint: string;

  /** Unique ID for this request attempt. */
  requestId: string;
}

/**
 * Attempt to acquire the dedup lock for a given request fingerprint.
 *
 * - If acquired → this caller is responsible for doing the work and then
 *   calling `publishResult()`.
 * - If NOT acquired → a duplicate is already in-flight. Call `waitForResult()`
 *   to coalesce on the original request's response.
 */
export async function tryAcquire(fp: string): Promise<DedupAcquireResult> {
  const requestId = randomUUID();
  const dedupKey = `${DEDUP_PREFIX}${fp}`;
  const windowMs = config.cache.dedupWindowMs;

  const acquired = await acquireLock(dedupKey, requestId, windowMs);

  return { acquired, fingerprint: fp, requestId };
}

/**
 * Publish the result of a completed (or failed) request so any coalesced
 * waiters can pick it up.  The result is stored for the duration of the
 * dedup window so that late arrivals still find it.
 */
export async function publishResult(fp: string, result: string): Promise<void> {
  const resultKey = `${RESULT_PREFIX}${fp}`;
  const ttlSeconds = Math.ceil(config.cache.dedupWindowMs / 1000) + 2; // small padding
  await cacheSet(resultKey, result, ttlSeconds);
}

/**
 * Wait for the original request to finish and return its result.
 *
 * Polls the result key at short intervals until it appears or the
 * dedup window expires.  Returns `null` if the window closes without
 * a result (caller should retry or fail).
 */
export async function waitForResult(
  fp: string,
  pollIntervalMs = 250,
): Promise<string | null> {
  const resultKey = `${RESULT_PREFIX}${fp}`;
  const deadline = Date.now() + config.cache.dedupWindowMs + 2_000; // extra buffer

  while (Date.now() < deadline) {
    const value = await cacheGet(resultKey);
    if (value !== null) return value;
    await sleep(pollIntervalMs);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Blacklist helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a fingerprint is currently blacklisted.
 * Returns true if it is blocked and false if it may proceed.
 */
export async function isBlacklisted(fp: string): Promise<boolean> {
  const key = `${BLACKLIST_PREFIX}${fp}`;
  const value = await cacheGet(key);
  return value !== null;
}

/**
 * Record a processing failure for a fingerprint.
 *
 * - Increments the failure counter (with a TTL matching the blacklist cooldown
 *   so stale counts do not accumulate).
 * - Automatically blacklists the fingerprint once
 *   `BLACKLIST_FAILURE_THRESHOLD` consecutive failures are reached.
 *
 * Returns the updated failure count.
 */
export async function recordFailure(fp: string): Promise<number> {
  const failKey = `${FAILURE_PREFIX}${fp}`;
  const cooldownSeconds = Math.ceil(BLACKLIST_COOLDOWN_MS / 1000);

  const count = await incrBy(failKey, 1);

  // Set the TTL only on the first increment so it functions as a rolling
  // window; the key expires automatically if no additional failures arrive.
  if (count === 1) {
    await setExpiry(failKey, cooldownSeconds);
  }

  if (count >= BLACKLIST_FAILURE_THRESHOLD) {
    const blacklistKey = `${BLACKLIST_PREFIX}${fp}`;
    await cacheSet(blacklistKey, "1", cooldownSeconds);
    // Clear the failure counter — the blacklist entry now governs the block.
    await cacheDel(failKey);
  }

  return count;
}

/**
 * Reset the failure counter for a fingerprint (e.g. after successful
 * processing).  Also removes any active blacklist entry.
 */
export async function resetFailures(fp: string): Promise<void> {
  const failKey = `${FAILURE_PREFIX}${fp}`;
  const blacklistKey = `${BLACKLIST_PREFIX}${fp}`;
  await cacheDel(failKey, blacklistKey);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

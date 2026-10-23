/**
 * Thrown when the hourly or daily token budget has been exhausted.
 */
export class BudgetExceededError extends Error {
  public readonly hourlyRemaining: number;
  public readonly dailyRemaining: number;
  public readonly resetAt: Date;

  constructor(opts: {
    hourlyRemaining: number;
    dailyRemaining: number;
    resetAt: Date;
  }) {
    const which = opts.hourlyRemaining <= 0 ? "hourly" : "daily";
    super(
      `AI token budget exceeded: ${which} limit reached. ` +
        `Resets at ${opts.resetAt.toISOString()}.`,
    );
    this.name = "BudgetExceededError";
    this.hourlyRemaining = opts.hourlyRemaining;
    this.dailyRemaining = opts.dailyRemaining;
    this.resetAt = opts.resetAt;
  }
}

/**
 * Thrown when the maximum number of concurrent AI requests is already in-flight.
 */
export class ConcurrencyLimitError extends Error {
  public readonly currentActive: number;
  public readonly limit: number;

  constructor(currentActive: number, limit: number) {
    super(
      `AI concurrency limit reached: ${currentActive}/${limit} requests in-flight. ` +
        `Retry after an in-flight request completes.`,
    );
    this.name = "ConcurrencyLimitError";
    this.currentActive = currentActive;
    this.limit = limit;
  }
}

export class BudgetWarningError extends Error {
  public readonly tx_hash: string;
  public readonly resource: "cpu" | "memory";
  public readonly used: number;
  public readonly limit: number;
  public readonly usage_percent: number;
  public readonly threshold_percent: number;

  constructor(opts: {
    txHash: string;
    resource: "cpu" | "memory";
    used: number;
    limit: number;
    thresholdPercent: number;
  }) {
    const usagePercent = (opts.used / opts.limit) * 100;
    super(
      `Replay ${opts.resource} usage for ${opts.txHash} reached ${usagePercent.toFixed(1)}% of its limit (threshold ${opts.thresholdPercent}%).`,
    );
    this.name = "BudgetWarningError";
    this.tx_hash = opts.txHash;
    this.resource = opts.resource;
    this.used = opts.used;
    this.limit = opts.limit;
    this.usage_percent = usagePercent;
    this.threshold_percent = opts.thresholdPercent;
  }
}

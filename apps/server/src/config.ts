import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

type Environment = Record<string, string | undefined>;
type ServerConfig = {
  port: number;
  redisUrl: string;
  sorobanRpcUrl: string;
  gratBinaryPath: string;
  ai: {
    apiKey: string;
    apiBaseUrl: string;
    model: string;
    maxTokensPerRequest: number;
    temperature: number;
    timeoutMs: number;
  };
  budget: {
    hourlyTokenLimit: number;
    dailyTokenLimit: number;
    maxConcurrentRequests: number;
  };
  cache: {
    decodeTtl: number;
    profileTtl: number;
    dedupWindowMs: number;
  };
};

function loadEnvironment(): Environment {
  const nodeEnv = process.env.NODE_ENV || "development";
  const fileEnvironment: Environment = {};

  for (const filename of [".env", ".env.local", `.env.${nodeEnv}`]) {
    const filepath = resolve(process.cwd(), filename);
    if (existsSync(filepath)) {
      Object.assign(fileEnvironment, parse(readFileSync(filepath)));
    }
  }

  return { ...fileEnvironment, ...process.env };
}

const environment = loadEnvironment();

function requiredString(name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function stringValue(name: string, fallback: string): string {
  const value = environment[name]?.trim();
  return value || fallback;
}

function numberValue(
  name: string,
  fallback: number,
  options: { integer?: boolean; min: number; max?: number },
): number {
  const rawValue = environment[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const value = Number(rawValue);
  const valid =
    Number.isFinite(value) &&
    value >= options.min &&
    (options.max === undefined || value <= options.max) &&
    (!options.integer || Number.isInteger(value));

  if (!valid) {
    const range = options.max === undefined ? `at least ${options.min}` : `between ${options.min} and ${options.max}`;
    const type = options.integer ? "an integer" : "a number";
    throw new Error(`Invalid ${name}: expected ${type} ${range}, got "${rawValue}"`);
  }

  return value;
}

function validateUrl(name: string, value: string, protocols: string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected a valid URL, got "${value}"`);
  }

  if (!protocols.includes(url.protocol)) {
    throw new Error(`Invalid ${name}: protocol must be ${protocols.join(" or ")}`);
  }

  return value;
}

function urlValue(name: string, fallback: string, protocols: string[]): string {
  return validateUrl(name, stringValue(name, fallback), protocols);
}

const isProduction = environment.NODE_ENV === "production";

export const config: ServerConfig = {
  port: numberValue("PORT", 3001, { integer: true, min: 1, max: 65535 }),
  redisUrl: isProduction
    ? validateUrl("REDIS_URL", requiredString("REDIS_URL"), ["redis:", "rediss:"])
    : urlValue("REDIS_URL", "redis://localhost:6379", ["redis:", "rediss:"]),
  sorobanRpcUrl: urlValue(
    "SOROBAN_RPC_URL",
    "https://soroban-testnet.stellar.org",
    ["http:", "https:"],
  ),
  gratBinaryPath: stringValue("GRAT_BINARY", "grat"),

  ai: {
    apiKey: environment.AI_API_KEY?.trim() || "",
    apiBaseUrl: urlValue("AI_API_BASE_URL", "https://api.openai.com/v1", ["http:", "https:"]),
    model: stringValue("AI_MODEL", "gpt-4o-mini"),
    maxTokensPerRequest: numberValue("AI_MAX_TOKENS_PER_REQUEST", 2048, {
      integer: true,
      min: 1,
    }),
    temperature: numberValue("AI_TEMPERATURE", 0.2, { min: 0, max: 2 }),
    timeoutMs: numberValue("AI_TIMEOUT_MS", 30_000, { integer: true, min: 1 }),
  },

  budget: {
    hourlyTokenLimit: numberValue("AI_HOURLY_TOKEN_LIMIT", 100_000, {
      integer: true,
      min: 1,
    }),
    dailyTokenLimit: numberValue("AI_DAILY_TOKEN_LIMIT", 1_000_000, {
      integer: true,
      min: 1,
    }),
    maxConcurrentRequests: numberValue("AI_MAX_CONCURRENT", 5, {
      integer: true,
      min: 1,
    }),
  },

  cache: {
    decodeTtl: numberValue("CACHE_DECODE_TTL", 86_400, { integer: true, min: 1 }),
    profileTtl: numberValue("CACHE_PROFILE_TTL", 3_600, { integer: true, min: 1 }),
    dedupWindowMs: numberValue("DEDUP_WINDOW_MS", 10_000, { integer: true, min: 1 }),
  },
};

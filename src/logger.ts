import type { LogLevel } from "./types.js";

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let activeLevel: LogLevel = "info";

export function configureLogger(level: LogLevel) {
  activeLevel = level;
}

function shouldLog(level: LogLevel) {
  return order[level] >= order[activeLevel];
}

function write(level: LogLevel, message: string, meta?: unknown) {
  if (!shouldLog(level)) return;
  const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (meta === undefined) {
    console[level === "debug" ? "log" : level](prefix);
    return;
  }
  console[level === "debug" ? "log" : level](prefix, meta);
}

export const logger = {
  debug: (message: string, meta?: unknown) => write("debug", message, meta),
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
};

import type { PluginClient } from "./types";

interface LogOptions {
  level: "debug" | "info" | "error" | "warn";
  message: string;
  extra?: { [key: string]: unknown };
}

/**
 * Logs a message to the OpenCode log file.
 * Service name is always "antigravity-auth".
 */
export async function log(client: PluginClient, options: LogOptions): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: "antigravity-auth",
        ...options,
      },
    });
  } catch (error) {
    // Fallback to console if OpenCode logging fails
    console.error("[antigravity-auth] Failed to write to OpenCode log:", error);
    console.error(`[antigravity-auth] ${options.level.toUpperCase()}: ${options.message}`, options.extra);
  }
}

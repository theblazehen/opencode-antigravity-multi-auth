import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { storeCachedAuth } from "./cache";
import { invalidateProjectContextCache } from "./project";
import { log } from "./logger";
import type { OAuthAuthDetails, PluginClient, RefreshParts } from "./types";

interface OAuthErrorPayload {
  error?:
    | string
    | {
        code?: string;
        status?: string;
        message?: string;
      };
  error_description?: string;
}

/**
 * Parses OAuth error payloads returned by Google token endpoints, tolerating varied shapes.
 */
function parseOAuthErrorPayload(text: string | undefined): { code?: string; description?: string } {
  if (!text) {
    return {};
  }

  try {
    const payload = JSON.parse(text) as OAuthErrorPayload;
    if (!payload || typeof payload !== "object") {
      return { description: text };
    }

    let code: string | undefined;
    if (typeof payload.error === "string") {
      code = payload.error;
    } else if (payload.error && typeof payload.error === "object") {
      code = payload.error.status ?? payload.error.code;
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message };
      }
    }

    const description = payload.error_description;
    if (description) {
      return { code, description };
    }

    if (payload.error && typeof payload.error === "object" && payload.error.message) {
      return { code, description: payload.error.message };
    }

    return { code };
  } catch {
    return { description: text };
  }
}

/**
 * Refreshes an Antigravity OAuth access token, updates persisted credentials, and handles revocation.
 */
export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  client: PluginClient,
  providerId: string,
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: parts.refreshToken,
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      let errorText: string | undefined;
      try {
        errorText = await response.text();
      } catch {
        errorText = undefined;
      }

      const { code, description } = parseOAuthErrorPayload(errorText);
      const details = [code, description ?? errorText].filter(Boolean).join(": ");
      const baseMessage = `Antigravity token refresh failed (${response.status} ${response.statusText})`;
      
      await log(client, {
        level: "warn",
        message: baseMessage,
        extra: { code, description, details, status: response.status },
      });

      if (code === "invalid_grant") {
        await log(client, {
          level: "error",
          message: "Google revoked the stored refresh token. Run `opencode auth login` and reauthenticate the Google provider.",
          extra: { providerId },
        });
        
        invalidateProjectContextCache(auth.refresh);
        try {
          const clearedAuth: OAuthAuthDetails = {
            type: "oauth",
            refresh: formatRefreshParts({
              refreshToken: "",
              projectId: parts.projectId,
              managedProjectId: parts.managedProjectId,
            }),
          };
          await client.auth.set({
            path: { id: providerId },
            body: clearedAuth,
          });
        } catch (storeError) {
          await log(client, {
            level: "error",
            message: "Failed to clear stored Antigravity OAuth credentials",
            extra: { error: storeError instanceof Error ? storeError.message : String(storeError) },
          });
        }
      }

      return undefined;
    }

    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    const refreshedParts: RefreshParts = {
      refreshToken: payload.refresh_token ?? parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
    };

    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      access: payload.access_token,
      expires: Date.now() + payload.expires_in * 1000,
      refresh: formatRefreshParts(refreshedParts),
    };

    storeCachedAuth(updatedAuth);
    invalidateProjectContextCache(auth.refresh);

    // NOTE: We don't save to client.auth.set here because it would overwrite
    // the multi-account refresh string with just this single account.
    // The caller (plugin.ts) handles saving via accountManager.toAuthDetails()
    // which properly preserves all accounts.

    return updatedAuth;
  } catch (error) {
    await log(client, {
      level: "error",
      message: "Failed to refresh Antigravity access token due to an unexpected error",
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
    return undefined;
  }
}


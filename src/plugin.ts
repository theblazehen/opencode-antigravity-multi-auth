import { exec } from "node:child_process";
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_REDIRECT_URI,
} from "./constants";
import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth";
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth";
import { accessTokenExpired, isOAuthAuth, parseRefreshParts, formatMultiAccountRefresh } from "./plugin/auth";
import { AccountManager } from "./plugin/accounts";
import { promptProjectId, promptAddAnotherAccount } from "./plugin/cli";
import { ensureProjectContext } from "./plugin/project";
import { startAntigravityDebugRequest } from "./plugin/debug";
import {
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from "./plugin/request";
import { refreshAccessToken } from "./plugin/token";
import { startOAuthListener, type OAuthListener } from "./plugin/server";
import type {
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  PluginContext,
  PluginResult,
  ProjectContextResult,
  Provider,
  RefreshParts,
} from "./plugin/types";

/**
 * Performs OAuth flow for a single account.
 * Returns null if user cancels.
 */
async function authenticateSingleAccount(
  isHeadless: boolean,
): Promise<{ refresh: string; access: string; expires: number; projectId: string; email?: string } | null> {
  let listener: OAuthListener | null = null;
  if (!isHeadless) {
    try {
      listener = await startOAuthListener();
    } catch (error) {
      console.log("\nWarning: Couldn't start the local callback listener. Falling back to manual copy/paste.");
    }
  }

  const authorization = await authorizeAntigravity("");

  // Try to open the browser automatically
  if (!isHeadless) {
    try {
      if (process.platform === "darwin") {
        exec(`open "${authorization.url}"`);
      } else if (process.platform === "win32") {
        exec(`start "${authorization.url}"`);
      } else {
        exec(`xdg-open "${authorization.url}"`);
      }
    } catch (e) {
      console.log("Could not open browser automatically. Please copy/paste the URL.");
    }
  }

  let result: AntigravityTokenExchangeResult;

  if (listener) {
    console.log("\nWaiting for browser authentication...");
    try {
      const callbackUrl = await listener.waitForCallback();
      const code = callbackUrl.searchParams.get("code");
      const state = callbackUrl.searchParams.get("state");

      if (!code || !state) {
        console.error("Missing code or state in callback URL");
        return null;
      }

      result = await exchangeAntigravity(code, state);
    } catch (error) {
      console.error("Authentication failed:", error instanceof Error ? error.message : "Unknown error");
      return null;
    } finally {
      try {
        await listener.close();
      } catch {}
    }
  } else {
    // Manual mode
    console.log(`\nOpen this URL in your browser:\n${authorization.url}\n`);
    const { createInterface } = await import("node:readline/promises");
    const { stdin, stdout } = await import("node:process");
    const rl = createInterface({ input: stdin, output: stdout });
    
    try {
      const callbackUrlStr = await rl.question("Paste the full redirect URL here: ");
      const callbackUrl = new URL(callbackUrlStr);
      const code = callbackUrl.searchParams.get("code");
      const state = callbackUrl.searchParams.get("state");

      if (!code || !state) {
        console.error("Missing code or state in callback URL");
        return null;
      }

      result = await exchangeAntigravity(code, state);
    } catch (error) {
      console.error("Authentication failed:", error instanceof Error ? error.message : "Unknown error");
      return null;
    } finally {
      rl.close();
    }
  }

  if (result.type === "failed") {
    console.error("Authentication failed:", result.error);
    return null;
  }

  return {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    projectId: result.projectId,
    email: result.email,
  };
}

/**
 * Creates an Antigravity OAuth plugin for a specific provider ID.
 */
export const createAntigravityPlugin = (providerId: string) => async (
  { client }: PluginContext,
): Promise<PluginResult> => ({
  auth: {
    provider: providerId,
    loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | null> => {
      const auth = await getAuth();
      if (!isOAuthAuth(auth)) {
        return null;
      }

      if (provider.models) {
        for (const model of Object.values(provider.models)) {
          if (model) {
            model.cost = { input: 0, output: 0 };
          }
        }
      }

      return {
        apiKey: "",
        async fetch(input, init) {
          // If the request is for the *other* provider, we might still want to intercept if URL matches
          // But strict compliance means we only handle requests if the auth provider matches.
          // Since loader is instantiated per provider, we are good.

          if (!isGenerativeLanguageRequest(input)) {
            return fetch(input, init);
          }

          const latestAuth = await getAuth();
          if (!isOAuthAuth(latestAuth)) {
            return fetch(input, init);
          }

          // Initialize AccountManager to handle multiple accounts
          const accountManager = new AccountManager(latestAuth);
          const accountCount = accountManager.getAccountCount();

          if (accountCount > 1) {
            console.log(`[Antigravity] Loaded ${accountCount} accounts for rotation`);
          }

          // Helper to resolve project context
          const resolveProjectContext = async (authRecord: OAuthAuthDetails): Promise<ProjectContextResult> => {
            try {
              return await ensureProjectContext(authRecord, client, providerId);
            } catch (error) {
              throw error;
            }
          };

          // Try each account until one succeeds or all are rate-limited
          const maxAccountAttempts = accountCount;
          let accountAttempts = 0;

          while (accountAttempts < maxAccountAttempts) {
            const account = accountManager.getNext();

            if (!account) {
              // All accounts are rate-limited
              const waitTimeMs = accountManager.getMinWaitTime();
              const waitTimeSec = Math.ceil(waitTimeMs / 1000);
              throw new Error(
                `All ${accountCount} account(s) are rate-limited. ` +
                `Please wait ${waitTimeSec}s or add more accounts via 'opencode auth login'.`
              );
            }

            // Get auth for this specific account
            let authRecord = accountManager.accountToAuth(account);

            // Refresh token if expired
            if (accessTokenExpired(authRecord)) {
              const refreshed = await refreshAccessToken(authRecord, client, providerId);
              if (!refreshed) {
                accountAttempts++;
                continue;
              }
              authRecord = refreshed;
              const parts = parseRefreshParts(refreshed.refresh);
              accountManager.updateAccount(account, refreshed.access!, refreshed.expires!, parts);
            }

            const accessToken = authRecord.access;
            if (!accessToken) {
              accountAttempts++;
              continue;
            }

            const projectContext = await resolveProjectContext(authRecord);

            // Endpoint fallback logic: try daily → autopush → prod
            let lastError: Error | null = null;
            let lastResponse: Response | null = null;
            let hitRateLimit = false;

            for (let i = 0; i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length; i++) {
              const currentEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[i];

              try {
                const {
                  request,
                  init: transformedInit,
                  streaming,
                  requestedModel,
                  effectiveModel,
                  projectId: usedProjectId,
                  endpoint: usedEndpoint,
                  toolDebugMissing,
                  toolDebugSummary,
                  toolDebugPayload,
                } = prepareAntigravityRequest(
                  input,
                  init,
                  accessToken,
                  projectContext.effectiveProjectId,
                  currentEndpoint,
                );

                const originalUrl = toUrlString(input);
                const resolvedUrl = toUrlString(request);
                const debugContext = startAntigravityDebugRequest({
                  originalUrl,
                  resolvedUrl,
                  method: transformedInit.method,
                  headers: transformedInit.headers,
                  body: transformedInit.body,
                  streaming,
                  projectId: projectContext.effectiveProjectId,
                });

                const response = await fetch(request, transformedInit);

                // Handle rate limiting - mark account and try next one
                if (response.status === 429) {
                  const retryAfterHeader = response.headers.get("retry-after-ms") || response.headers.get("retry-after");
                  let retryAfterMs = 60000; // Default 60s

                  if (retryAfterHeader) {
                    const parsed = parseInt(retryAfterHeader, 10);
                    if (!isNaN(parsed)) {
                      // If header is in seconds (typical for Retry-After), convert to ms
                      retryAfterMs = retryAfterHeader === response.headers.get("retry-after") ? parsed * 1000 : parsed;
                    }
                  }

                  accountManager.markRateLimited(account, retryAfterMs);
                  hitRateLimit = true;

                  if (accountCount > 1) {
                    console.log(
                      `[Antigravity] Account ${account.index + 1}/${accountCount} rate-limited ` +
                      `(retry after ${Math.ceil(retryAfterMs / 1000)}s), switching to next account...`
                    );
                  }

                  // Break out of endpoint loop to try next account
                  break;
                }

                // Check if we should retry with next endpoint (but not for rate limits)
                const shouldRetryEndpoint = (
                  response.status === 403 || // Forbidden
                  response.status === 404 || // Not Found
                  response.status >= 500     // Server errors
                );

                if (shouldRetryEndpoint && i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                  // Try next endpoint
                  lastResponse = response;
                  continue;
                }

                // Success or final endpoint attempt - save updated auth and return
                try {
                  await client.auth.set({
                    path: { id: providerId },
                    body: accountManager.toAuthDetails(),
                  });
                } catch (saveError) {
                  console.warn("[Antigravity] Failed to save updated auth:", saveError);
                }

                return transformAntigravityResponse(
                  response,
                  streaming,
                  debugContext,
                  requestedModel,
                  usedProjectId,
                  usedEndpoint,
                  effectiveModel,
                  toolDebugMissing,
                  toolDebugSummary,
                  toolDebugPayload,
                );
              } catch (error) {
                // Network error or other exception
                if (i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                  lastError = error instanceof Error ? error : new Error(String(error));
                  continue;
                }

                // Final endpoint attempt failed, throw the error
                throw error;
              }
            }

            // If we hit a rate limit, try the next account
            if (hitRateLimit) {
              accountAttempts++;
              continue;
            }

            // If we get here, all endpoints failed for this account
            if (lastResponse) {
              // Return the last response even if it was an error
              const {
                streaming,
                requestedModel,
                effectiveModel,
                projectId: usedProjectId,
                endpoint: usedEndpoint,
                toolDebugMissing,
                toolDebugSummary,
                toolDebugPayload,
              } = prepareAntigravityRequest(
                input,
                init,
                accessToken,
                projectContext.effectiveProjectId,
                ANTIGRAVITY_ENDPOINT_FALLBACKS[ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1],
              );
              const debugContext = startAntigravityDebugRequest({
                originalUrl: toUrlString(input),
                resolvedUrl: toUrlString(input),
                method: init?.method,
                headers: init?.headers,
                body: init?.body,
                streaming,
                projectId: projectContext.effectiveProjectId,
              });
              return transformAntigravityResponse(
                lastResponse,
                streaming,
                debugContext,
                requestedModel,
                usedProjectId,
                usedEndpoint,
                effectiveModel,
                toolDebugMissing,
                toolDebugSummary,
                toolDebugPayload,
              );
            }

            throw lastError || new Error("All Antigravity endpoints failed");
          }

          // Should never reach here, but just in case
          throw new Error("Failed to complete request with any account");
        },
      };
    },
    methods: [
      {
        label: "OAuth with Google (Antigravity)",
        type: "oauth",
        authorize: async () => {
          const isHeadless = !!(
            process.env.SSH_CONNECTION ||
            process.env.SSH_CLIENT ||
            process.env.SSH_TTY ||
            process.env.OPENCODE_HEADLESS
          );

          // Collect multiple accounts
          const accounts: Array<{ refresh: string; access: string; expires: number; projectId: string; email?: string }> = [];
          
          console.log("\n🔐 Antigravity Multi-Account Setup");
          console.log("You can authenticate multiple Google accounts for automatic load balancing.\n");

          // Get first account
          const firstAccount = await authenticateSingleAccount(isHeadless);
          if (!firstAccount) {
            return {
              url: "",
              instructions: "Authentication cancelled",
              method: "auto",
              callback: async () => ({ type: "failed" as const, error: "Authentication cancelled" }),
            };
          }

          accounts.push(firstAccount);
          console.log(`✓ Account 1 authenticated${firstAccount.email ? ` (${firstAccount.email})` : ""}`);

          // Ask for additional accounts
          while (accounts.length < 10) { // Reasonable limit
            const addAnother = await promptAddAnotherAccount(accounts.length);
            if (!addAnother) {
              break;
            }

            console.log(`\nAuthenticating account ${accounts.length + 1}...`);
            const nextAccount = await authenticateSingleAccount(isHeadless);
            
            if (!nextAccount) {
              console.log("Skipping this account...");
              continue;
            }

            accounts.push(nextAccount);
            console.log(`✓ Account ${accounts.length} authenticated${nextAccount.email ? ` (${nextAccount.email})` : ""}`);
          }

          // Combine all refresh tokens
          console.log(`\n✨ Configured ${accounts.length} account(s) for load balancing!`);

          const refreshParts: RefreshParts[] = accounts.map(acc => ({
            refreshToken: acc.refresh,
            projectId: acc.projectId,
            managedProjectId: undefined,
          }));

          const combinedRefresh = formatMultiAccountRefresh({ accounts: refreshParts });

          // Return a dummy authorization that immediately returns success with combined tokens
          const firstAcc = accounts[0]!;
          return {
            url: "",
            instructions: "Multi-account setup complete!",
            method: "auto",
            callback: async (): Promise<AntigravityTokenExchangeResult> => {
              return {
                type: "success",
                refresh: combinedRefresh,
                access: firstAcc.access,
                expires: firstAcc.expires,
                email: firstAcc.email,
                projectId: firstAcc.projectId,
              };
            },
          };
        },
      },
      {
        provider: providerId,
        label: "Manually enter API Key",
        type: "api",
      },
    ],
  },
});

export const AntigravityCLIOAuthPlugin = createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID);
export const GoogleOAuthPlugin = AntigravityCLIOAuthPlugin;

function toUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

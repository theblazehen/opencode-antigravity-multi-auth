# Antigravity multi-account OAuth Plugin for Opencode

[![npm version](https://img.shields.io/npm/v/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)

Enable Opencode to authenticate against **Antigravity** (Google's IDE) via OAuth so you can use Antigravity rate limits and access models like `gemini-3-pro-high` and `claude-opus-4-5-thinking` with your Google credentials.

## What you get

- **Google OAuth sign-in** with automatic token refresh
- **Antigravity API compatibility** for OpenAI-style requests
- **Debug logging** for requests and responses
- **Drop-in setup**—Opencode auto-installs the plugin from config

## Quick start

1) **Add the plugin to config** (`~/.config/opencode/opencode.json` or project `.opencode.json`):

```json
{
  "plugin": ["opencode-antigravity-auth@1.0.7"]
}
```

2) **Authenticate**

- Run `opencode auth login`.
- Choose Google → **OAuth with Google (Antigravity)**.
- Sign in via the browser and return to Opencode. If the browser doesn’t open, use the printed link.

3) **Declare the models you want**

Add Antigravity models under the `provider.google.models` section of your config:
```json
{
  "plugin": ["opencode-antigravity-multi-auth"],
  "provider": {
    "google": {
      "models": {
        "gemini-3-pro-high": {
          "name": "Gemini 3 Pro High (Antigravity)",
          "limit": {
            "context": 1048576,
            "output": 65535
          }
        },
        "gemini-3-pro-low": {
          "name": "Gemini 3 Pro Low (Antigravity)",
          "limit": {
            "context": 1048576,
            "output": 65535
          }
        },
        "claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5 (Antigravity)",
          "limit": {
            "context": 200000,
            "output": 64000
          }
        },
        "claude-sonnet-4-5-thinking": {
          "name": "Claude Sonnet 4.5 Thinking (Antigravity)",
          "limit": {
            "context": 200000,
            "output": 64000
          }
        },
        "claude-opus-4-5-thinking": {
          "name": "Claude Opus 4.5 Thinking (Antigravity)",
          "limit": {
            "context": 200000,
            "output": 64000
          }
        },
        "gpt-oss-120b-medium": {
          "name": "GPT-OSS 120B Medium (Antigravity)",
          "limit": {
            "context": 131072,
            "output": 32768
          }
        }
      }
    }
  }
}
```

4) **Use a model**

```bash
opencode run "Hello world" --model=google/gemini-3-pro-high
```

## Multi-Account Load Balancing

The plugin supports **automatic rotation across multiple Google accounts** to work around rate limits.

### How it works

- When you authenticate, you can add multiple Google accounts in one session
- **Sticky account selection**: The plugin uses the same account for all requests until it hits an error
- When an account hits a rate limit (429) or server error (500), it's marked as temporarily unavailable
- The plugin automatically switches to the next available account
- Rate limit state persists across restarts in `~/.config/opencode/antigravity-accounts.json`
- If all accounts are rate-limited, you'll get a clear error with wait time

### Setting up multiple accounts

**⚠️ Note:** Multi-account setup requires using the **CLI** (not TUI). Run this in your terminal:

```bash
opencode auth login
# Choose Google → OAuth with Google (Antigravity)

🔐 Antigravity Multi-Account Setup
You can authenticate multiple Google accounts for automatic load balancing.

# Browser opens for first account
✓ Account 1 authenticated (user1@gmail.com)

Add another account? (y/n): y

# Browser opens for second account
Authenticating account 2...
✓ Account 2 authenticated (user2@gmail.com)

Add another account? (y/n): y

# Browser opens for third account
Authenticating account 3...
✓ Account 3 authenticated (user3@gmail.com)

Add another account? (y/n): n

✨ Configured 3 account(s) for load balancing!
```

**The plugin will log when using multiple accounts:**
```
[Antigravity] Loaded 3 accounts for rotation
[Antigravity] Account 1/3 rate-limited (retry after 60s), switching to next account...
```

### Managing accounts

To remove all accounts and start fresh:
```bash
# This will clear all stored accounts
opencode auth logout google
```

Then re-authenticate with `opencode auth login` to set up accounts again.

You can also manually inspect your accounts in `~/.config/opencode/antigravity-accounts.json` (or your platform's equivalent config directory). This file stores:
- Account emails and refresh tokens
- Rate limit status (which accounts are rate-limited and when they'll be available)
- Last switch reason (why each account was selected)
- Active account index

The `auth.json` now only stores the currently active account's credentials (no longer a concatenated multi-account string).

### Best practices

- **2-3 accounts** is usually sufficient for most use cases
- Use different Google accounts (personal, work, etc.)
- The plugin automatically handles token refresh for all accounts
- No configuration needed - just authenticate and it works!

## Logging & Debugging

### Operational Logs
The plugin automatically logs important events (account switches, rate limits, errors) to the standard Opencode logs.
- **Location:** `~/.local/share/opencode/log/` (or platform equivalent)
- **Service Name:** `antigravity-auth`

### Debug Tracing
For detailed request/response tracing (headers, payloads):

```bash
export OPENCODE_ANTIGRAVITY_DEBUG=1
```

These verbose debug logs are written to the **current working directory** (e.g., `antigravity-debug-<timestamp>.log`).

## Development

```bash
npm install
```

## Safety, usage, and risk notices

### ⚠️ Warning (assumption of risk)

By using this plugin, you acknowledge and accept the following:

- **Terms of Service risk:** This approach may violate the Terms of Service of AI model providers (Anthropic, OpenAI, etc.). You are solely responsible for ensuring compliance with all applicable terms and policies.
- **Account risk:** Providers may detect this usage pattern and take punitive action, including suspension, permanent ban, or loss of access to paid subscriptions.
- **No guarantees:** Providers may change APIs, authentication, or policies at any time, which can break this method without notice.
- **Assumption of risk:** You assume all legal, financial, and technical risks. The authors and contributors of this project bear no responsibility for any consequences arising from your use.

Use at your own risk. Proceed only if you understand and accept these risks.

## Legal

- Not affiliated with Google. This is an independent open-source project and is not endorsed by, sponsored by, or affiliated with Google LLC.
- "Antigravity", "Gemini", "Google Cloud", and "Google" are trademarks of Google LLC.
- Software is provided "as is", without warranty. You are responsible for complying with Google's Terms of Service and Acceptable Use Policy.

## Credits

- Inspired by and different from [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) by [jenslys](https://github.com/jenslys). Thanks for the groundwork! 🚀
- Thanks to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) for the inspiration.

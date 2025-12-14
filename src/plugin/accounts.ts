import type { OAuthAuthDetails, RefreshParts, MultiAccountRefreshParts } from "./types";
import {
  parseMultiAccountRefresh,
  formatMultiAccountRefresh,
  parseRefreshParts,
  formatRefreshParts,
} from "./auth";

export interface ManagedAccount {
  index: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  isRateLimited: boolean;
  rateLimitResetTime: number;
  lastUsed: number;
}

/**
 * Manages multiple OAuth accounts with automatic rotation and rate limit handling.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private currentIndex = 0;

  constructor(auth: OAuthAuthDetails) {
    const multiAccount = parseMultiAccountRefresh(auth.refresh);

    // If we parsed multiple accounts, use them
    if (multiAccount.accounts.length > 0) {
      this.accounts = multiAccount.accounts.map((parts, index) => ({
        index,
        parts,
        access: index === 0 ? auth.access : undefined,
        expires: index === 0 ? auth.expires : undefined,
        isRateLimited: false,
        rateLimitResetTime: 0,
        lastUsed: 0,
      }));
    } else {
      // Fallback: treat as single account
      this.accounts.push({
        index: 0,
        parts: parseRefreshParts(auth.refresh),
        access: auth.access,
        expires: auth.expires,
        isRateLimited: false,
        rateLimitResetTime: 0,
        lastUsed: 0,
      });
    }
  }

  /**
   * Returns the total number of accounts.
   */
  getAccountCount(): number {
    return this.accounts.length;
  }

  /**
   * Gets the next available account (not rate-limited).
   * Returns null if all accounts are rate-limited.
   */
  getNext(): ManagedAccount | null {
    // Clear rate limits for accounts whose timeout has expired
    const available = this.accounts.filter(a => {
      if (!a.isRateLimited) return true;
      if (Date.now() > a.rateLimitResetTime) {
        a.isRateLimited = false;
        return true;
      }
      return false;
    });

    if (available.length === 0) {
      return null; // All accounts are rate-limited
    }

    // Round-robin selection
    const account = available[this.currentIndex % available.length];
    if (!account) {
      return null;
    }
    
    this.currentIndex++;
    account.lastUsed = Date.now();
    return account;
  }

  /**
   * Marks an account as rate-limited for the specified duration.
   */
  markRateLimited(account: ManagedAccount, retryAfterMs: number): void {
    account.isRateLimited = true;
    account.rateLimitResetTime = Date.now() + retryAfterMs;
  }

  /**
   * Updates account tokens after a successful refresh.
   */
  updateAccount(account: ManagedAccount, access: string, expires: number, parts?: RefreshParts): void {
    account.access = access;
    account.expires = expires;
    if (parts) {
      account.parts = parts;
    }
  }

  /**
   * Serializes all accounts back to OAuthAuthDetails format.
   * The first account's access/expires are used as the primary tokens.
   */
  toAuthDetails(): OAuthAuthDetails {
    const multiAccount: MultiAccountRefreshParts = {
      accounts: this.accounts.map(a => a.parts),
    };

    return {
      type: "oauth",
      refresh: formatMultiAccountRefresh(multiAccount),
      access: this.accounts[0]?.access,
      expires: this.accounts[0]?.expires,
    };
  }

  /**
   * Adds a new account to the pool.
   */
  addAccount(parts: RefreshParts, access?: string, expires?: number): void {
    this.accounts.push({
      index: this.accounts.length,
      parts,
      access,
      expires,
      isRateLimited: false,
      rateLimitResetTime: 0,
      lastUsed: 0,
    });
  }

  /**
   * Removes an account by index.
   * Returns true if successful, false if index is invalid.
   */
  removeAccount(index: number): boolean {
    if (index < 0 || index >= this.accounts.length) {
      return false;
    }
    this.accounts.splice(index, 1);
    // Re-index remaining accounts
    this.accounts.forEach((acc, idx) => (acc.index = idx));
    return true;
  }

  /**
   * Returns a copy of all accounts for display/management.
   */
  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  /**
   * Converts an account back to OAuthAuthDetails for individual operations.
   */
  accountToAuth(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access,
      expires: account.expires,
    };
  }

  /**
   * Gets the minimum wait time until any rate-limited account becomes available.
   * Returns 0 if at least one account is available.
   */
  getMinWaitTime(): number {
    const available = this.accounts.filter(a => !a.isRateLimited || Date.now() > a.rateLimitResetTime);
    if (available.length > 0) {
      return 0;
    }

    const waitTimes = this.accounts
      .filter(a => a.isRateLimited)
      .map(a => Math.max(0, a.rateLimitResetTime - Date.now()));

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }
}

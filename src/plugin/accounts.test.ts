import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountManager } from "./accounts";
import { formatMultiAccountRefresh, parseMultiAccountRefresh } from "./auth";
import type { OAuthAuthDetails } from "./types";

describe("Multi-Account Logic", () => {
  describe("Auth Parsing", () => {
    it("parses single account correctly", () => {
      const refresh = "refresh1|proj1|managed1";
      const result = parseMultiAccountRefresh(refresh);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0]).toEqual({
        refreshToken: "refresh1",
        projectId: "proj1",
        managedProjectId: "managed1",
      });
    });

    it("parses multiple accounts correctly", () => {
      const refresh = "r1|p1||r2|p2||r3|p3|m3";
      const result = parseMultiAccountRefresh(refresh);
      expect(result.accounts).toHaveLength(3);
      expect(result.accounts[0].refreshToken).toBe("r1");
      expect(result.accounts[1].refreshToken).toBe("r2");
      expect(result.accounts[2].managedProjectId).toBe("m3");
    });

    it("formats multiple accounts correctly", () => {
      const parts = {
        accounts: [
          { refreshToken: "r1", projectId: "p1" },
          { refreshToken: "r2", projectId: "p2" },
        ],
      };
      const result = formatMultiAccountRefresh(parts);
      expect(result).toBe("r1|p1||r2|p2");
    });
  });

  describe("AccountManager", () => {
    const mockAuth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "r1|p1||r2|p2",
      access: "access1",
      expires: 1000,
    };

    let manager: AccountManager;

    beforeEach(() => {
      manager = new AccountManager(mockAuth);
    });

    it("initializes with multiple accounts", () => {
      expect(manager.getAccountCount()).toBe(2);
      const accounts = manager.getAccounts();
      expect(accounts[0].access).toBe("access1"); // First one gets the access token
      expect(accounts[1].access).toBeUndefined(); // Second one needs refresh
    });

    it("rotates accounts round-robin", () => {
      const acc1 = manager.getNext();
      expect(acc1?.index).toBe(0);

      const acc2 = manager.getNext();
      expect(acc2?.index).toBe(1);

      const acc3 = manager.getNext();
      expect(acc3?.index).toBe(0); // Loops back
    });

    it("skips rate-limited accounts", () => {
      const acc1 = manager.getNext()!;
      manager.markRateLimited(acc1, 60000); // Limit account 0 for 60s

      const next = manager.getNext();
      expect(next?.index).toBe(1); // Should be account 1

      const nextAgain = manager.getNext();
      expect(nextAgain?.index).toBe(1); // Should still be account 1 (0 is limited)
    });

    it("returns null when all accounts are limited", () => {
      const acc1 = manager.getNext()!;
      manager.markRateLimited(acc1, 60000);

      const acc2 = manager.getNext()!;
      manager.markRateLimited(acc2, 60000);

      const next = manager.getNext();
      expect(next).toBeNull();
    });

    it("re-enables account after timeout expires", () => {
      const acc1 = manager.getNext()!;
      // Limit for 1ms
      manager.markRateLimited(acc1, 1);

      // Wait for 10ms
      const start = Date.now();
      while (Date.now() - start < 10) {}

      // Should be available again
      // We need to force a check, getting next should work if logic is time-based
      // Note: In real run we'd use fake timers, but simple wait is fine for this logic check
      const next = manager.getNext();
      // Logic: filter checks Date.now() > resetTime.
      // Since we waited, it should pass.
      // However, rotation might pick index 1 first. Let's limit index 1 too to be sure.
      
      const acc2 = manager.getAccounts()[1];
      manager.markRateLimited(acc2, 60000); // Limit account 1 long time

      const available = manager.getNext();
      expect(available?.index).toBe(0); // Account 0 should be back
    });

    it("updates account tokens correctly", () => {
      const acc = manager.getAccounts()[1];
      manager.updateAccount(acc, "new_access", 2000);
      
      expect(acc.access).toBe("new_access");
      expect(acc.expires).toBe(2000);
    });

    it("adds and removes accounts", () => {
      manager.addAccount({ refreshToken: "r3", projectId: "p3" });
      expect(manager.getAccountCount()).toBe(3);

      manager.removeAccount(0);
      expect(manager.getAccountCount()).toBe(2);
      expect(manager.getAccounts()[0].parts.refreshToken).toBe("r2"); // r2 shifted to index 0
    });
  });
});

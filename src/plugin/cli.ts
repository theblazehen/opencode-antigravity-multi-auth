import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { OAuthAuthDetails } from "./types";
import { AccountManager } from "./accounts";

/**
 * Prompts the user for a project ID via stdin/stdout.
 */
export async function promptProjectId(): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Project ID (leave blank to use your default project): ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Prompts user whether they want to add another account.
 * Returns true if they want to add another, false if done.
 */
export async function promptAddAnotherAccount(currentCount: number): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    console.log(`\n✓ Account ${currentCount} added successfully!`);
    const answer = await rl.question("Add another account? (y/n): ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

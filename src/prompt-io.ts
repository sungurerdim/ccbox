/**
 * Lightweight prompt utilities using node:readline.
 *
 * Replaces @inquirer/prompts with minimal readline-based implementations.
 */

import { createInterface } from "node:readline";

function createRl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

/**
 * Prompt for text input.
 */
export async function input(opts: { message: string; default?: string }): Promise<string> {
  const rl = createRl();
  const suffix = opts.default ? ` (${opts.default})` : "";
  try {
    const answer = await question(rl, `${opts.message}${suffix}: `);
    return answer.trim() || opts.default || "";
  } finally {
    rl.close();
  }
}

/**
 * Prompt for yes/no confirmation.
 */
export async function confirm(opts: { message: string; default?: boolean }): Promise<boolean> {
  const rl = createRl();
  const hint = opts.default === false ? "y/N" : "Y/n";
  try {
    const answer = await question(rl, `${opts.message} (${hint}): `);
    const trimmed = answer.trim().toLowerCase();
    if (!trimmed) {return opts.default ?? true;}
    return trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
  }
}

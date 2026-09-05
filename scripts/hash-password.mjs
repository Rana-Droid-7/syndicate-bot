#!/usr/bin/env node
/**
 * Generates a PBKDF2 hash for the dashboard password and prints the
 * DASHBOARD_PASSWORD_HASH line to put in .env.
 *
 *   node scripts/hash-password.mjs [password]
 *
 * Without an argument it prompts (password never lands in shell
 * history). Run it once, paste the printed line into .env, done.
 */
import { pbkdf2, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ITERATIONS = 120_000;
const KEY_LENGTH = 64;

async function main() {
  let password = process.argv[2];
  if (!password) {
    const rl = createInterface({ input: stdin, output: stdout });
    stdout.write("Dashboard password: ");
    password = await rl.question("");
    rl.close();
  }
  if (!password || password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const salt = randomBytes(16);
  const hash = await new Promise((resolve, reject) =>
    pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, "sha512", (err, key) => (err ? reject(err) : resolve(key))),
  );

  console.log(`DASHBOARD_PASSWORD_HASH=pbkdf2$${ITERATIONS}$${salt.toString("hex")}$${hash.toString("hex")}`);
}

main();

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = await mkdtemp(fileURLToPath(new URL("../node_modules/account-email-test-", import.meta.url)));
after(() => rm(dir, { recursive: true, force: true }));

const outfile = path.join(dir, "account-email.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/account-email.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
  plugins: [{
    name: "mock-notifications",
    setup(build) {
      build.onResolve({ filter: /^\.\/(signup-verification|notification-outbox)$/ }, ({ path }) => ({ path, namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
        contents: `export async function queueSignupVerification(_conn, userId) {
          const state = globalThis.__accountEmailTest;
          state.newCode = { userId, recipient: state.userEmail };
        }
        export async function requeuePendingNotificationsForEmailChange(_conn, oldEmail, newEmail) {
          globalThis.__accountEmailTest.requeued = { oldEmail, newEmail };
        }`,
        loader: "js",
      }));
    },
  }],
});
const { updateAccountEmail } = await import(pathToFileURL(outfile).href);

function account(initialEmail) {
  const state = {
    userEmail: initialEmail, profileEmail: initialEmail, verified: true,
    resetCodeActive: true, oldMailPending: true, oldCodeActive: true,
    sessionActive: true, newCode: null, requeued: null, statements: [],
  };
  globalThis.__accountEmailTest = state;
  const conn = {
    async execute(sql, args = []) {
      state.statements.push(sql);
      if (sql.startsWith("UPDATE users SET email=")) {
        state.userEmail = args[0];
        if (args[1]) state.verified = false;
      } else if (sql.startsWith("UPDATE profiles SET email=")) {
        state.profileEmail = args[0];
      } else if (sql.startsWith("UPDATE password_reset_tokens")) {
        state.resetCodeActive = false;
      } else if (sql.startsWith("DELETE FROM signup_email_verifications")) {
        state.oldCodeActive = false;
      } else if (sql.startsWith("UPDATE notification_outbox")) {
        assert.deepEqual(args, [
          `signup-verification-${userId}-%`,
          `password-reset-${userId}-%`,
        ]);
        state.oldMailPending = false;
      } else if (sql.startsWith("UPDATE auth_sessions")) {
        state.sessionActive = false;
      } else {
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      return [{ affectedRows: 1 }];
    },
  };
  return { state, conn };
}

const userId = "11111111-1111-4111-8111-111111111111";

test("changing an email persists both addresses before enqueuing an OTP to the new address", async () => {
  const { state, conn } = account("old@example.com");
  assert.equal(await updateAccountEmail(conn, userId, "old@example.com", "new@example.com"), true);
  assert.equal(state.userEmail, "new@example.com");
  assert.equal(state.profileEmail, "new@example.com");
  assert.deepEqual(state.newCode, { userId, recipient: "new@example.com" });
  assert.equal(state.verified, false);
  assert.equal(state.oldCodeActive, false);
  assert.equal(state.resetCodeActive, false);
  assert.equal(state.oldMailPending, false);
  assert.deepEqual(state.requeued, { oldEmail: "old@example.com", newEmail: "new@example.com" });
  assert.equal(state.sessionActive, false);
});

test("unchanged email synchronizes the profile without invalidating verification or sessions", async () => {
  const { state, conn } = account("user@example.com");
  assert.equal(await updateAccountEmail(conn, userId, "user@example.com", "user@example.com"), false);
  assert.equal(state.userEmail, "user@example.com");
  assert.equal(state.profileEmail, "user@example.com");
  assert.equal(state.verified, true);
  assert.equal(state.sessionActive, true);
  assert.equal(state.newCode, null);
  assert.equal(state.statements.length, 2);
});
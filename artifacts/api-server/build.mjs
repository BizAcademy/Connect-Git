import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { rm } from "node:fs/promises";

const require = createRequire(import.meta.url);
globalThis.require = require;

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const pinoDir = path.dirname(require.resolve("pino"));
const pinoRequire = createRequire(require.resolve("pino"));
const loggingEntries = {
  "thread-stream-worker": pinoRequire.resolve("thread-stream/lib/worker.js"),
  "pino-worker": path.join(pinoDir, "lib/worker.js"),
  "pino-file": path.join(pinoDir, "file.js"),
  "pino-pretty": require.resolve("pino-pretty"),
};

export async function buildAll({ distDir = path.resolve(artifactDir, "dist") } = {}) {
  await rm(distDir, { recursive: true, force: true });

  const buildTime = new Date().toISOString();

  await esbuild({
    entryPoints: [
      path.resolve(artifactDir, "src/index.ts"),
      path.resolve(artifactDir, "src/scripts/migrate-mysql.ts"),
      path.resolve(artifactDir, "src/scripts/integration-money-earnings.ts"),
      path.resolve(artifactDir, "src/scripts/sabito-worker.ts"),
      path.resolve(artifactDir, "src/scripts/sabito-supervisor.ts"),
      path.resolve(artifactDir, "src/scripts/check-sabito-connection.ts"),
      ...Object.entries(loggingEntries).map(([out, input]) => ({ in: input, out })),
    ],
    outbase: path.resolve(artifactDir, "src"),
    platform: "node",
    bundle: true,
    format: "esm",
    loader: { ".png": "dataurl" },
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    define: {
      "process.env.BUILD_TIME": JSON.stringify(buildTime),
    },
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    // Bundle the logging workers explicitly. esbuild-plugin-pino 2.3.3 embeds
    // its absolute build directory, which breaks after copying dist to Plesk.
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';
import { existsSync as __bannerExists } from 'node:fs';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);

// Both root entrypoints and scripts/* must resolve workers from the deployed
// bundle, not process.cwd() or the temporary directory used for the build.
const __pinoRoot = [new URL('./', import.meta.url), new URL('../', import.meta.url)]
  .find(root => __bannerExists(new URL('thread-stream-worker.mjs', root)));
if (!__pinoRoot) throw new Error('Bundled logging worker assets are missing');
globalThis.__bundlerPathsOverrides = {
  ...(globalThis.__bundlerPathsOverrides || {}),
  'thread-stream-worker': __bannerUrl.fileURLToPath(new URL('thread-stream-worker.mjs', __pinoRoot)),
  'pino-worker': __bannerUrl.fileURLToPath(new URL('pino-worker.mjs', __pinoRoot)),
  'pino/file': __bannerUrl.fileURLToPath(new URL('pino-file.mjs', __pinoRoot)),
  'pino-pretty': __bannerUrl.fileURLToPath(new URL('pino-pretty.mjs', __pinoRoot)),
};
    `,
    },
  });

  // The Plesk deployment package is intentionally self-contained. Bundle the
  // one-time Supabase importer separately so Plesk's "Run script" action can
  // execute it with the Node application's MYSQL_* environment variables.
  await esbuild({
    entryPoints: [
      path.resolve(artifactDir, "scripts/import-supabase-users.mjs"),
      path.resolve(artifactDir, "scripts/import-supabase-history.mjs"),
    ],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: path.resolve(distDir, "scripts"),
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
globalThis.require = __bannerCrReq(import.meta.url);`,
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

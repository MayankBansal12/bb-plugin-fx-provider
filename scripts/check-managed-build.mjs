#!/usr/bin/env node
/**
 * Reproduce a managed BB install and prove the plugin still builds and loads.
 *
 * BB installs a Git plugin by cloning the repository and running
 * `npm install --omit=dev` before it builds. Every module the built artifacts
 * import therefore has to be a *production* dependency — `devDependencies`
 * simply are not on disk at that point. That is easy to get wrong and
 * invisible locally, because a developer checkout has both sets installed:
 * `npm run build` passes while the managed install fails to resolve
 * `@get-bb/plugin-sdk/provider-bridge/acp` and the provider never loads.
 *
 * So this check builds in a throwaway copy of the working tree that has only
 * production dependencies, exactly as BB would:
 *
 *   1. copy the tracked (and not-ignored) working tree to a temp directory
 *   2. `npm install --omit=dev` there
 *   3. resolve each specifier the artifacts import at build time
 *   4. `bb plugin build`
 *   5. import the built `dist/host.js` and confirm it exports the bridge
 *
 * Run it with `npm run check:managed` (or as part of `npm run check`).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The specifiers the built artifacts pull in. `bb plugin build` bundles them,
 * so they must resolve from a production-only install even though nothing
 * imports them at runtime afterwards.
 */
const RUNTIME_SPECIFIERS = [
  "@get-bb/plugin-sdk",
  "@get-bb/plugin-sdk/provider-bridge/acp",
  "zod",
];

/** The export name BB's host loads a provider bridge under. */
const BRIDGE_EXPORT = "experimental_providerBridge";

const steps = [];

function step(name) {
  steps.push(name);
  console.log(`\n[${steps.length}] ${name}`);
}

/** Abort the check. Thrown, not exited, so the temp directory is cleaned up. */
function fail(message, detail) {
  const error = new Error(message);
  error.detail = detail;
  error.expected = true;
  throw error;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) {
    return { ok: false, output: String(result.error.message) };
  }
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * The files a clone would have: tracked files plus anything new that is not
 * ignored, so an uncommitted fix is checked before it is pushed rather than
 * after. `.gitignore` keeps `node_modules/` and `dist/` out by construction.
 */
function pluginFiles() {
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return listed.split("\0").filter(Boolean);
}

/** The bb that would install this plugin: the pinned one when present. */
function bbCommand() {
  const pinned = join(repoRoot, "node_modules", ".bin", "bb");
  return existsSync(pinned) ? pinned : "bb";
}

const workdir = mkdtempSync(join(tmpdir(), "bb-plugin-fx-managed-"));
let succeeded = false;

try {
  step(`Copy the working tree to ${workdir}`);
  const files = pluginFiles();
  if (!files.includes("package.json")) {
    fail("no package.json in the tracked working tree");
  }
  await Promise.all(
    files.map(async (file) => {
      const target = join(workdir, file);
      mkdirSync(dirname(target), { recursive: true });
      await copyFile(join(repoRoot, file), target);
    }),
  );
  console.log(`    ${files.length} files`);

  step("npm install --omit=dev (what BB runs for a managed Git install)");
  const install = run(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: workdir },
  );
  if (!install.ok) {
    fail(
      "`npm install --omit=dev` did not succeed (a registry is required)",
      install.output,
    );
  }

  step("Resolve every specifier the build needs");
  for (const specifier of RUNTIME_SPECIFIERS) {
    const probe = run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import.meta.resolve(${JSON.stringify(specifier)})`,
      ],
      { cwd: workdir },
    );
    if (!probe.ok) {
      fail(
        `\`${specifier}\` does not resolve from a production-only install — ` +
          "it is missing from `dependencies` in package.json (or from " +
          "package-lock.json)",
        probe.output,
      );
    }
    console.log(`    ok  ${specifier}`);
  }

  step("bb plugin build");
  const build = run(bbCommand(), ["plugin", "build"], { cwd: workdir });
  if (!build.ok) {
    fail("`bb plugin build` failed on a production-only install", build.output);
  }
  for (const artifact of ["dist/server.js", "dist/host.js", "dist/app.js"]) {
    if (!existsSync(join(workdir, artifact))) {
      fail(`\`bb plugin build\` produced no ${artifact}`, build.output);
    }
    console.log(`    ok  ${artifact}`);
  }

  step("Import the built host artifact");
  const hostUrl = pathToFileURL(join(workdir, "dist", "host.js")).href;
  const load = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(hostUrl)});
       if (typeof m[${JSON.stringify(BRIDGE_EXPORT)}] === "undefined") {
         throw new Error("dist/host.js exports " + JSON.stringify(Object.keys(m)));
       }`,
    ],
    { cwd: workdir },
  );
  if (!load.ok) {
    fail(
      `the built host does not load and export \`${BRIDGE_EXPORT}\` under a ` +
        "production-only install",
      load.output,
    );
  }
  console.log(`    ok  exports ${BRIDGE_EXPORT}`);

  succeeded = true;
  console.log(
    "\n✔ managed-install check passed: the plugin builds and loads with " +
      "production dependencies only.",
  );
} catch (error) {
  console.error(`\n✘ managed-install check failed: ${error.message}`);
  if (error.detail) console.error(`\n${String(error.detail).trim()}`);
  if (!error.expected) console.error(error);
} finally {
  rmSync(workdir, { recursive: true, force: true });
  process.exitCode = succeeded ? 0 : 1;
}

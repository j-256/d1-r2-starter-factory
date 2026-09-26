#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

worker="${SITES_PROJECT_ROOT}/dist/server/index.js"
hosting="${SITES_PROJECT_ROOT}/dist/.openai/hosting.json"
migration_root="${SITES_PROJECT_ROOT}/dist/.openai/drizzle"
required_migrations=(
  "0000_create-documents.sql"
  "meta/_journal.json"
)

[[ -f "${worker}" ]] || {
  echo "Missing Sites Worker entry: dist/server/index.js" >&2
  exit 66
}
[[ -f "${hosting}" ]] || {
  echo "Missing packaged Sites manifest: dist/.openai/hosting.json" >&2
  exit 66
}
[[ -d "${migration_root}" ]] || {
  echo "Missing packaged Sites migration history: dist/.openai/drizzle" >&2
  exit 66
}
for migration in "${required_migrations[@]}"; do
  [[ -f "${migration_root}/${migration}" ]] || {
    echo "Missing packaged Sites migration file: dist/.openai/drizzle/${migration}" >&2
    exit 66
  }
done

node --input-type=module - "${worker}" "${hosting}" <<'NODE'
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Miniflare } from "miniflare";

const OBSOLETE_PROJECT_ID = "REPLACE_WITH_YOUR_SITES_PROJECT_ID";
const [workerPath, hostingPath] = process.argv.slice(2);
const hosting = JSON.parse(await readFile(hostingPath, "utf8"));
if (hosting.project_id === OBSOLETE_PROJECT_ID) {
  throw new Error(
    "dist/.openai/hosting.json contains the obsolete project_id placeholder"
  );
}

const VALIDATION_MODULE = "__sites_artifact_validation__.mjs";
const COMPATIBILITY_DATE = "2026-09-21";
const workerRoot = dirname(workerPath);
const modules = {
  [VALIDATION_MODULE]: {
    type: "esm",
    contents: `import worker from "./index.js";
export default {
  fetch() {
    if (!worker || typeof worker.fetch !== "function") {
      throw new Error("dist/server/index.js must have an ESM default export with fetch(request, env, ctx)");
    }
    return new Response(null, { status: 204 });
  }
};`,
  },
};
for (const file of await readdir(workerRoot, { recursive: true })) {
  if (file.endsWith(".js")) {
    modules[file] = { type: "esm", contents: await readFile(resolve(workerRoot, file), "utf8") };
  }
}
const runtime = new Miniflare({
  workers: [{
    config: {
      name: "sites-artifact-validation",
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      manifest: { mainModule: VALIDATION_MODULE, modules },
    },
  }],
});
try {
  const response = await runtime.dispatchFetch("http://localhost/");
  if (response.status !== 204) {
    throw new Error("dist/server/index.js must have an ESM default export with fetch(request, env, ctx)");
  }
} finally {
  await runtime.dispose();
}
NODE

echo "Validated Sites artifact: Worker, manifest, and migration history are present."

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    copyGeneratedPath,
    emitOpenai,
    emitWrangler,
    FACTORY_DEPENDABOT_CONFIG_PATH,
    FACTORY_GUIDANCE_FILES,
    GENERATED_FORBIDDEN_FILES,
    OPENAI_DROP_FILES,
    OPENAI_OVERLAY_FILES,
    OPENAI_PACKAGE_SCRIPT_ALLOWLIST,
    OPENAI_SCRIPT_ALLOWLIST,
    scanForResidue,
    scanOpenaiResidue,
    RESIDUE_PATTERN,
    FORBIDDEN_DEPS,
    INSTALLED_PACKAGE_ARTIFACTS,
    INSTALLED_PACKAGE_COMMANDS,
    INSTALLED_PACKAGE_REMOVE_OPTIONS,
    runInstalledPackageChecks,
    SHARED_PATHS,
} from "./generate-lib.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(SCRIPT_DIRECTORY, "..");
const VALIDATE_ARTIFACT_SCRIPT = join(
    SCRIPT_DIRECTORY,
    "validate-artifact.sh"
);
const ROOT_INSTALL_SCRIPT_APPROVALS = Object.freeze({
    "esbuild@0.28.2": true,
    "fsevents@2.3.3": true,
    "unrs-resolver@1.11.1": true,
    "workerd@1.20260921.1": true,
});
const WRANGLER_INSTALL_SCRIPT_APPROVALS = Object.freeze({
    "esbuild@0.28.2": true,
    "fsevents@2.3.3": true,
    "workerd@1.20260921.1": true,
});
const REQUIRED_SITE_MIGRATIONS = Object.freeze([
    "0000_create-documents.sql",
    "meta/_journal.json",
]);

function tempTree() {
    return mkdtempSync(join(tmpdir(), "gen-guard-"));
}

function writeOpenaiOverlay(root, readme = "# Sites edition\n") {
    const overlay = join(root, "variants", "openai");
    mkdirSync(overlay, { recursive: true });
    writeFileSync(join(overlay, "README.md"), readme);
    return overlay;
}

function writeWranglerFactoryFixture(root) {
    mkdirSync(root, { recursive: true });
    for (const path of SHARED_PATHS) {
        const target = join(root, path);
        if (path.includes(".") || path === "LICENSE") {
            writeFileSync(target, "fixture\n");
        } else {
            mkdirSync(target, { recursive: true });
        }
    }
    const overlay = join(root, "variants", "wrangler");
    mkdirSync(overlay, { recursive: true });
    writeFileSync(join(overlay, "package.json"), "{}\n");
    return overlay;
}

function writeArtifactFixture(root) {
    const workerDirectory = join(root, "dist", "server");
    const openaiDirectory = join(root, "dist", ".openai");
    const migrationRoot = join(openaiDirectory, "drizzle");
    mkdirSync(workerDirectory, { recursive: true });
    mkdirSync(openaiDirectory, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(
        join(workerDirectory, "index.js"),
        "export default { fetch() {} };\n"
    );
    writeFileSync(join(openaiDirectory, "hosting.json"), "{}\n");
    for (const migration of REQUIRED_SITE_MIGRATIONS) {
        const target = join(migrationRoot, migration);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, "fixture\n");
    }
}

function runArtifactValidator(root) {
    return execFileSync("bash", [VALIDATE_ARTIFACT_SCRIPT], {
        encoding: "utf8",
        env: {
            ...process.env,
            SITES_ENV_READY: "1",
            SITES_PROJECT_ROOT: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

test("manifests approve reviewed dependency install scripts", () => {
    const rootPackage = JSON.parse(
        readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")
    );
    const wranglerPackage = JSON.parse(
        readFileSync(
            join(REPOSITORY_ROOT, "variants", "wrangler", "package.json"),
            "utf8"
        )
    );

    assert.deepEqual(rootPackage.allowScripts, ROOT_INSTALL_SCRIPT_APPROVALS);
    assert.deepEqual(
        wranglerPackage.allowScripts,
        WRANGLER_INSTALL_SCRIPT_APPROVALS
    );
});

test("installed package checks use the emitted toolchain and clean artifacts", () => {
    const root = tempTree();
    const calls = [];
    const removals = [];
    try {
        runInstalledPackageChecks(
            root,
            "fixture",
            (command, args, options) => {
                calls.push({
                    args: [...args],
                    command,
                    cwd: options.cwd,
                    stdio: options.stdio,
                });
                if (args[0] === "ci") {
                    for (const artifact of INSTALLED_PACKAGE_ARTIFACTS) {
                        mkdirSync(join(root, artifact), { recursive: true });
                    }
                }
            },
            (path, options) => {
                removals.push({ options, path });
                rmSync(path, options);
            }
        );

        assert.deepEqual(
            calls.map(({ args }) => args),
            INSTALLED_PACKAGE_COMMANDS
        );
        assert.equal(calls.every(({ command }) => command === "npm"), true);
        assert.equal(calls.every(({ cwd }) => cwd === root), true);
        assert.equal(calls.every(({ stdio }) => stdio === "inherit"), true);
        assert.deepEqual(
            removals.map(({ options }) => options),
            INSTALLED_PACKAGE_ARTIFACTS.map(
                () => INSTALLED_PACKAGE_REMOVE_OPTIONS
            )
        );
        assert.equal(
            removals.every(({ path }, index) =>
                path.endsWith(INSTALLED_PACKAGE_ARTIFACTS[index])
            ),
            true
        );
        for (const artifact of INSTALLED_PACKAGE_ARTIFACTS) {
            assert.equal(existsSync(join(root, artifact)), false);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("installed package checks clean artifacts after a failed command", () => {
    const root = tempTree();
    try {
        assert.throws(
            () =>
                runInstalledPackageChecks(root, "fixture", (_command, args) => {
                    for (const artifact of INSTALLED_PACKAGE_ARTIFACTS) {
                        mkdirSync(join(root, artifact), { recursive: true });
                    }
                    if (args[0] === "run") throw new Error("typecheck failed");
                }),
            /typecheck failed/
        );
        for (const artifact of INSTALLED_PACKAGE_ARTIFACTS) {
            assert.equal(existsSync(join(root, artifact)), false);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanForResidue passes a clean tree", () => {
    const root = tempTree();
    try {
        writeFileSync(join(root, "ok.ts"), "export const x = 1;\n");
        mkdirSync(join(root, "sub"));
        writeFileSync(join(root, "sub", "note.md"), "A Hono worker.\n");
        assert.deepEqual(scanForResidue(root), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanForResidue rejects factory Dependabot configuration", () => {
    const root = tempTree();
    try {
        const configPath = join(
            root,
            ...FACTORY_DEPENDABOT_CONFIG_PATH.split("/")
        );
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, "version: 2\n");
        const violations = scanForResidue(root);
        assert.equal(
            violations.some((violation) =>
                violation.includes(FACTORY_DEPENDABOT_CONFIG_PATH)
            ),
            true
        );
        assert.equal(
            GENERATED_FORBIDDEN_FILES.includes(
                FACTORY_DEPENDABOT_CONFIG_PATH
            ),
            true
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("copyGeneratedPath excludes dependencies, Git, and macOS metadata", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const target = join(root, "target");
        mkdirSync(join(source, "nested", ".git"), { recursive: true });
        mkdirSync(join(source, "nested", "node_modules"));
        writeFileSync(join(source, "nested", ".DS_Store"), "metadata\n");
        writeFileSync(join(source, "nested", ".git", "config"), "private\n");
        writeFileSync(
            join(source, "nested", "node_modules", "package.json"),
            "{}\n"
        );
        writeFileSync(join(source, "nested", "keep.txt"), "public\n");

        copyGeneratedPath(source, target);

        assert.equal(existsSync(join(target, "nested", ".DS_Store")), false);
        assert.equal(existsSync(join(target, "nested", ".git")), false);
        assert.equal(existsSync(join(target, "nested", "node_modules")), false);
        assert.equal(existsSync(join(target, "nested", "keep.txt")), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("emitOpenai removes the factory project_id from the reusable manifest", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const output = join(root, "output");
        mkdirSync(join(source, ".openai"), { recursive: true });
        mkdirSync(join(source, "scripts"));
        writeOpenaiOverlay(source);
        writeFileSync(
            join(source, "package.json"),
            JSON.stringify({ scripts: { build: "vinext build" } })
        );
        writeFileSync(
            join(source, ".openai", "hosting.json"),
            `${JSON.stringify({
                d1: "DB",
                project_id: "factory-project",
                r2: "BUCKET",
            })}\n`
        );

        emitOpenai(source, output);

        const emitted = JSON.parse(
            readFileSync(join(output, ".openai", "hosting.json"), "utf8")
        );
        const factory = JSON.parse(
            readFileSync(join(source, ".openai", "hosting.json"), "utf8")
        );
        assert.deepEqual(emitted, { d1: "DB", r2: "BUCKET" });
        assert.equal(factory.project_id, "factory-project");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("emitOpenai replaces the factory README with the edition README", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const output = join(root, "output");
        mkdirSync(join(source, ".openai"), { recursive: true });
        mkdirSync(join(source, "scripts"));
        writeFileSync(join(source, "README.md"), "# Source factory\n");
        writeOpenaiOverlay(source, "# ChatGPT Sites edition\n");
        writeFileSync(join(source, "package.json"), "{}\n");
        writeFileSync(join(source, ".openai", "hosting.json"), "{}\n");

        emitOpenai(source, output);

        assert.equal(
            readFileSync(join(output, "README.md"), "utf8"),
            "# ChatGPT Sites edition\n"
        );
        assert.equal(OPENAI_OVERLAY_FILES.includes("README.md"), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("emitOpenai allowlists runtime scripts and package commands", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const output = join(root, "output");
        mkdirSync(join(source, ".openai"), { recursive: true });
        mkdirSync(join(source, "scripts"));
        writeOpenaiOverlay(source);
        writeFileSync(
            join(source, "scripts", "sites-env.sh"),
            "#!/bin/bash\n"
        );
        writeFileSync(
            join(source, "scripts", "check-docs-cover.mjs"),
            "export {};\n"
        );
        writeFileSync(
            join(source, "scripts", "future-factory-tool.mjs"),
            "export {};\n"
        );
        writeFileSync(
            join(source, "package.json"),
            JSON.stringify({
                allowScripts: ROOT_INSTALL_SCRIPT_APPROVALS,
                scripts: {
                    build: "vinext build",
                    "check:docs-cover": "node scripts/check-docs-cover.mjs",
                    test: "npm run test:unit && npm run check:docs-cover",
                    "test:unit": "node --test",
                    "template:future": "node scripts/future-factory-tool.mjs",
                },
            })
        );
        writeFileSync(join(source, ".openai", "hosting.json"), "{}\n");

        emitOpenai(source, output);

        assert.equal(
            existsSync(join(output, "scripts", "sites-env.sh")),
            true
        );
        assert.equal(
            existsSync(join(output, "scripts", "future-factory-tool.mjs")),
            false
        );
        assert.equal(
            existsSync(join(output, "scripts", "check-docs-cover.mjs")),
            true
        );
        const emittedPackage = JSON.parse(
            readFileSync(join(output, "package.json"), "utf8")
        );
        assert.deepEqual(emittedPackage.scripts, {
            build: "vinext build",
            "check:docs-cover": "node scripts/check-docs-cover.mjs",
            test: "npm run test:unit && npm run check:docs-cover",
            "test:unit": "node --test",
        });
        assert.deepEqual(
            emittedPackage.allowScripts,
            ROOT_INSTALL_SCRIPT_APPROVALS
        );
        assert.equal(OPENAI_SCRIPT_ALLOWLIST.includes("sites-env.sh"), true);
        assert.equal(
            OPENAI_SCRIPT_ALLOWLIST.includes("check-docs-cover.mjs"),
            true
        );
        assert.equal(OPENAI_PACKAGE_SCRIPT_ALLOWLIST.includes("build"), true);
        assert.equal(
            OPENAI_PACKAGE_SCRIPT_ALLOWLIST.includes("test:unit"),
            true
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("emitOpenai keeps generated CI and drops factory Dependabot", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const output = join(root, "output");
        mkdirSync(join(source, ".github", "workflows"), { recursive: true });
        mkdirSync(join(source, ".openai"));
        mkdirSync(join(source, "scripts"));
        writeOpenaiOverlay(source);
        writeFileSync(
            join(source, ".github", "workflows", "ci.yml"),
            "name: CI\n"
        );
        writeFileSync(
            join(source, ".github", "dependabot.yml"),
            "version: 2\n"
        );
        writeFileSync(join(source, ".openai", "hosting.json"), "{}\n");
        writeFileSync(join(source, "package.json"), "{}\n");

        emitOpenai(source, output);

        assert.equal(
            existsSync(join(output, ".github", "workflows", "ci.yml")),
            true
        );
        assert.equal(
            existsSync(
                join(
                    output,
                    ...FACTORY_DEPENDABOT_CONFIG_PATH.split("/")
                )
            ),
            false
        );
        assert.equal(
            OPENAI_DROP_FILES.includes(FACTORY_DEPENDABOT_CONFIG_PATH),
            true
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("generated editions omit factory agent guidance", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const openaiOutput = join(root, "openai-output");
        const wranglerOutput = join(root, "wrangler-output");
        const wranglerOverlay = writeWranglerFactoryFixture(source);
        mkdirSync(join(source, ".openai"));
        mkdirSync(join(source, "scripts"));
        writeOpenaiOverlay(source);
        writeFileSync(join(source, "AGENTS.md"), "# Factory guidance\n");
        writeFileSync(join(source, "CLAUDE.md"), "AGENTS.md\n");
        writeFileSync(join(source, ".openai", "hosting.json"), "{}\n");
        writeFileSync(join(source, "package.json"), "{}\n");
        writeFileSync(join(wranglerOverlay, "package-lock.json"), "{}\n");

        emitOpenai(source, openaiOutput);
        emitWrangler(source, wranglerOutput);

        for (const guidanceFile of FACTORY_GUIDANCE_FILES) {
            assert.equal(OPENAI_DROP_FILES.includes(guidanceFile), true);
            assert.equal(existsSync(join(openaiOutput, guidanceFile)), false);
            assert.equal(existsSync(join(wranglerOutput, guidanceFile)), false);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("emitWrangler requires and copies a package lock", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const output = join(root, "output");
        const overlay = writeWranglerFactoryFixture(source);

        assert.throws(
            () => emitWrangler(source, output),
            /Missing Wrangler package file: package-lock\.json/
        );

        writeFileSync(join(overlay, "package-lock.json"), "{}\n");
        mkdirSync(join(overlay, ".github", "workflows"), { recursive: true });
        writeFileSync(
            join(overlay, ".github", "workflows", "ci.yml"),
            "name: CI\n"
        );
        emitWrangler(source, output);
        assert.equal(existsSync(join(output, "package-lock.json")), true);
        assert.equal(
            existsSync(join(output, ".github", "workflows", "ci.yml")),
            true
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("validate-artifact accepts the complete packaged migration history", () => {
    const root = tempTree();
    try {
        writeArtifactFixture(root);
        assert.match(runArtifactValidator(root), /migration history/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("validate-artifact loads Workers runtime imports", () => {
    const root = tempTree();
    try {
        writeArtifactFixture(root);
        writeFileSync(
            join(root, "dist", "server", "index.js"),
            'import { WorkerEntrypoint } from "cloudflare:workers";\nexport default { fetch() { return WorkerEntrypoint; } };\n'
        );
        assert.match(runArtifactValidator(root), /migration history/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("validate-artifact rejects a Worker without fetch", () => {
    const root = tempTree();
    try {
        writeArtifactFixture(root);
        writeFileSync(join(root, "dist", "server", "index.js"), "export default {};\n");
        assert.throws(() => runArtifactValidator(root), /must have an ESM default export with fetch/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("validate-artifact rejects a missing packaged migration", () => {
    const root = tempTree();
    try {
        writeArtifactFixture(root);
        rmSync(
            join(
                root,
                "dist",
                ".openai",
                "drizzle",
                "0000_create-documents.sql"
            )
        );
        assert.throws(
            () => runArtifactValidator(root),
            (error) => {
                assert.match(
                    String(error.stderr),
                    /Missing packaged Sites migration file/
                );
                return true;
            }
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("validate-artifact rejects the obsolete project_id placeholder", () => {
    const root = tempTree();
    try {
        writeArtifactFixture(root);
        writeFileSync(
            join(root, "dist", ".openai", "hosting.json"),
            '{"project_id":"REPLACE_WITH_YOUR_SITES_PROJECT_ID"}\n'
        );
        assert.throws(
            () => runArtifactValidator(root),
            (error) => {
                assert.match(
                    String(error.stderr),
                    /obsolete project_id placeholder/
                );
                return true;
            }
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanForResidue flags a forbidden token in file contents", () => {
    const root = tempTree();
    try {
        writeFileSync(join(root, "leak.ts"), 'const h = "oai-authenticated-user-email";\n');
        const violations = scanForResidue(root);
        assert.equal(violations.length >= 1, true);
        assert.match(violations[0], /leak\.ts/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanForResidue allows the ChatGPT Sites peer name only in README", () => {
    const root = tempTree();
    try {
        writeFileSync(join(root, "README.md"), "Use ChatGPT Sites.\n");
        assert.deepEqual(scanForResidue(root), []);

        writeFileSync(
            join(root, "leak.ts"),
            'export const peer = "ChatGPT Sites";\n'
        );
        const violations = scanForResidue(root);
        assert.equal(violations.length, 1);
        assert.match(violations[0], /leak\.ts/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanForResidue rejects other ChatGPT README content", () => {
    const root = tempTree();
    try {
        writeFileSync(join(root, "README.md"), "Sign in with ChatGPT.\n");
        const violations = scanForResidue(root);
        assert.equal(violations.length, 1);
        assert.match(violations[0], /README\.md/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanForResidue flags a forbidden token in a path", () => {
    const root = tempTree();
    try {
        mkdirSync(join(root, ".openai"));
        writeFileSync(join(root, ".openai", "hosting.json"), "{}\n");
        const violations = scanForResidue(root);
        assert.equal(violations.length >= 1, true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanForResidue flags a forbidden dependency in package.json", () => {
    const root = tempTree();
    try {
        writeFileSync(
            join(root, "package.json"),
            JSON.stringify({ dependencies: { next: "16.0.0", hono: "4.13.1" } })
        );
        const violations = scanForResidue(root);
        assert.equal(violations.some((v) => v.includes("next")), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("RESIDUE_PATTERN and FORBIDDEN_DEPS cover the expected tokens", () => {
    assert.match("vinext", RESIDUE_PATTERN);
    assert.match("chatgpt", RESIDUE_PATTERN);
    assert.match("codex-preview", RESIDUE_PATTERN);
    assert.equal(FORBIDDEN_DEPS.includes("next"), true);
    assert.equal(FORBIDDEN_DEPS.includes("vinext"), true);
});

// A minimal emitted-openai shell that scanOpenaiResidue should pass
function writeCleanOpenaiTree(root) {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "sites-env.sh"), "#!/usr/bin/env bash\n");
    writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { build: "vinext build", typecheck: "tsc" } })
    );
}

test("scanOpenaiResidue passes a clean openai tree", () => {
    const root = tempTree();
    try {
        writeCleanOpenaiTree(root);
        assert.deepEqual(scanOpenaiResidue(root), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanOpenaiResidue flags a leaked factory-only docs/PUBLISH.md", () => {
    const root = tempTree();
    try {
        writeCleanOpenaiTree(root);
        mkdirSync(join(root, "docs"));
        writeFileSync(join(root, "docs", "PUBLISH.md"), "# factory only\n");
        const violations = scanOpenaiResidue(root);
        assert.equal(violations.some((v) => v.includes("docs/PUBLISH.md")), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanOpenaiResidue flags a leaked factory-only Dependabot config", () => {
    const root = tempTree();
    try {
        writeCleanOpenaiTree(root);
        mkdirSync(join(root, ".github"));
        writeFileSync(
            join(root, ...FACTORY_DEPENDABOT_CONFIG_PATH.split("/")),
            "version: 2\n"
        );
        const violations = scanOpenaiResidue(root);
        assert.equal(
            violations.some((violation) =>
                violation.includes(FACTORY_DEPENDABOT_CONFIG_PATH)
            ),
            true
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanOpenaiResidue flags an unexpected package command", () => {
    const root = tempTree();
    try {
        writeCleanOpenaiTree(root);
        writeFileSync(
            join(root, "package.json"),
            JSON.stringify({
                scripts: {
                    build: "vinext build",
                    "template:backups": "node scripts/template-backups.mjs",
                },
            })
        );
        const violations = scanOpenaiResidue(root);
        assert.equal(
            violations.some((violation) =>
                violation.includes("template:backups")
            ),
            true
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanOpenaiResidue flags an unexpected script file", () => {
    const root = tempTree();
    try {
        writeCleanOpenaiTree(root);
        writeFileSync(
            join(root, "scripts", "template-backups.mjs"),
            "export {};\n"
        );
        const violations = scanOpenaiResidue(root);
        assert.equal(
            violations.some((violation) =>
                violation.includes("template-backups.mjs")
            ),
            true
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    createSystemDependencies,
    dependabotSecurityUpdatesEnabled,
    factoryRevisionVariable,
    historyModeChoices,
    isAffirmativeResponse,
    mergeChangedPaths,
    parseHttpStatus,
    parsePublishArguments,
    publishTemplates,
    publicationConfirmationQuestion,
    publishUsage,
    repositoryVariableWriteArguments,
    resolveCommitMessage,
    resolvePublishInvocation,
    syncGeneratedTree,
} from "./publish-template-lib.mjs";

const UPDATE_MESSAGE = "Refresh generated template";
const UPDATE_MESSAGE_WITH_BODY = `${UPDATE_MESSAGE}\n\nExplain the generated boundary`;
const HTTP_NOT_FOUND = 404;
const FACTORY_REPOSITORY = "j-256/d1-r2-starter-factory";
const OPENAI_REPOSITORY = "j-256/d1-r2-starter-openai";
const WRANGLER_REPOSITORY = "j-256/d1-r2-starter-wrangler";

function tempTree() {
    return mkdtempSync(join(tmpdir(), "publish-template-test-"));
}

function runGit(cwd, args) {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function configureTestGit(cwd) {
    runGit(cwd, ["config", "user.name", "Template Test"]);
    runGit(cwd, ["config", "user.email", "template@example.test"]);
}

function createTemplateRemote(root) {
    const remote = join(root, "template.git");
    const seed = join(root, "seed");
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", seed]);
    configureTestGit(seed);
    writeFileSync(join(seed, "README.md"), "# Initial\n");
    writeFileSync(join(seed, "stale.txt"), "remove\n");
    runGit(seed, ["add", "--", "README.md", "stale.txt"]);
    runGit(seed, ["commit", "-m", "Initial commit", "--", "README.md", "stale.txt"]);
    runGit(seed, ["remote", "add", "origin", remote]);
    runGit(seed, ["push", "--quiet", "origin", "main"]);
    return {
        initialCommit: runGit(seed, ["rev-parse", "HEAD"]).trim(),
        remote,
    };
}

function createReplayFactory(root) {
    const factory = join(root, "factory");
    mkdirSync(join(factory, "scripts"), { recursive: true });
    execFileSync("git", ["init", "-b", "main", factory]);
    configureTestGit(factory);
    writeFileSync(
        join(factory, "scripts", "generate.mjs"),
        [
            'import { cpSync, mkdirSync, rmSync } from "node:fs";',
            'rmSync("dist", { force: true, recursive: true });',
            'for (const variant of ["openai", "wrangler"]) {',
            '    const output = `dist/${variant}`;',
            '    mkdirSync(output, { recursive: true });',
            '    cpSync("template.txt", `${output}/template.txt`);',
            '}',
            '',
        ].join("\n")
    );
    writeFileSync(
        join(factory, "package.json"),
        `${JSON.stringify({
            private: true,
            scripts: { generate: "node scripts/generate.mjs" },
        }, null, 2)}\n`
    );
    writeFileSync(join(factory, "template.txt"), "baseline\n");
    runGit(factory, [
        "add",
        "--",
        "package.json",
        "scripts/generate.mjs",
        "template.txt",
    ]);
    runGit(factory, [
        "commit",
        "-m",
        "Establish template baseline",
        "--",
        "package.json",
        "scripts/generate.mjs",
        "template.txt",
    ]);
    const baseline = runGit(factory, ["rev-parse", "HEAD"]).trim();

    writeFileSync(join(factory, "template.txt"), "feature\n");
    runGit(factory, ["add", "--", "template.txt"]);
    runGit(factory, [
        "commit",
        "-m",
        "Add generated feature",
        "-m",
        "Explain the feature boundary",
        "--",
        "template.txt",
    ]);
    writeFileSync(join(factory, "factory-only.txt"), "publisher\n");
    runGit(factory, ["add", "--", "factory-only.txt"]);
    runGit(factory, [
        "commit",
        "-m",
        "Change factory tooling",
        "--",
        "factory-only.txt",
    ]);
    return { baseline, factory };
}

function fakeDependencies(options = {}) {
    const operations = [];
    const defaultChangedPaths = options.changedPaths ?? ["README.md"];
    const defaultExists = options.exists ?? true;
    const changedPathCallCounts = new Map();
    const factoryRevisions = new Map(
        Object.entries(options.factoryRevisionsByVariant ?? {})
    );
    const policyCallCounts = new Map();
    const trashedBackups = new Set();

    return {
        dependencies: {
            async assertFactoryReady() {
                operations.push("assertFactoryReady");
                return options.factoryHead ?? "factory-head";
            },
            async generate() {
                operations.push("generate");
            },
            async assertReplayBaseline({ from }) {
                operations.push(`assertReplayBaseline:${from}`);
                const error = options.replayBaselineErrorByRevision?.[from]
                    ?? options.replayBaselineError;
                if (error) throw error;
            },
            async prepareReplay({ from }) {
                operations.push(`prepareReplay:${from}`);
                return options.replayByRevision?.[from] ?? options.replay ?? {
                    base: { revision: "baseline" },
                    checkpoints: [],
                    tempRoot: `replay-temp:${from}`,
                };
            },
            async repositoryExists(repository) {
                operations.push(`repositoryExists:${repository}`);
                return options.existsByRepository?.[repository] ?? defaultExists;
            },
            async readFactoryRevision(variant) {
                operations.push(`readFactoryRevision:${variant}`);
                return factoryRevisions.get(variant);
            },
            async recordFactoryRevision({ revision, variant }) {
                operations.push(
                    `recordFactoryRevision:${variant}:${revision}`
                );
                const error = options.recordErrorByVariant?.[variant]
                    ?? options.recordError;
                if (error) throw error;
                factoryRevisions.set(variant, revision);
            },
            async prepareCheckout({ config }) {
                operations.push(`prepareCheckout:${config.repository}`);
                return {
                    checkout: config.repository,
                    remoteCommit: options.remoteCommitByRepository?.[
                        config.repository
                    ] ?? `remote-${config.repository}`,
                    tempRoot: `temp:${config.repository}`,
                };
            },
            async syncGeneratedTree(outputDirectory, checkout) {
                operations.push(`sync:${outputDirectory}:${checkout}`);
            },
            async assertTemplatePolicy({ repository, verifyRemote }) {
                operations.push(
                    `assertTemplatePolicy:${repository}:${verifyRemote ? "remote" : "local"}`
                );
                const call = policyCallCounts.get(repository) ?? 0;
                policyCallCounts.set(repository, call + 1);
                const error = options.policyErrorSequenceByRepository?.[
                    repository
                ]?.[call]
                    ?? options.policyErrorByRepository?.[repository]
                    ?? options.policyError;
                if (error) throw error;
            },
            async syncReplayTree({ checkout, snapshot }) {
                operations.push(
                    `syncReplay:${snapshot.revision}:${checkout}`
                );
            },
            async collectChangedPaths(checkout) {
                operations.push(`collectChangedPaths:${checkout}`);
                const call = changedPathCallCounts.get(checkout) ?? 0;
                changedPathCallCounts.set(checkout, call + 1);
                const sequence = options.changedPathSequenceByRepository?.[
                    checkout
                ];
                if (sequence && call < sequence.length) {
                    return sequence[call];
                }
                return options.changedPathsByRepository?.[checkout]
                    ?? defaultChangedPaths;
            },
            async stagePaths(checkout, paths) {
                operations.push(`stage:${checkout}:${paths.join(",")}`);
            },
            async showStagedDiff(checkout) {
                operations.push(`showStagedDiff:${checkout}`);
            },
            async showCreatedCommit(checkout, commit) {
                operations.push(`showCreatedCommit:${checkout}:${commit}`);
            },
            async confirm({ commitCount, history, repository }) {
                operations.push(`confirm:${repository}:${history ?? "create"}`);
                if (commitCount !== undefined) {
                    operations.push(
                        `confirmCommitCount:${repository}:${commitCount}`
                    );
                }
                return options.confirmedByRepository?.[repository]
                    ?? options.confirmed
                    ?? true;
            },
            async requestHistoryMode({ replay, repository }) {
                operations.push(`requestHistoryMode:${repository}`);
                operations.push(
                    `requestHistoryReplay:${repository}:${replay ?? false}`
                );
                return options.historyByRepository?.[repository]
                    ?? options.requestedHistory
                    ?? "append";
            },
            async requestCommitMessage({ repository }) {
                operations.push(`requestCommitMessage:${repository}`);
                return options.messagesByRepository?.[repository]
                    ?? options.requestedMessage
                    ?? UPDATE_MESSAGE;
            },
            async confirmBackupCleanup({ repository }) {
                operations.push(`confirmBackupCleanup:${repository}`);
                return options.cleanupBackupByRepository?.[repository]
                    ?? options.cleanupBackup
                    ?? false;
            },
            async listRetainedBackups(repository) {
                operations.push(`listRetainedBackups:${repository}`);
                return (
                    options.retainedBackupsByRepository?.[repository] ?? []
                ).filter((path) => !trashedBackups.has(path));
            },
            async moveBackupsToTrash(paths) {
                operations.push(`moveBackupsToTrash:${paths.join(",")}`);
                if (options.trashError) throw options.trashError;
                for (const path of paths) trashedBackups.add(path);
            },
            async createMirrorBackup({ repository }) {
                operations.push(`createMirrorBackup:${repository}`);
                return `backup:${repository}`;
            },
            async createCommit({
                changedPaths,
                checkout,
                history,
                message,
            }) {
                operations.push(
                    `commit:${checkout}:${history ?? "create"}:${message}:${changedPaths.join(",")}`
                );
                return `published-${checkout}`;
            },
            async pushUpdate(checkout) {
                operations.push(`pushUpdate:${checkout}`);
            },
            async pushFresh({ checkout }) {
                operations.push(`pushFresh:${checkout}`);
            },
            async createRepository(_checkout, repository) {
                operations.push(`createRepository:${repository}`);
            },
            async ensureTemplate(repository) {
                operations.push(`ensureTemplate:${repository}`);
            },
            async verifyPublished({ repository }) {
                operations.push(`verifyPublished:${repository}`);
                const error = options.verifyErrorByRepository?.[repository]
                    ?? options.verifyError;
                if (error) throw error;
            },
            async cleanup(workspace) {
                operations.push(`cleanup:${workspace.checkout}`);
            },
            async cleanupReplay(replay) {
                operations.push(`cleanupReplay:${replay.tempRoot}`);
            },
            log(message) {
                operations.push(`log:${message}`);
            },
        },
        operations,
    };
}

test("resolvePublishInvocation defaults a bare command to append replay", () => {
    const invocation = resolvePublishInvocation([]);
    assert.deepEqual(invocation, {
        args: ["all", "--history", "append", "--replay"],
        notice: "No publish arguments supplied. Running: npm run template:publish -- all --history append --replay",
    });
    assert.deepEqual(parsePublishArguments(invocation.args), {
        clobber: false,
        help: false,
        history: "append",
        message: undefined,
        replay: true,
        replayFrom: undefined,
        variant: "all",
        yes: false,
    });
    assert.deepEqual(resolvePublishInvocation(["openai"]), {
        args: ["openai"],
        notice: undefined,
    });
});

test("parsePublishArguments requires a target after invocation resolution", () => {
    assert.throws(
        () => parsePublishArguments([]),
        /Pass all for both templates/
    );
    assert.deepEqual(parsePublishArguments(["all"]), {
        clobber: false,
        help: false,
        history: undefined,
        message: undefined,
        replay: false,
        replayFrom: undefined,
        variant: "all",
        yes: false,
    });
    assert.deepEqual(parsePublishArguments(["--help"]), {
        help: true,
        yes: false,
    });
});

test("parsePublishArguments accepts a variant, history, message, and confirmation flag", () => {
    assert.deepEqual(
        parsePublishArguments([
            "openai",
            "--history=fresh",
            "--message",
            UPDATE_MESSAGE,
            "--yes",
        ]),
        {
            clobber: false,
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            replay: false,
            replayFrom: undefined,
            variant: "openai",
            yes: true,
        }
    );
});

test("parsePublishArguments keeps short and long publication options equivalent", () => {
    assert.deepEqual(
        parsePublishArguments([
            "openai",
            "--history=fresh",
            "-m",
            UPDATE_MESSAGE,
            "-y",
        ]),
        parsePublishArguments([
            "openai",
            "--history=fresh",
            "--message",
            UPDATE_MESSAGE,
            "--yes",
        ])
    );
    assert.deepEqual(
        parsePublishArguments(["all", "--history", "append", "-r", "-y"]),
        parsePublishArguments([
            "all",
            "--history",
            "append",
            "--replay",
            "--yes",
        ])
    );
});

test("parsePublishArguments expands clobber to fresh history", () => {
    assert.deepEqual(
        parsePublishArguments(["all", "--clobber", "--yes"]),
        {
            clobber: true,
            help: false,
            history: "fresh",
            message: undefined,
            replay: false,
            replayFrom: undefined,
            variant: "all",
            yes: true,
        }
    );
    assert.throws(
        () => parsePublishArguments([
            "openai",
            "--clobber",
            "--history",
            "append",
        ]),
        /cannot be combined with --history append/
    );
});

test("parsePublishArguments accepts explicit all and both selections", () => {
    assert.equal(parsePublishArguments(["all"]).variant, "all");
    assert.equal(parsePublishArguments(["both"]).variant, "all");
});

test("parsePublishArguments accepts explicit and recorded checkpoint replay", () => {
    assert.deepEqual(
        parsePublishArguments([
            "all",
            "--history",
            "fresh",
            "--replay-from",
            "main~3",
            "--yes",
        ]),
        {
            clobber: false,
            help: false,
            history: "fresh",
            message: undefined,
            replay: false,
            replayFrom: "main~3",
            variant: "all",
            yes: true,
        }
    );
    assert.deepEqual(
        parsePublishArguments([
            "openai",
            "--history",
            "append",
            "--replay",
            "--yes",
        ]),
        {
            clobber: false,
            help: false,
            history: "append",
            message: undefined,
            replay: true,
            replayFrom: undefined,
            variant: "openai",
            yes: true,
        }
    );
    assert.throws(
        () => parsePublishArguments([
            "openai",
            "--replay-from",
            "main~3",
            "--message",
            UPDATE_MESSAGE,
        ]),
        /cannot be combined with replay/
    );
    assert.throws(
        () => parsePublishArguments([
            "openai",
            "--replay",
            "--replay-from",
            "main~3",
        ]),
        /--replay cannot be combined with --replay-from/
    );
});

test("parsePublishArguments rejects unknown variants and malformed options", () => {
    assert.throws(
        () => parsePublishArguments(["other"]),
        /Unknown template variant/
    );
    assert.throws(
        () => parsePublishArguments(["openai", "--message", "--yes"]),
        /--message requires a value/
    );
    assert.throws(
        () => parsePublishArguments(["--history", "rewrite"]),
        /Unknown history mode/
    );
});

test("publishUsage documents history modes and persistent backups", () => {
    const usage = publishUsage();
    assert.match(
        usage,
        /npm run template:publish -- all --history append --replay/
    );
    assert.match(usage, /prints this expanded command to stderr/);
    assert.match(usage, /all\|openai\|wrangler/);
    assert.match(usage, /both is an alias/);
    assert.match(usage, /--history append\|fresh/);
    assert.match(usage, /--clobber/);
    assert.match(usage, /-m, --message/);
    assert.match(usage, /-r, --replay\s/);
    assert.match(usage, /--replay-from/);
    assert.match(usage, /-y, --yes/);
    assert.match(usage, /-h, --help/);
    assert.match(usage, /root commits default to Initial commit/);
    assert.match(usage, /existing repos need history or clobber/);
    assert.match(usage, /TEMPLATE_PUBLISH_BACKUP_DIR/);
});

test("repository variable writes create and update string publication state", () => {
    assert.deepEqual(
        repositoryVariableWriteArguments({
            repository: FACTORY_REPOSITORY,
            revision: "factory-head",
            variable: factoryRevisionVariable("openai"),
            variableExists: false,
        }),
        [
            "api",
            "--method",
            "POST",
            `repos/${FACTORY_REPOSITORY}/actions/variables`,
            "--raw-field",
            `name=${factoryRevisionVariable("openai")}`,
            "--raw-field",
            "value=factory-head",
        ]
    );
    assert.deepEqual(
        repositoryVariableWriteArguments({
            repository: FACTORY_REPOSITORY,
            revision: "factory-head",
            variable: factoryRevisionVariable("openai"),
            variableExists: true,
        }),
        [
            "api",
            "--method",
            "PATCH",
            `repos/${FACTORY_REPOSITORY}/actions/variables/${factoryRevisionVariable("openai")}`,
            "--raw-field",
            `name=${factoryRevisionVariable("openai")}`,
            "--raw-field",
            "value=factory-head",
        ]
    );
});

test("system dependencies keep publication cursors on factory repository metadata", async () => {
    const root = tempTree();
    const bin = join(root, "bin");
    const fakeGh = join(bin, "gh");
    const logPath = join(root, "gh.log");
    const statePath = join(root, "state.json");
    const originalPath = process.env.PATH;
    const originalLogPath = process.env.TEMPLATE_TEST_GH_LOG;
    const originalStatePath = process.env.TEMPLATE_TEST_GH_STATE;
    const originalMismatch = process.env.TEMPLATE_TEST_GH_MISMATCH;
    mkdirSync(bin);
    writeFileSync(
        fakeGh,
        [
            "#!/usr/bin/env node",
            'const fs = require("node:fs");',
            "const args = process.argv.slice(2);",
            'fs.appendFileSync(process.env.TEMPLATE_TEST_GH_LOG, `${JSON.stringify(args)}\\n`);',
            'if (args[0] === "repo" && args[1] === "view") {',
            `    process.stdout.write("${FACTORY_REPOSITORY}\\n");`,
            "    process.exit(0);",
            "}",
            'const methodIndex = args.indexOf("--method");',
            'const method = methodIndex === -1 ? "GET" : args[methodIndex + 1];',
            "const endpoint = methodIndex === -1 ? args[1] : args[methodIndex + 2];",
            'const marker = "/actions/variables/";',
            "const markerIndex = endpoint.indexOf(marker);",
            "const variable = markerIndex === -1 ? undefined : endpoint.slice(markerIndex + marker.length);",
            "const state = fs.existsSync(process.env.TEMPLATE_TEST_GH_STATE)",
            '    ? JSON.parse(fs.readFileSync(process.env.TEMPLATE_TEST_GH_STATE, "utf8"))',
            "    : {};",
            'if (method === "GET") {',
            "    if (!variable || !Object.hasOwn(state, variable)) {",
            '        process.stderr.write("gh: Not Found (HTTP 404)\\n");',
            "        process.exit(1);",
            "    }",
            "    process.stdout.write(JSON.stringify({ name: variable, value: state[variable] }));",
            "    process.exit(0);",
            "}",
            "const fields = {};",
            "for (let index = 0; index < args.length; index += 1) {",
            '    if (args[index] !== "--raw-field") continue;',
            '    const [name, ...value] = args[index + 1].split("=");',
            '    fields[name] = value.join("=");',
            "}",
            'state[fields.name] = process.env.TEMPLATE_TEST_GH_MISMATCH ? "wrong" : fields.value;',
            "fs.writeFileSync(process.env.TEMPLATE_TEST_GH_STATE, JSON.stringify(state));",
            "",
        ].join("\n")
    );
    chmodSync(fakeGh, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.TEMPLATE_TEST_GH_LOG = logPath;
    process.env.TEMPLATE_TEST_GH_STATE = statePath;
    delete process.env.TEMPLATE_TEST_GH_MISMATCH;

    try {
        const dependencies = createSystemDependencies(root);
        await dependencies.recordFactoryRevision({
            revision: "first-head",
            variant: "openai",
        });
        await dependencies.recordFactoryRevision({
            revision: "second-head",
            variant: "openai",
        });
        await dependencies.recordFactoryRevision({
            revision: "second-head",
            variant: "openai",
        });
        assert.equal(
            await dependencies.readFactoryRevision("openai"),
            "second-head"
        );

        process.env.TEMPLATE_TEST_GH_MISMATCH = "1";
        await assert.rejects(
            dependencies.recordFactoryRevision({
                revision: "wrangler-head",
                variant: "wrangler",
            }),
            /publication state verification failed/
        );

        const calls = readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const apiEndpoints = calls
            .filter(([command]) => command === "api")
            .map((args) => {
                const methodIndex = args.indexOf("--method");
                return methodIndex === -1 ? args[1] : args[methodIndex + 2];
            });
        assert.equal(
            apiEndpoints.every((endpoint) =>
                endpoint.startsWith(
                    `repos/${FACTORY_REPOSITORY}/actions/variables`
                )
            ),
            true
        );
        assert.equal(
            apiEndpoints.some((endpoint) =>
                endpoint.includes(OPENAI_REPOSITORY)
                || endpoint.includes(WRANGLER_REPOSITORY)
            ),
            false
        );
        assert.equal(
            calls.filter((args) => args.includes("POST")).length,
            2
        );
        assert.equal(
            calls.filter((args) => args.includes("PATCH")).length,
            1
        );
    } finally {
        process.env.PATH = originalPath;
        if (originalLogPath === undefined) {
            delete process.env.TEMPLATE_TEST_GH_LOG;
        } else {
            process.env.TEMPLATE_TEST_GH_LOG = originalLogPath;
        }
        if (originalStatePath === undefined) {
            delete process.env.TEMPLATE_TEST_GH_STATE;
        } else {
            process.env.TEMPLATE_TEST_GH_STATE = originalStatePath;
        }
        if (originalMismatch === undefined) {
            delete process.env.TEMPLATE_TEST_GH_MISMATCH;
        } else {
            process.env.TEMPLATE_TEST_GH_MISMATCH = originalMismatch;
        }
        rmSync(root, { force: true, recursive: true });
    }
});

test("isAffirmativeResponse accepts short yes answers", () => {
    assert.equal(isAffirmativeResponse("y"), true);
    assert.equal(isAffirmativeResponse(" YES "), true);
    assert.equal(isAffirmativeResponse(""), false);
    assert.equal(isAffirmativeResponse("no"), false);
    assert.equal(
        isAffirmativeResponse(`${OPENAI_REPOSITORY} fresh`),
        false
    );
});

test("publicationConfirmationQuestion names each target and action", () => {
    assert.equal(
        publicationConfirmationQuestion({
            action: "create",
            repository: OPENAI_REPOSITORY,
        }),
        `Create and publish ${OPENAI_REPOSITORY}? [y/N] `
    );
    assert.equal(
        publicationConfirmationQuestion({
            action: "update",
            history: "append",
            repository: OPENAI_REPOSITORY,
        }),
        `Append and publish a commit to ${OPENAI_REPOSITORY}? [y/N] `
    );
    assert.equal(
        publicationConfirmationQuestion({
            action: "replace",
            history: "fresh",
            repository: OPENAI_REPOSITORY,
        }),
        `Replace main in ${OPENAI_REPOSITORY} with a fresh root commit and force-push? [y/N] `
    );
    assert.equal(
        publicationConfirmationQuestion({
            action: "update",
            commitCount: 3,
            history: "append",
            repository: OPENAI_REPOSITORY,
        }),
        `Append and publish 3 commits to ${OPENAI_REPOSITORY}? [y/N] `
    );
    assert.equal(
        publicationConfirmationQuestion({
            action: "replace",
            commitCount: 1,
            history: "fresh",
            repository: OPENAI_REPOSITORY,
        }),
        `Replace main in ${OPENAI_REPOSITORY} with a fresh history of 1 commit and force-push? [y/N] `
    );
});

test("historyModeChoices describe normal and replay publications accurately", () => {
    assert.deepEqual(historyModeChoices(), [
        "  1. append (recommended): preserve main, then add one update commit",
        "  2. fresh: replace main with one new root commit",
    ]);
    assert.deepEqual(historyModeChoices({ replay: true }), [
        "  1. append (recommended): preserve main, then add relevant factory checkpoints",
        "  2. fresh: replace main with a baseline root plus relevant checkpoints",
    ]);
});

test("resolveCommitMessage defaults for root commits only", () => {
    assert.equal(
        resolveCommitMessage({ repositoryExists: false }),
        "Initial commit"
    );
    assert.equal(
        resolveCommitMessage({
            history: "fresh",
            repositoryExists: true,
        }),
        "Initial commit"
    );
    assert.equal(
        resolveCommitMessage({
            history: "append",
            repositoryExists: true,
            requestedMessage: UPDATE_MESSAGE,
        }),
        UPDATE_MESSAGE
    );
    assert.throws(
        () => resolveCommitMessage({
            history: "append",
            repositoryExists: true,
        }),
        /--message is required/
    );
});

test("parseHttpStatus recognizes GitHub API response formats", () => {
    assert.equal(parseHttpStatus("HTTP/2.0 404 Not Found\n"), HTTP_NOT_FOUND);
    assert.equal(parseHttpStatus("gh: Not Found (HTTP 404)\n"), HTTP_NOT_FOUND);
    assert.equal(parseHttpStatus("network unavailable\n"), null);
});

test("dependabotSecurityUpdatesEnabled accepts live and legacy disabled responses", () => {
    assert.equal(
        dependabotSecurityUpdatesEnabled({
            status: 0,
            stdout: '{"enabled":false,"paused":false}',
        }),
        false
    );
    assert.equal(
        dependabotSecurityUpdatesEnabled({
            status: 0,
            stdout: '{"enabled":true,"paused":false}',
        }),
        true
    );
    assert.equal(
        dependabotSecurityUpdatesEnabled({
            status: 1,
            stderr: "gh: Not Found (HTTP 404)\n",
        }),
        false
    );
    assert.equal(
        dependabotSecurityUpdatesEnabled({
            status: 1,
            stderr: "network unavailable\n",
        }),
        undefined
    );
    assert.throws(
        () => dependabotSecurityUpdatesEnabled({ status: 0, stdout: "{}" }),
        /no Dependabot security updates state/
    );
});

test("syncGeneratedTree replaces content while preserving Git metadata", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const target = join(root, "target");
        mkdirSync(join(source, "nested"), { recursive: true });
        mkdirSync(join(target, ".git"), { recursive: true });
        writeFileSync(join(source, ".gitignore"), "node_modules\n");
        writeFileSync(join(source, "nested", "value.txt"), "generated\n");
        writeFileSync(join(target, ".git", "marker"), "preserve\n");
        writeFileSync(join(target, "stale.txt"), "remove\n");

        syncGeneratedTree(source, target);

        assert.equal(readFileSync(join(target, ".git", "marker"), "utf8"), "preserve\n");
        assert.equal(readFileSync(join(target, ".gitignore"), "utf8"), "node_modules\n");
        assert.equal(readFileSync(join(target, "nested", "value.txt"), "utf8"), "generated\n");
        assert.equal(existsSync(join(target, "stale.txt")), false);
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("mergeChangedPaths combines explicit tracked and untracked paths", () => {
    assert.deepEqual(
        mergeChangedPaths("README.md\0old.txt\0", ".gitignore\0README.md\0"),
        [".gitignore", "README.md", "old.txt"]
    );
});

test("system dependencies stage and commit explicit generated paths", async () => {
    const root = tempTree();
    const dependencies = createSystemDependencies(root);
    let workspace;
    try {
        const output = join(root, "dist", "openai");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, ".gitignore"), "node_modules\n");
        writeFileSync(join(output, "README.md"), "# Generated\n");

        workspace = await dependencies.prepareCheckout({
            config: {
                outputDirectory: "dist/openai",
                repository: "unused/local-test",
            },
            exists: false,
        });
        runGit(workspace.checkout, ["config", "user.name", "Template Test"]);
        runGit(workspace.checkout, [
            "config",
            "user.email",
            "template@example.test",
        ]);

        await dependencies.syncGeneratedTree(
            "dist/openai",
            workspace.checkout
        );
        const paths = await dependencies.collectChangedPaths(workspace.checkout);
        assert.deepEqual(paths, [".gitignore", "README.md"]);

        await dependencies.stagePaths(workspace.checkout, paths);
        const commit = await dependencies.createCommit({
            changedPaths: paths,
            checkout: workspace.checkout,
            history: undefined,
            message: UPDATE_MESSAGE_WITH_BODY,
        });
        assert.match(commit, /^[0-9a-f]{40,64}$/);
        assert.equal(
            runGit(workspace.checkout, ["status", "--porcelain=v1"]),
            ""
        );
        assert.equal(
            runGit(workspace.checkout, ["log", "-1", "--format=%B"]).trim(),
            UPDATE_MESSAGE_WITH_BODY
        );
    } finally {
        if (workspace) await dependencies.cleanup(workspace);
        rmSync(root, { force: true, recursive: true });
    }
});

test("system dependencies reject a generated Dependabot configuration", async () => {
    const root = tempTree();
    const checkout = join(root, "checkout");
    try {
        mkdirSync(join(checkout, ".github"), { recursive: true });
        writeFileSync(
            join(checkout, ".github", "dependabot.yml"),
            "version: 2\n"
        );
        const dependencies = createSystemDependencies(root);
        await assert.rejects(
            dependencies.assertTemplatePolicy({
                checkout,
                repository: OPENAI_REPOSITORY,
                verifyRemote: false,
            }),
            /generated template contains factory-owned \.github\/dependabot\.yml/
        );
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("system dependencies generate first-parent replay snapshots and preserve message bodies", async () => {
    const root = tempTree();
    let replay;
    let emptyReplay;
    try {
        const { baseline, factory } = createReplayFactory(root);
        const dependencies = createSystemDependencies(factory);
        replay = await dependencies.prepareReplay({ from: baseline });

        assert.equal(replay.base.revision, baseline);
        assert.equal(replay.checkpoints.length, 2);
        assert.equal(
            replay.checkpoints[0].message,
            "Add generated feature\n\nExplain the feature boundary"
        );
        assert.equal(
            readFileSync(
                join(replay.base.root, "dist", "openai", "template.txt"),
                "utf8"
            ),
            "baseline\n"
        );
        assert.equal(
            readFileSync(
                join(
                    replay.checkpoints[0].root,
                    "dist",
                    "wrangler",
                    "template.txt"
                ),
                "utf8"
            ),
            "feature\n"
        );
        assert.equal(
            readFileSync(
                join(
                    replay.checkpoints[1].root,
                    "dist",
                    "openai",
                    "template.txt"
                ),
                "utf8"
            ),
            "feature\n"
        );
        await dependencies.cleanupReplay(replay);
        replay = undefined;

        const head = runGit(factory, ["rev-parse", "HEAD"]).trim();
        emptyReplay = await dependencies.prepareReplay({ from: head });
        assert.equal(emptyReplay.base.revision, head);
        assert.deepEqual(emptyReplay.checkpoints, []);
        await dependencies.cleanupReplay(emptyReplay);
        emptyReplay = undefined;
    } finally {
        if (replay) rmSync(replay.tempRoot, { force: true, recursive: true });
        if (emptyReplay) {
            rmSync(emptyReplay.tempRoot, { force: true, recursive: true });
        }
        rmSync(root, { force: true, recursive: true });
    }
});

test("system dependencies replace main with a backed-up parentless commit", async () => {
    const root = tempTree();
    try {
        const { initialCommit, remote } = createTemplateRemote(root);
        const checkout = join(root, "checkout");
        const backupRoot = join(root, "backups");
        execFileSync("git", [
            "clone",
            "--quiet",
            "--branch",
            "main",
            remote,
            checkout,
        ]);
        configureTestGit(checkout);
        writeFileSync(join(checkout, "README.md"), "# Fresh\n");
        writeFileSync(join(checkout, "fresh.txt"), "new\n");
        rmSync(join(checkout, "stale.txt"));

        const dependencies = createSystemDependencies(root);
        const changedPaths = await dependencies.collectChangedPaths(checkout);
        assert.deepEqual(changedPaths, [
            "README.md",
            "fresh.txt",
            "stale.txt",
        ]);
        await dependencies.stagePaths(checkout, changedPaths);
        const backup = await dependencies.createMirrorBackup({
            backupRoot,
            expectedCommit: initialCommit,
            repository: "local/template",
            url: remote,
        });
        const commit = await dependencies.createCommit({
            changedPaths,
            checkout,
            expectedCommit: initialCommit,
            history: "fresh",
            message: "Fresh template",
        });

        assert.equal(existsSync(backup), true);
        assert.equal(
            runGit(backup, ["rev-parse", "refs/heads/main"]).trim(),
            initialCommit
        );
        await assert.rejects(
            dependencies.createMirrorBackup({
                backupRoot,
                expectedCommit: initialCommit,
                repository: "local/template",
                url: remote,
            }),
            /already has a retained recovery mirror/
        );
        assert.equal(
            runGit(checkout, ["rev-list", "--parents", "-n", "1", commit]).trim(),
            commit
        );
        assert.equal(
            runGit(checkout, ["ls-tree", "-r", "--name-only", commit]),
            "README.md\nfresh.txt\n"
        );
        await dependencies.pushFresh({
            checkout,
            commit,
            expectedCommit: initialCommit,
        });
        assert.equal(
            runGit(remote, ["rev-parse", "refs/heads/main"]).trim(),
            commit
        );
        assert.equal(existsSync(backup), true);
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("fresh publication lease rejects a remote that moved after backup", async () => {
    const root = tempTree();
    try {
        const { initialCommit, remote } = createTemplateRemote(root);
        const checkout = join(root, "checkout");
        const rival = join(root, "rival");
        execFileSync("git", ["clone", "--quiet", "--branch", "main", remote, checkout]);
        execFileSync("git", ["clone", "--quiet", "--branch", "main", remote, rival]);
        configureTestGit(checkout);
        configureTestGit(rival);

        writeFileSync(join(checkout, "README.md"), "# Fresh\n");
        const dependencies = createSystemDependencies(root);
        const changedPaths = await dependencies.collectChangedPaths(checkout);
        await dependencies.stagePaths(checkout, changedPaths);
        const backup = await dependencies.createMirrorBackup({
            backupRoot: join(root, "backups"),
            expectedCommit: initialCommit,
            repository: "local/template",
            url: remote,
        });
        const commit = await dependencies.createCommit({
            changedPaths,
            checkout,
            expectedCommit: initialCommit,
            history: "fresh",
            message: "Fresh template",
        });

        writeFileSync(join(rival, "rival.txt"), "rival\n");
        runGit(rival, ["add", "--", "rival.txt"]);
        runGit(rival, ["commit", "-m", "Concurrent update", "--", "rival.txt"]);
        runGit(rival, ["push", "--quiet", "origin", "main"]);
        const rivalCommit = runGit(rival, ["rev-parse", "HEAD"]).trim();

        await assert.rejects(
            dependencies.pushFresh({
                checkout,
                commit,
                expectedCommit: initialCommit,
            }),
            /force-with-lease/
        );
        assert.equal(
            runGit(remote, ["rev-parse", "refs/heads/main"]).trim(),
            rivalCommit
        );
        assert.equal(
            runGit(backup, ["rev-parse", "refs/heads/main"]).trim(),
            initialCommit
        );
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("factory preflight requires clean main matching origin/main", async () => {
    const root = tempTree();
    try {
        const factory = join(root, "factory");
        const remote = join(root, "origin.git");
        mkdirSync(factory);
        execFileSync("git", ["init", "--bare", remote]);
        execFileSync("git", ["init", "-b", "main", factory]);
        runGit(factory, ["config", "user.name", "Template Test"]);
        runGit(factory, ["config", "user.email", "template@example.test"]);
        writeFileSync(join(factory, "README.md"), "# Factory\n");
        runGit(factory, ["add", "--", "README.md"]);
        runGit(factory, [
            "commit",
            "-m",
            "Initial commit",
            "--",
            "README.md",
        ]);
        runGit(factory, ["remote", "add", "origin", remote]);
        runGit(factory, [
            "push",
            "--quiet",
            "--set-upstream",
            "origin",
            "main",
        ]);

        const dependencies = createSystemDependencies(factory);
        await assert.doesNotReject(dependencies.assertFactoryReady());

        writeFileSync(join(factory, "README.md"), "# Dirty factory\n");
        await assert.rejects(
            dependencies.assertFactoryReady(),
            /factory worktree must be clean/
        );
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("publishTemplates compares both variants before publishing and runs setup once", async () => {
    const fake = fakeDependencies({ exists: true });
    const results = await publishTemplates(
        {
            help: false,
            history: "append",
            message: UPDATE_MESSAGE,
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ status, variant }) => ({ status, variant })),
        [
            { status: "updated", variant: "openai" },
            { status: "updated", variant: "wrangler" },
        ]
    );
    assert.equal(
        fake.operations.filter(
            (operation) => operation === "assertFactoryReady"
        ).length,
        1
    );
    assert.equal(
        fake.operations.filter((operation) => operation === "generate").length,
        1
    );
    assert.equal(
        fake.operations.indexOf(`collectChangedPaths:${WRANGLER_REPOSITORY}`)
            < fake.operations.indexOf(
                `stage:${OPENAI_REPOSITORY}:README.md`
            ),
        true
    );
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:append:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            `commit:${WRANGLER_REPOSITORY}:append:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
    assert.equal(fake.operations.includes("log:openai    updated"), true);
    assert.equal(fake.operations.includes("log:wrangler  updated"), true);
});

test("checkpoint replay preserves relevant factory commits and pushes each template once", async () => {
    const replay = {
        base: { revision: "baseline" },
        checkpoints: [
            {
                message: "Add shared platform",
                revision: "shared",
            },
            {
                message: "Clarify Sites development",
                revision: "openai-docs",
            },
            {
                message: "Add complete interfaces\n\nKeep each runtime native",
                revision: "interfaces",
            },
        ],
        tempRoot: "replay-temp",
    };
    const fake = fakeDependencies({
        changedPathSequenceByRepository: {
            [OPENAI_REPOSITORY]: [
                ["README.md"],
                [],
                ["platform.ts"],
                ["README.md"],
                ["app/page.tsx"],
                [],
            ],
            [WRANGLER_REPOSITORY]: [
                ["README.md"],
                [],
                ["platform.ts"],
                [],
                ["public/index.html"],
                [],
            ],
        },
        exists: true,
        replay,
    });
    const results = await publishTemplates(
        {
            help: false,
            replayFrom: "baseline",
            variant: "all",
            yes: false,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ commitCount, status, variant }) => ({
            commitCount,
            status,
            variant,
        })),
        [
            { commitCount: 3, status: "updated", variant: "openai" },
            { commitCount: 2, status: "updated", variant: "wrangler" },
        ]
    );
    assert.equal(
        fake.operations.filter(
            (operation) => operation === "prepareReplay:baseline"
        ).length,
        1
    );
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:append:Clarify Sites development:README.md`
        ),
        true
    );
    assert.equal(
        fake.operations.some((operation) =>
            operation.startsWith(
                `commit:${WRANGLER_REPOSITORY}:append:Clarify Sites development:`
            )
        ),
        false
    );
    assert.equal(
        fake.operations.includes(
            `commit:${WRANGLER_REPOSITORY}:append:Add complete interfaces\n\nKeep each runtime native:public/index.html`
        ),
        true
    );
    assert.equal(
        fake.operations.filter(
            (operation) => operation === `pushUpdate:${OPENAI_REPOSITORY}`
        ).length,
        1
    );
    assert.equal(
        fake.operations.filter(
            (operation) => operation === `pushUpdate:${WRANGLER_REPOSITORY}`
        ).length,
        1
    );
    assert.equal(
        fake.operations.includes(
            `confirmCommitCount:${OPENAI_REPOSITORY}:3`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            `confirmCommitCount:${WRANGLER_REPOSITORY}:2`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            `requestHistoryReplay:${OPENAI_REPOSITORY}:true`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            `requestHistoryReplay:${WRANGLER_REPOSITORY}:true`
        ),
        true
    );
    assert.equal(
        fake.operations.includes("cleanupReplay:replay-temp"),
        true
    );
    assert.equal(
        fake.operations.some((operation) =>
            operation.startsWith("requestCommitMessage:")
        ),
        false
    );
});

test("recorded replay uses each template cursor from factory state", async () => {
    const fake = fakeDependencies({
        changedPathSequenceByRepository: {
            [OPENAI_REPOSITORY]: [
                ["README.md"],
                [],
                ["sites.ts"],
                [],
            ],
            [WRANGLER_REPOSITORY]: [
                ["README.md"],
                [],
                ["worker.ts"],
                [],
            ],
        },
        factoryRevisionsByVariant: {
            openai: "openai-base",
            wrangler: "wrangler-base",
        },
        replayByRevision: {
            "openai-base": {
                base: { revision: "openai-base" },
                checkpoints: [
                    {
                        message: "Improve Sites empty state",
                        revision: "factory-head",
                    },
                ],
                tempRoot: "replay-temp:openai-base",
            },
            "wrangler-base": {
                base: { revision: "wrangler-base" },
                checkpoints: [
                    {
                        message: "Refine Worker interface",
                        revision: "factory-head",
                    },
                ],
                tempRoot: "replay-temp:wrangler-base",
            },
        },
    });
    const results = await publishTemplates(
        {
            help: false,
            history: "append",
            replay: true,
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ commitCount, status, variant }) => ({
            commitCount,
            status,
            variant,
        })),
        [
            { commitCount: 1, status: "updated", variant: "openai" },
            { commitCount: 1, status: "updated", variant: "wrangler" },
        ]
    );
    assert.equal(
        fake.operations.includes("readFactoryRevision:openai"),
        true
    );
    assert.equal(
        fake.operations.includes("readFactoryRevision:wrangler"),
        true
    );
    assert.equal(
        fake.operations.includes("prepareReplay:openai-base"),
        true
    );
    assert.equal(
        fake.operations.includes("prepareReplay:wrangler-base"),
        true
    );
    assert.equal(
        fake.operations.includes("assertReplayBaseline:openai-base"),
        true
    );
    assert.equal(
        fake.operations.includes("assertReplayBaseline:wrangler-base"),
        true
    );
    for (const variant of ["openai", "wrangler"]) {
        const repository = variant === "openai"
            ? OPENAI_REPOSITORY
            : WRANGLER_REPOSITORY;
        assert.equal(
            fake.operations.indexOf(`verifyPublished:${repository}`)
                < fake.operations.indexOf(
                    `recordFactoryRevision:${variant}:factory-head`
                ),
            true
        );
    }
    assert.equal(
        fake.operations.includes("cleanupReplay:replay-temp:openai-base"),
        true
    );
    assert.equal(
        fake.operations.includes("cleanupReplay:replay-temp:wrangler-base"),
        true
    );
});

test("recorded replay shares a cursor snapshot and advances without new commits", async () => {
    const fake = fakeDependencies({
        changedPathSequenceByRepository: {
            [OPENAI_REPOSITORY]: [[], [], []],
            [WRANGLER_REPOSITORY]: [[], [], []],
        },
        factoryRevisionsByVariant: {
            openai: "factory-head",
            wrangler: "factory-head",
        },
        replayByRevision: {
            "factory-head": {
                base: { revision: "factory-head" },
                checkpoints: [],
                tempRoot: "replay-temp:factory-head",
            },
        },
    });
    const results = await publishTemplates(
        {
            help: false,
            history: "append",
            replay: true,
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ status, variant }) => ({ status, variant })),
        [
            { status: "unchanged", variant: "openai" },
            { status: "unchanged", variant: "wrangler" },
        ]
    );
    assert.equal(
        fake.operations.filter(
            (operation) => operation === "prepareReplay:factory-head"
        ).length,
        1
    );
    assert.equal(
        fake.operations.filter(
            (operation) => operation === "assertReplayBaseline:factory-head"
        ).length,
        1
    );
    assert.equal(
        fake.operations.filter(
            (operation) => operation === "cleanupReplay:replay-temp:factory-head"
        ).length,
        1
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("push")),
        false
    );
    assert.equal(
        fake.operations.includes(
            "recordFactoryRevision:openai:factory-head"
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            "recordFactoryRevision:wrangler:factory-head"
        ),
        true
    );
});

test("recorded replay requires a bootstrapped factory cursor", async () => {
    const fake = fakeDependencies({ exists: true });

    await assert.rejects(
        publishTemplates(
            {
                help: false,
                history: "append",
                replay: true,
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /Factory publication state has no revision.*--replay-from <revision>/
    );
    assert.equal(
        fake.operations.includes("readFactoryRevision:openai"),
        true
    );
    assert.equal(fake.operations.includes("generate"), false);
    assert.equal(
        fake.operations.some((operation) =>
            operation.startsWith("prepareCheckout:")
        ),
        false
    );
    assert.equal(
        fake.operations.some((operation) =>
            operation.startsWith("prepareReplay:")
        ),
        false
    );
    assert.equal(
        fake.operations.some((operation) =>
            operation.startsWith("assertReplayBaseline:")
        ),
        false
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("push")),
        false
    );
});

test("recorded replay validates cursors before clobber cleanup", async () => {
    const backup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [backup],
        },
    });

    await assert.rejects(
        publishTemplates(
            {
                clobber: true,
                help: false,
                history: "fresh",
                replay: true,
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /Factory publication state has no revision/
    );
    assert.equal(fake.operations.includes("assertFactoryReady"), true);
    assert.equal(fake.operations.includes("generate"), false);
    assert.equal(
        fake.operations.some((operation) =>
            operation.startsWith("moveBackupsToTrash:")
        ),
        false
    );
});

test("explicit replay validates its baseline before clobber cleanup", async () => {
    const backup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        exists: true,
        replayBaselineError: new Error("Unknown replay baseline revision"),
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [backup],
        },
    });

    await assert.rejects(
        publishTemplates(
            {
                clobber: true,
                help: false,
                history: "fresh",
                replayFrom: "missing",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /Unknown replay baseline revision/
    );
    assert.equal(
        fake.operations.includes("assertReplayBaseline:missing"),
        true
    );
    assert.equal(fake.operations.includes("generate"), false);
    assert.equal(
        fake.operations.some((operation) =>
            operation.startsWith("moveBackupsToTrash:")
        ),
        false
    );
});

test("append replay refuses a baseline that does not match remote main", async () => {
    const fake = fakeDependencies({
        changedPathSequenceByRepository: {
            [OPENAI_REPOSITORY]: [
                ["README.md"],
                ["unexpected.txt"],
            ],
        },
        exists: true,
        replay: {
            base: { revision: "baseline" },
            checkpoints: [
                { message: "Add feature", revision: "feature" },
            ],
            tempRoot: "replay-temp",
        },
    });

    await assert.rejects(
        publishTemplates(
            {
                help: false,
                history: "append",
                replayFrom: "baseline",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /append replay baseline does not match remote main/
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("commit:")),
        false
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("push")),
        false
    );
    assert.equal(
        fake.operations.includes("cleanupReplay:replay-temp"),
        true
    );
});

test("append replay checks every baseline before publishing either template", async () => {
    const fake = fakeDependencies({
        changedPathSequenceByRepository: {
            [OPENAI_REPOSITORY]: [
                ["README.md"],
                [],
                ["openai.ts"],
                [],
            ],
            [WRANGLER_REPOSITORY]: [
                ["README.md"],
                ["package.json"],
            ],
        },
        exists: true,
        replay: {
            base: { revision: "baseline" },
            checkpoints: [{ message: "Add feature", revision: "feature" }],
            tempRoot: "replay-temp",
        },
    });

    await assert.rejects(
        publishTemplates(
            {
                help: false,
                history: "append",
                replayFrom: "baseline",
                variant: "all",
                yes: true,
            },
            fake.dependencies
        ),
        /j-256\/d1-r2-starter-wrangler: append replay baseline does not match remote main/
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("push")),
        false
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("recordFactoryRevision:")),
        false
    );
});

test("fresh replay creates a baseline root before curated checkpoints", async () => {
    const fake = fakeDependencies({
        changedPathSequenceByRepository: {
            [OPENAI_REPOSITORY]: [
                ["README.md"],
                ["baseline.txt"],
                ["feature.ts"],
                [],
                [],
            ],
        },
        exists: true,
        replay: {
            base: { revision: "baseline" },
            checkpoints: [
                { message: "Add feature", revision: "feature" },
                { message: "Change factory tooling", revision: "tooling" },
            ],
            tempRoot: "replay-temp",
        },
    });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            replayFrom: "baseline",
            variant: "openai",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.status, "replaced");
    assert.equal(result.commitCount, 2);
    assert.equal(result.backup, `backup:${OPENAI_REPOSITORY}`);
    const rootCommit = fake.operations.indexOf(
        `commit:${OPENAI_REPOSITORY}:fresh:Initial commit:baseline.txt`
    );
    const featureCommit = fake.operations.indexOf(
        `commit:${OPENAI_REPOSITORY}:append:Add feature:feature.ts`
    );
    const backup = fake.operations.indexOf(
        `createMirrorBackup:${OPENAI_REPOSITORY}`
    );
    const push = fake.operations.indexOf(`pushFresh:${OPENAI_REPOSITORY}`);
    assert.equal(rootCommit < featureCommit, true);
    assert.equal(featureCommit < backup, true);
    assert.equal(backup < push, true);
    assert.equal(
        fake.operations.some((operation) =>
            operation.includes("Change factory tooling")
            && operation.startsWith("commit:")
        ),
        false
    );
    assert.equal(
        fake.operations.includes("log:openai  replaced (2 commits) (backup: backup:j-256/d1-r2-starter-openai)"),
        true
    );
});

test("publishTemplates processes both variants for an explicit all selection", async () => {
    const fake = fakeDependencies({ changedPaths: [], exists: true });
    const results = await publishTemplates(
        {
            help: false,
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ variant }) => variant),
        ["openai", "wrangler"]
    );
});

test("publishTemplates rejects an omitted target before doing work", async () => {
    const fake = fakeDependencies({ changedPaths: [], exists: true });

    await assert.rejects(
        publishTemplates(
            {
                help: false,
                yes: true,
            },
            fake.dependencies
        ),
        /Pass all for both templates/
    );
    assert.deepEqual(fake.operations, []);
});

test("publishTemplates rejects inconsistent clobber options before doing work", async () => {
    const fake = fakeDependencies({ exists: true });

    await assert.rejects(
        publishTemplates(
            {
                clobber: true,
                help: false,
                history: "append",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /requires fresh history/
    );
    assert.deepEqual(fake.operations, []);
});

test("publishTemplates reports unchanged variants without staging", async () => {
    const fake = fakeDependencies({ changedPaths: [], exists: true });
    const results = await publishTemplates(
        {
            help: false,
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ status, variant }) => ({ status, variant })),
        [
            { status: "unchanged", variant: "openai" },
            { status: "unchanged", variant: "wrangler" },
        ]
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("stage:")),
        false
    );
    assert.equal(
        fake.operations.indexOf(
            `assertTemplatePolicy:${OPENAI_REPOSITORY}:remote`
        ) < fake.operations.indexOf(
            "recordFactoryRevision:openai:factory-head"
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            "recordFactoryRevision:openai:factory-head"
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            "recordFactoryRevision:wrangler:factory-head"
        ),
        true
    );
    assert.equal(fake.operations.includes("log:Nothing published."), true);
});

test("publishTemplates rejects downstream policy drift before staging", async () => {
    const fake = fakeDependencies({
        exists: true,
        policyError: new Error("Dependabot security updates must be disabled"),
    });

    await assert.rejects(
        publishTemplates(
            {
                help: false,
                history: "append",
                message: UPDATE_MESSAGE,
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /Dependabot security updates must be disabled/
    );
    assert.equal(
        fake.operations.includes(
            `assertTemplatePolicy:${OPENAI_REPOSITORY}:remote`
        ),
        true
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("stage:")),
        false
    );
    assert.equal(
        fake.operations.some((operation) =>
            operation.startsWith("recordFactoryRevision:")
        ),
        false
    );
    assert.equal(
        fake.operations.includes(`cleanup:${OPENAI_REPOSITORY}`),
        true
    );
});

test("publishTemplates leaves the cursor unchanged when policy drifts after publication", async () => {
    const fake = fakeDependencies({
        exists: true,
        policyErrorSequenceByRepository: {
            [OPENAI_REPOSITORY]: [
                undefined,
                new Error("Dependabot security updates changed after push"),
            ],
        },
    });

    await assert.rejects(
        publishTemplates(
            {
                help: false,
                history: "append",
                message: UPDATE_MESSAGE,
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /Dependabot security updates changed after push/
    );
    const remoteVerification = fake.operations.indexOf(
        `verifyPublished:${OPENAI_REPOSITORY}`
    );
    const finalPolicyVerification = fake.operations.lastIndexOf(
        `assertTemplatePolicy:${OPENAI_REPOSITORY}:remote`
    );
    assert.equal(
        fake.operations.includes(`pushUpdate:${OPENAI_REPOSITORY}`),
        true
    );
    assert.equal(remoteVerification < finalPolicyVerification, true);
    assert.equal(
        fake.operations.some((operation) =>
            operation.startsWith("recordFactoryRevision:")
        ),
        false
    );
    assert.equal(
        fake.operations.includes(`cleanup:${OPENAI_REPOSITORY}`),
        true
    );
});

test("publishTemplates creates a missing repository", async () => {
    const fake = fakeDependencies({ exists: false });
    const [result] = await publishTemplates(
        { help: false, variant: "openai", yes: true },
        fake.dependencies
    );

    assert.equal(result.action, "create");
    assert.equal(result.status, "created");
    assert.equal(
        fake.operations.includes(`createRepository:${OPENAI_REPOSITORY}`),
        true
    );
    assert.equal(
        fake.operations.some(
            (operation) => operation.startsWith("pushUpdate:")
        ),
        false
    );
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:create:Initial commit:README.md`
        ),
        true
    );
});

test("publishTemplates updates an existing repository with a normal push", async () => {
    const fake = fakeDependencies({ exists: true });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "append",
            message: UPDATE_MESSAGE,
            variant: "wrangler",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.action, "update");
    assert.equal(result.status, "updated");
    assert.equal(
        fake.operations.includes(`pushUpdate:${WRANGLER_REPOSITORY}`),
        true
    );
    assert.equal(
        fake.operations.some(
            (operation) => operation.startsWith("createRepository:")
        ),
        false
    );
    assert.equal(
        fake.operations.includes(
            `commit:${WRANGLER_REPOSITORY}:append:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
});

test("publishTemplates replaces existing history only after creating a mirror", async () => {
    const fake = fakeDependencies({ exists: true });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.action, "replace");
    assert.equal(result.status, "replaced");
    assert.equal(result.backup, `backup:${OPENAI_REPOSITORY}`);
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:fresh:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(`pushFresh:${OPENAI_REPOSITORY}`),
        true
    );
    assert.equal(
        fake.operations.includes(`pushUpdate:${OPENAI_REPOSITORY}`),
        false
    );
    const backup = fake.operations.indexOf(
        `createMirrorBackup:${OPENAI_REPOSITORY}`
    );
    const commit = fake.operations.indexOf(
        `commit:${OPENAI_REPOSITORY}:fresh:${UPDATE_MESSAGE}:README.md`
    );
    const push = fake.operations.indexOf(`pushFresh:${OPENAI_REPOSITORY}`);
    assert.equal(backup < commit, true);
    assert.equal(commit < push, true);
    assert.equal(
        fake.operations.some(
            (operation) => operation.includes(
                `replaced (backup: backup:${OPENAI_REPOSITORY})`
            )
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            "log:After inspecting the replacement, clean up with npm run template:backups -- trash <variant>."
        ),
        true
    );
});

test("explicit fresh mode replaces history even when files are unchanged", async () => {
    const fake = fakeDependencies({ changedPaths: [], exists: true });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "wrangler",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.status, "replaced");
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("stage:")),
        false
    );
    assert.equal(
        fake.operations.includes(
            `commit:${WRANGLER_REPOSITORY}:fresh:${UPDATE_MESSAGE}:`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(`pushFresh:${WRANGLER_REPOSITORY}`),
        true
    );
});

test("publishTemplates surfaces retained mirrors before factory verification", async () => {
    const backup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        changedPaths: [],
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [backup],
        },
    });
    await publishTemplates(
        {
            help: false,
            variant: "wrangler",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(
        fake.operations.includes("log:== Retained recovery mirrors =="),
        true
    );
    assert.equal(
        fake.operations.includes(`log:  openai: ${backup}`),
        true
    );
    assert.equal(
        fake.operations.indexOf(`listRetainedBackups:${OPENAI_REPOSITORY}`)
            < fake.operations.indexOf("assertFactoryReady"),
        true
    );
});

test("publishTemplates refuses to accumulate fresh-mode mirrors", async () => {
    const backup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [backup],
        },
    });

    await assert.rejects(
        publishTemplates(
            {
                help: false,
                history: "fresh",
                message: UPDATE_MESSAGE,
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /stopped to avoid accumulating unresolved mirrors/
    );
    assert.equal(
        fake.operations.includes(`createMirrorBackup:${OPENAI_REPOSITORY}`),
        false
    );
    assert.equal(fake.operations.includes("assertFactoryReady"), false);
    assert.equal(fake.operations.includes("generate"), false);
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("commit:")),
        false
    );
});

test("clobber replaces all histories and cleans old and verified mirrors", async () => {
    const openaiBackup = "/state/openai-backup.git";
    const wranglerBackup = "/state/wrangler-backup.git";
    const fake = fakeDependencies({
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [openaiBackup],
            [WRANGLER_REPOSITORY]: [wranglerBackup],
        },
    });
    const results = await publishTemplates(
        {
            clobber: true,
            help: false,
            history: "fresh",
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ backup, backupTrashed, status, variant }) => ({
            backup,
            backupTrashed,
            status,
            variant,
        })),
        [
            {
                backup: undefined,
                backupTrashed: true,
                status: "replaced",
                variant: "openai",
            },
            {
                backup: undefined,
                backupTrashed: true,
                status: "replaced",
                variant: "wrangler",
            },
        ]
    );
    const oldCleanup = fake.operations.indexOf(
        `moveBackupsToTrash:${openaiBackup},${wranglerBackup}`
    );
    assert.equal(
        fake.operations.includes(
            "log:Clobber mode will move mirrors for selected targets to Trash after factory verification."
        ),
        true
    );
    assert.equal(
        fake.operations.indexOf("assertFactoryReady") < oldCleanup,
        true
    );
    assert.equal(oldCleanup < fake.operations.indexOf("generate"), true);
    for (const [variant, repository] of [
        ["openai", OPENAI_REPOSITORY],
        ["wrangler", WRANGLER_REPOSITORY],
    ]) {
        assert.equal(
            fake.operations.includes(
                `commit:${repository}:fresh:Initial commit:README.md`
            ),
            true
        );
        const verify = fake.operations.indexOf(
            `verifyPublished:${repository}`
        );
        const record = fake.operations.indexOf(
            `recordFactoryRevision:${variant}:factory-head`
        );
        const cleanup = fake.operations.indexOf(
            `moveBackupsToTrash:backup:${repository}`
        );
        assert.equal(verify < record, true);
        assert.equal(record < cleanup, true);
        assert.equal(
            fake.operations.includes(`confirmBackupCleanup:${repository}`),
            false
        );
    }
});

test("clobber leaves retained mirrors for unselected variants untouched", async () => {
    const openaiBackup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        changedPaths: [],
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [openaiBackup],
        },
    });
    const [result] = await publishTemplates(
        {
            clobber: true,
            help: false,
            history: "fresh",
            variant: "wrangler",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.variant, "wrangler");
    assert.equal(result.backupTrashed, true);
    assert.equal(
        fake.operations.some((operation) => operation.includes(openaiBackup)),
        true
    );
    assert.equal(
        fake.operations.some((operation) =>
            operation.startsWith("moveBackupsToTrash:")
            && operation.includes(openaiBackup)
        ),
        false
    );
});

test("clobber stops before generation when old mirror cleanup fails", async () => {
    const backup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [backup],
        },
        trashError: new Error("trash unavailable"),
    });

    await assert.rejects(
        publishTemplates(
            {
                clobber: true,
                help: false,
                history: "fresh",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /could not move selected retained recovery mirrors to Trash/
    );
    assert.equal(fake.operations.includes("assertFactoryReady"), true);
    assert.equal(fake.operations.includes("generate"), false);
});

test("clobber retains a new mirror when remote verification fails", async () => {
    const fake = fakeDependencies({
        exists: true,
        verifyError: new Error("verification failed"),
    });

    await assert.rejects(
        publishTemplates(
            {
                clobber: true,
                help: false,
                history: "fresh",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /verification failed/
    );
    assert.equal(
        fake.operations.includes(`createMirrorBackup:${OPENAI_REPOSITORY}`),
        true
    );
    assert.equal(
        fake.operations.includes(
            `moveBackupsToTrash:backup:${OPENAI_REPOSITORY}`
        ),
        false
    );
    assert.equal(
        fake.operations.includes(
            "recordFactoryRevision:openai:factory-head"
        ),
        false
    );
});

test("clobber retains a new mirror when factory state recording fails", async () => {
    const fake = fakeDependencies({
        exists: true,
        recordError: new Error("state unavailable"),
    });

    await assert.rejects(
        publishTemplates(
            {
                clobber: true,
                help: false,
                history: "fresh",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        new RegExp(
            `verified factory revision was not recorded in factory state ${factoryRevisionVariable("openai")}`
        )
    );
    assert.equal(
        fake.operations.indexOf(`verifyPublished:${OPENAI_REPOSITORY}`)
            < fake.operations.indexOf(
                "recordFactoryRevision:openai:factory-head"
            ),
        true
    );
    assert.equal(
        fake.operations.includes(
            `moveBackupsToTrash:backup:${OPENAI_REPOSITORY}`
        ),
        false
    );
});

test("clobber reports a retained mirror when verified cleanup fails", async () => {
    const fake = fakeDependencies({
        exists: true,
        trashError: new Error("trash unavailable"),
    });

    await assert.rejects(
        publishTemplates(
            {
                clobber: true,
                help: false,
                history: "fresh",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /published and verified, but clobber cleanup failed/
    );
    assert.equal(
        fake.operations.indexOf(`verifyPublished:${OPENAI_REPOSITORY}`)
            < fake.operations.indexOf(
                `moveBackupsToTrash:backup:${OPENAI_REPOSITORY}`
            ),
        true
    );
});

test("explicit non-interactive fresh mode defaults its root commit message", async () => {
    const fake = fakeDependencies({ exists: true });
    const results = await publishTemplates(
        {
            help: false,
            history: "fresh",
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ status, variant }) => ({ status, variant })),
        [
            { status: "replaced", variant: "openai" },
            { status: "replaced", variant: "wrangler" },
        ]
    );
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:fresh:Initial commit:README.md`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            `commit:${WRANGLER_REPOSITORY}:fresh:Initial commit:README.md`
        ),
        true
    );
});

test("explicit fresh mode keeps the initial message default for a missing repo", async () => {
    const fake = fakeDependencies({ exists: false });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            variant: "openai",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.status, "created");
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:create:Initial commit:README.md`
        ),
        true
    );
});

test("explicit fresh mode ignores retained mirrors for unselected variants", async () => {
    const openaiBackup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        changedPaths: [],
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [openaiBackup],
        },
    });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "wrangler",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.variant, "wrangler");
    assert.equal(result.status, "replaced");
});

test("interactive fresh publication trashes a verified mirror on request", async () => {
    const fake = fakeDependencies({
        cleanupBackup: true,
        exists: true,
    });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: false,
        },
        fake.dependencies
    );

    assert.equal(result.backup, undefined);
    assert.equal(result.backupTrashed, true);
    const verify = fake.operations.indexOf(
        `verifyPublished:${OPENAI_REPOSITORY}`
    );
    const requestCleanup = fake.operations.indexOf(
        `confirmBackupCleanup:${OPENAI_REPOSITORY}`
    );
    const trash = fake.operations.indexOf(
        `moveBackupsToTrash:backup:${OPENAI_REPOSITORY}`
    );
    assert.equal(verify < requestCleanup, true);
    assert.equal(requestCleanup < trash, true);
    assert.equal(
        fake.operations.some((operation) =>
            operation.includes("replaced (backup moved to Trash)")
        ),
        true
    );
});

test("interactive fresh publication retains a mirror when Trash fails", async () => {
    const fake = fakeDependencies({
        cleanupBackup: true,
        exists: true,
        trashError: new Error("trash unavailable"),
    });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: false,
        },
        fake.dependencies
    );

    assert.equal(result.backup, `backup:${OPENAI_REPOSITORY}`);
    assert.equal(result.backupTrashed, false);
    assert.equal(
        fake.operations.includes(
            "log:Could not move the mirror to Trash: trash unavailable"
        ),
        true
    );
});

test("non-interactive fresh publication retains its verified mirror", async () => {
    const fake = fakeDependencies({ exists: true });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.backup, `backup:${OPENAI_REPOSITORY}`);
    assert.equal(result.backupTrashed, false);
    assert.equal(
        fake.operations.includes(
            `confirmBackupCleanup:${OPENAI_REPOSITORY}`
        ),
        false
    );
    assert.equal(
        fake.operations.includes(
            `log:Mirror backup retained at backup:${OPENAI_REPOSITORY}`
        ),
        true
    );
});

test("publishTemplates prompts for an update message after showing the diff", async () => {
    const fake = fakeDependencies({ exists: true });
    const [result] = await publishTemplates(
        {
            help: false,
            variant: "openai",
            yes: false,
        },
        fake.dependencies
    );

    assert.equal(result.status, "updated");
    const showDiff = fake.operations.indexOf(
        `showStagedDiff:${OPENAI_REPOSITORY}`
    );
    const requestHistory = fake.operations.indexOf(
        `requestHistoryMode:${OPENAI_REPOSITORY}`
    );
    const requestMessage = fake.operations.indexOf(
        `requestCommitMessage:${OPENAI_REPOSITORY}`
    );
    const confirm = fake.operations.indexOf(
        `confirm:${OPENAI_REPOSITORY}:append`
    );
    assert.equal(showDiff < requestHistory, true);
    assert.equal(requestHistory < requestMessage, true);
    assert.equal(requestMessage < confirm, true);
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:append:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
});

test("publishTemplates requires a message for a changed update with --yes", async () => {
    const fake = fakeDependencies({ exists: true });
    await assert.rejects(
        publishTemplates(
            {
                help: false,
                history: "append",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /--message is required/
    );
    assert.equal(
        fake.operations.includes(`stage:${OPENAI_REPOSITORY}:README.md`),
        true
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("commit:")),
        false
    );
    assert.equal(
        fake.operations.at(-1),
        `cleanup:${OPENAI_REPOSITORY}`
    );
});

test("publishTemplates requires an explicit history mode with --yes", async () => {
    const fake = fakeDependencies({ exists: true });
    await assert.rejects(
        publishTemplates(
            {
                help: false,
                message: UPDATE_MESSAGE,
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /--history is required/
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("commit:")),
        false
    );
});

test("publishTemplates cancels before committing or publishing", async () => {
    const fake = fakeDependencies({
        confirmed: false,
        exists: true,
        requestedHistory: "fresh",
    });
    const [result] = await publishTemplates(
        {
            help: false,
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: false,
        },
        fake.dependencies
    );

    assert.equal(result.status, "cancelled");
    assert.equal(result.action, "replace");
    assert.equal(
        fake.operations.some(
            (operation) => operation.startsWith("createMirrorBackup:")
        ),
        false
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("commit:")),
        false
    );
    assert.equal(
        fake.operations.some(
            (operation) => operation.startsWith("push")
        ),
        false
    );
    assert.equal(fake.operations.includes("log:Nothing published."), true);
    assert.equal(
        fake.operations.at(-1),
        `cleanup:${OPENAI_REPOSITORY}`
    );
});

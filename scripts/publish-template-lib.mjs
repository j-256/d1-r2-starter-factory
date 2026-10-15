import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
    availableBackupPath,
    listRetainedMirrorBackups,
    moveMirrorBackupsToTrash,
    TEMPLATE_BACKUP_COMMANDS,
    templateBackupRoot,
} from "./template-backups-lib.mjs";
import { FACTORY_DEPENDABOT_CONFIG_PATH } from "./generate-lib.mjs";
import { TEMPLATE_VARIANTS } from "./template-variants.mjs";

export { TEMPLATE_VARIANTS };

const DEFAULT_BRANCH = "main";
const DEPENDABOT_SECURITY_UPDATES_ENDPOINT = "automated-security-fixes";
const FACTORY_REMOTE = "origin";
const FACTORY_REVISION_VARIABLES = Object.freeze({
    openai: "TEMPLATE_OPENAI_FACTORY_REVISION",
    wrangler: "TEMPLATE_WRANGLER_FACTORY_REVISION",
});
const REPOSITORY_VARIABLE_METHODS = Object.freeze({
    create: "POST",
    update: "PATCH",
});
const ALL_VARIANTS = "all";
const AFFIRMATIVE_RESPONSES = new Set(["y", "yes"]);
const BOTH_VARIANTS_ALIAS = "both";
const TEMPLATE_TARGET_REQUIRED_MESSAGE =
    "A template target is required. Pass all for both templates, or choose openai or wrangler.";
const HISTORY_MODES = Object.freeze({
    append: "append",
    fresh: "fresh",
});
const DEFAULT_PUBLISH_ARGUMENTS = Object.freeze([
    ALL_VARIANTS,
    "--history",
    HISTORY_MODES.append,
    "--replay",
]);
const DEFAULT_PUBLISH_COMMAND =
    `npm run template:publish -- ${DEFAULT_PUBLISH_ARGUMENTS.join(" ")}`;
const DEFAULT_PUBLISH_NOTICE =
    `No publish arguments supplied. Running: ${DEFAULT_PUBLISH_COMMAND}`;
const INITIAL_COMMIT_MESSAGE = "Initial commit";
const NOT_FOUND_STATUS = 404;
const PUBLISH_TEMP_PREFIX = "d1-r2-template-publish-";
const REPLAY_TEMP_PREFIX = "d1-r2-template-replay-";
const PUBLICATION_ACTIONS = Object.freeze({
    create: "create",
    replace: "replace",
    update: "update",
});
const PUBLICATION_STATUSES = Object.freeze({
    cancelled: "cancelled",
    created: "created",
    replaced: "replaced",
    unchanged: "unchanged",
    updated: "updated",
});
const TEMPLATE_REMOTE = "origin";
const PUBLISHED_STATUSES = new Set([
    PUBLICATION_STATUSES.created,
    PUBLICATION_STATUSES.replaced,
    PUBLICATION_STATUSES.updated,
]);

export function isAffirmativeResponse(response) {
    return AFFIRMATIVE_RESPONSES.has(response.trim().toLowerCase());
}

export function publicationConfirmationQuestion({
    action,
    commitCount,
    history,
    repository,
}) {
    if (commitCount !== undefined) {
        const commits = `${commitCount} ${commitCount === 1 ? "commit" : "commits"}`;
        if (history === HISTORY_MODES.fresh) {
            return `Replace main in ${repository} with a fresh history of ${commits} and force-push? [y/N] `;
        }
        if (action === PUBLICATION_ACTIONS.create) {
            return `Create and publish ${repository} with ${commits}? [y/N] `;
        }
        return `Append and publish ${commits} to ${repository}? [y/N] `;
    }
    if (history === HISTORY_MODES.fresh) {
        return `Replace main in ${repository} with a fresh root commit and force-push? [y/N] `;
    }
    if (action === PUBLICATION_ACTIONS.create) {
        return `Create and publish ${repository}? [y/N] `;
    }
    return `Append and publish a commit to ${repository}? [y/N] `;
}

export function historyModeChoices({ replay = false } = {}) {
    if (replay) {
        return [
            "  1. append (recommended): preserve main, then add relevant factory checkpoints",
            "  2. fresh: replace main with a baseline root plus relevant checkpoints",
        ];
    }
    return [
        "  1. append (recommended): preserve main, then add one update commit",
        "  2. fresh: replace main with one new root commit",
    ];
}

function commandFailure(command, args, result) {
    const details = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
    const suffix = details ? `\n${details}` : "";
    return new Error(
        `Command failed (${result.status ?? "unknown"}): ${command} ${args.join(" ")}${suffix}`
    );
}

function runCommand(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        input: options.input,
        stdio: options.inherit
            ? "inherit"
            : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
        throw commandFailure(command, args, result);
    }
    return result;
}

function captured(command, args, options = {}) {
    const result = runCommand(command, args, options);
    return result.stdout ?? "";
}

function inherited(command, args, cwd) {
    runCommand(command, args, { cwd, inherit: true });
}

function repositoryUrl(repository) {
    return `https://github.com/${repository}.git`;
}

export function factoryRevisionVariable(variant) {
    const variable = FACTORY_REVISION_VARIABLES[variant];
    if (!variable) throw new Error(`Unknown template variant: ${variant}`);
    return variable;
}

function repositoryVariableEndpoint(repository, variable) {
    return `repos/${repository}/actions/variables/${variable}`;
}

function dependabotSecurityUpdatesEndpoint(repository) {
    return `repos/${repository}/${DEPENDABOT_SECURITY_UPDATES_ENDPOINT}`;
}

export function repositoryVariableWriteArguments({
    repository,
    revision,
    variable,
    variableExists,
}) {
    const method = variableExists
        ? REPOSITORY_VARIABLE_METHODS.update
        : REPOSITORY_VARIABLE_METHODS.create;
    const endpoint = variableExists
        ? repositoryVariableEndpoint(repository, variable)
        : `repos/${repository}/actions/variables`;
    return [
        "api",
        "--method",
        method,
        endpoint,
        "--raw-field",
        `name=${variable}`,
        "--raw-field",
        `value=${revision}`,
    ];
}

function readRepositoryVariable(repoRoot, repository, variableName) {
    const args = [
        "api",
        repositoryVariableEndpoint(repository, variableName),
    ];
    const result = runCommand("gh", args, {
        allowFailure: true,
        cwd: repoRoot,
    });
    if (result.status === 0) {
        let record;
        try {
            record = JSON.parse(result.stdout ?? "");
        } catch {
            throw new Error(
                `${repository}: GitHub returned invalid repository variable ${variableName}.`
            );
        }
        if (typeof record.value !== "string") {
            throw new Error(
                `${repository}: repository variable ${variableName} has no string value.`
            );
        }
        return record.value;
    }

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (parseHttpStatus(output) === NOT_FOUND_STATUS) return undefined;
    throw commandFailure("gh", args, result);
}

export function parseHttpStatus(output) {
    const headerMatch = output.match(/^HTTP\/\S+\s+(\d{3})\b/m);
    if (headerMatch?.[1]) return Number.parseInt(headerMatch[1], 10);

    const errorMatch = output.match(/\(HTTP (\d{3})\)/);
    return errorMatch?.[1] ? Number.parseInt(errorMatch[1], 10) : null;
}

export function dependabotSecurityUpdatesEnabled(result) {
    if (result.status !== 0) {
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        return parseHttpStatus(output) === NOT_FOUND_STATUS
            ? false
            : undefined;
    }

    let response;
    try {
        response = JSON.parse(result.stdout ?? "");
    } catch {
        throw new Error(
            "GitHub returned invalid Dependabot security updates JSON."
        );
    }
    if (typeof response.enabled !== "boolean") {
        throw new Error(
            "GitHub returned no Dependabot security updates state."
        );
    }
    return response.enabled;
}

function assertDependabotSecurityUpdatesDisabled(repoRoot, repository) {
    const args = ["api", dependabotSecurityUpdatesEndpoint(repository)];
    const result = runCommand("gh", args, {
        allowFailure: true,
        cwd: repoRoot,
    });
    let enabled;
    try {
        enabled = dependabotSecurityUpdatesEnabled(result);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${repository}: ${message}`);
    }
    if (enabled === undefined) throw commandFailure("gh", args, result);
    if (!enabled) return;

    throw new Error([
        `${repository}: Dependabot security updates must be disabled for generated templates.`,
        `Disable them with: gh api --method DELETE repos/${repository}/${DEPENDABOT_SECURITY_UPDATES_ENDPOINT}`,
    ].join("\n"));
}

export function resolvePublishInvocation(args) {
    if (args.length > 0) {
        return { args: [...args], notice: undefined };
    }
    return {
        args: [...DEFAULT_PUBLISH_ARGUMENTS],
        notice: DEFAULT_PUBLISH_NOTICE,
    };
}

export function parsePublishArguments(args) {
    let clobber = false;
    let help = false;
    let history;
    let message;
    let replay = false;
    let replayFrom;
    let variant;
    let yes = false;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--help" || argument === "-h") {
            help = true;
            continue;
        }
        if (argument === "--yes" || argument === "-y") {
            yes = true;
            continue;
        }
        if (argument === "--clobber") {
            clobber = true;
            continue;
        }
        if (argument === "--replay" || argument === "-r") {
            replay = true;
            continue;
        }
        if (argument === "--history") {
            const candidate = args[index + 1];
            if (!candidate || candidate.startsWith("-")) {
                throw new Error("--history requires append or fresh.");
            }
            history = candidate;
            index += 1;
            continue;
        }
        if (argument?.startsWith("--history=")) {
            history = argument.slice("--history=".length);
            continue;
        }
        if (argument === "--message" || argument === "-m") {
            const candidate = args[index + 1];
            if (!candidate || candidate.startsWith("-")) {
                throw new Error("--message requires a value.");
            }
            message = candidate;
            index += 1;
            continue;
        }
        if (argument === "--replay-from") {
            const candidate = args[index + 1];
            if (!candidate || candidate.startsWith("-")) {
                throw new Error("--replay-from requires a factory revision.");
            }
            replayFrom = candidate;
            index += 1;
            continue;
        }
        if (argument?.startsWith("--replay-from=")) {
            replayFrom = argument.slice("--replay-from=".length);
            continue;
        }
        if (argument?.startsWith("--message=")) {
            message = argument.slice("--message=".length);
            continue;
        }
        if (argument?.startsWith("-")) {
            throw new Error(`Unknown option: ${argument}`);
        }
        if (variant) throw new Error(`Unexpected argument: ${argument}`);
        variant = argument;
    }

    if (help) return { help: true, yes };
    if (variant === BOTH_VARIANTS_ALIAS) variant = ALL_VARIANTS;
    if (
        variant !== undefined
        && variant !== ALL_VARIANTS
        && !(variant in TEMPLATE_VARIANTS)
    ) {
        throw new Error(
            `Unknown template variant: ${variant}. Choose all, openai, or wrangler.`
        );
    }
    if (history !== undefined && !Object.hasOwn(HISTORY_MODES, history)) {
        throw new Error(
            `Unknown history mode: ${history || "empty"}. Choose append or fresh.`
        );
    }
    if (message !== undefined && !message.trim()) {
        throw new Error("--message cannot be empty.");
    }
    if (replayFrom !== undefined && !replayFrom.trim()) {
        throw new Error("--replay-from cannot be empty.");
    }
    if (replay && replayFrom !== undefined) {
        throw new Error(
            "--replay cannot be combined with --replay-from; use the recorded revision or override it explicitly."
        );
    }
    if ((replay || replayFrom !== undefined) && message !== undefined) {
        throw new Error(
            "--message cannot be combined with replay because replay preserves factory commit messages."
        );
    }
    if (clobber && history === HISTORY_MODES.append) {
        throw new Error("--clobber cannot be combined with --history append.");
    }
    if (variant === undefined) {
        throw new Error(TEMPLATE_TARGET_REQUIRED_MESSAGE);
    }
    if (clobber) history = HISTORY_MODES.fresh;

    return {
        clobber,
        help: false,
        history,
        message: message?.trim(),
        replay,
        replayFrom: replayFrom?.trim(),
        variant,
        yes,
    };
}

export function publishUsage() {
    return [
        "Usage:",
        "  npm run template:publish",
        "  npm run template:publish -- <all|openai|wrangler> [--history append|fresh] [--clobber] [--message <message>] [--replay] [--replay-from <revision>] [--yes]",
        "",
        "Default:",
        `  ${DEFAULT_PUBLISH_COMMAND}`,
        "  A bare invocation prints this expanded command to stderr before running it.",
        "",
        "Options:",
        "  all                  Process both templates explicitly; both is an alias",
        "  openai|wrangler      Limit publication to one template",
        "  --history <mode>     Append to main or replace it with fresh history",
        "  --clobber            Replace history and Trash selected recovery mirrors",
        "  -m, --message <message>  Set the normal publication message; root commits default to Initial commit",
        "  -r, --replay         Replay checkpoints after each template's factory-owned cursor",
        "  --replay-from <rev>  Bootstrap or recover cursors from an explicit factory revision",
        "  -y, --yes            Authorize without prompts; existing repos need history or clobber",
        "  -h, --help           Show this help",
        "",
        "Environment:",
        "  TEMPLATE_PUBLISH_BACKUP_DIR  Override the persistent fresh-mode mirror directory",
    ].join("\n");
}

export function resolveCommitMessage({
    history,
    repositoryExists,
    requestedMessage,
}) {
    if (requestedMessage) return requestedMessage;
    if (!repositoryExists || history === HISTORY_MODES.fresh) {
        return INITIAL_COMMIT_MESSAGE;
    }
    throw new Error(
        "--message is required when updating an existing template repository."
    );
}

export function syncGeneratedTree(sourceRoot, targetRoot) {
    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
        throw new Error(`Generated template directory is missing: ${sourceRoot}`);
    }
    if (!existsSync(join(targetRoot, ".git"))) {
        throw new Error(`Temporary checkout has no .git directory: ${targetRoot}`);
    }
    if (existsSync(join(sourceRoot, ".git"))) {
        throw new Error(`Generated template must not contain .git: ${sourceRoot}`);
    }

    for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        rmSync(join(targetRoot, entry.name), { force: true, recursive: true });
    }

    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
        cpSync(join(sourceRoot, entry.name), join(targetRoot, entry.name), {
            force: true,
            preserveTimestamps: true,
            recursive: true,
        });
    }
}

function nullSeparatedPaths(output) {
    return output.split("\0").filter(Boolean);
}

export function mergeChangedPaths(trackedOutput, untrackedOutput) {
    return [...new Set([
        ...nullSeparatedPaths(trackedOutput),
        ...nullSeparatedPaths(untrackedOutput),
    ])].sort();
}

function selectedVariants(variant) {
    if (!variant) throw new Error(TEMPLATE_TARGET_REQUIRED_MESSAGE);
    return variant === ALL_VARIANTS
        ? Object.keys(TEMPLATE_VARIANTS)
        : [variant];
}

function replayRequested(options) {
    return options.replay || options.replayFrom !== undefined;
}

function logPhase(dependencies, title, leadingBlank = true) {
    if (leadingBlank) dependencies.log("");
    dependencies.log(`== ${title} ==`);
}

async function logRetainedBackups(options, dependencies) {
    const records = [];
    for (const [variant, config] of Object.entries(TEMPLATE_VARIANTS)) {
        const paths = await dependencies.listRetainedBackups(
            config.repository
        );
        records.push(...paths.map((path) => ({ path, variant })));
    }
    if (records.length === 0) return records;

    logPhase(dependencies, "Retained recovery mirrors", false);
    for (const record of records) {
        dependencies.log(`  ${record.variant}: ${record.path}`);
    }
    dependencies.log("");
    if (options.clobber) {
        dependencies.log(
            "Clobber mode will move mirrors for selected targets to Trash after factory verification."
        );
    } else {
        dependencies.log(
            `Review or clean them with ${TEMPLATE_BACKUP_COMMANDS.list}.`
        );
    }
    return records;
}

function assertExplicitFreshBackupsAvailable(
    options,
    variants,
    retainedBackups
) {
    if (
        options.history !== HISTORY_MODES.fresh
        || options.clobber
    ) {
        return;
    }
    const selected = new Set(variants);
    const conflicts = retainedBackups.filter(({ variant }) =>
        selected.has(variant)
    );
    if (conflicts.length === 0) return;

    throw new Error([
        "Fresh publication cannot start while selected templates have retained recovery mirrors:",
        ...conflicts.map(({ path, variant }) => `  ${variant}: ${path}`),
        `Review them with ${TEMPLATE_BACKUP_COMMANDS.list}. Fresh publication stopped to avoid accumulating unresolved mirrors.`,
    ].join("\n"));
}

async function trashRetainedBackupsForClobber(
    options,
    variants,
    retainedBackups,
    dependencies
) {
    if (!options.clobber) return;
    const selected = new Set(variants);
    const paths = retainedBackups
        .filter(({ variant }) => selected.has(variant))
        .map(({ path }) => path);
    if (paths.length === 0) return;

    try {
        await dependencies.moveBackupsToTrash(paths);
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : String(error);
        throw new Error([
            "Clobber mode could not move selected retained recovery mirrors to Trash.",
            `Trash error: ${message}`,
        ].join("\n"));
    }
    dependencies.log(
        "Clobber mode moved selected retained recovery mirrors to Trash."
    );
}

function logSummary(dependencies, results) {
    logPhase(dependencies, "Summary");
    const labelWidth = Math.max(
        ...results.map(({ variant }) => variant.length)
    ) + 2;
    for (const result of results) {
        const backup = result.backup
            ? ` (backup: ${result.backup})`
            : result.backupTrashed
                ? " (backup moved to Trash)"
                : "";
        const commits = result.commitCount === undefined
            ? ""
            : ` (${result.commitCount} ${result.commitCount === 1 ? "commit" : "commits"})`;
        dependencies.log(
            `${result.variant.padEnd(labelWidth)}${result.status}${commits}${backup}`
        );
    }
    if (results.some(({ backup }) => backup)) {
        dependencies.log("");
        dependencies.log(
            `After inspecting the replacement, clean up with ${TEMPLATE_BACKUP_COMMANDS.trash}.`
        );
    }
    dependencies.log("");
    const published = results.some(
        ({ status }) => PUBLISHED_STATUSES.has(status)
    );
    dependencies.log(published ? "Publication complete." : "Nothing published.");
}

async function commitMessageFor(plan, history, options, dependencies) {
    if (
        options.message
        || !plan.exists
        || history === HISTORY_MODES.fresh
    ) {
        return resolveCommitMessage({
            history,
            repositoryExists: plan.exists,
            requestedMessage: options.message,
        });
    }
    if (options.yes) {
        throw new Error(
            `--message is required with --yes when updating ${plan.config.repository}.`
        );
    }
    const message = await dependencies.requestCommitMessage({
        repository: plan.config.repository,
    });
    if (!message.trim()) throw new Error("Commit message cannot be empty.");
    return message.trim();
}

async function historyModeFor(plan, options, dependencies) {
    if (!plan.exists) return undefined;
    if (options.history) return options.history;
    if (options.yes) {
        throw new Error(
            `--history is required with --yes when publishing ${plan.config.repository}.`
        );
    }
    const history = await dependencies.requestHistoryMode({
        replay: plan.replay !== undefined,
        repository: plan.config.repository,
    });
    if (!Object.hasOwn(HISTORY_MODES, history)) {
        throw new Error(
            `Invalid history mode for ${plan.config.repository}: ${history}`
        );
    }
    return history;
}

async function assertFreshBackupAvailable(plan, history, dependencies) {
    if (history !== HISTORY_MODES.fresh) return;
    const retained = await dependencies.listRetainedBackups(
        plan.config.repository
    );
    if (retained.length === 0) return;

    throw new Error([
        `${plan.config.repository} already has a retained recovery mirror:`,
        ...retained.map((path) => `  ${path}`),
        `Review it with ${TEMPLATE_BACKUP_COMMANDS.list}. Fresh publication stopped to avoid accumulating unresolved mirrors.`,
    ].join("\n"));
}

function publicationAction(plan, history) {
    if (!plan.exists) return PUBLICATION_ACTIONS.create;
    return history === HISTORY_MODES.fresh
        ? PUBLICATION_ACTIONS.replace
        : PUBLICATION_ACTIONS.update;
}

function publicationStatus(plan, history) {
    if (!plan.exists) return PUBLICATION_STATUSES.created;
    return history === HISTORY_MODES.fresh
        ? PUBLICATION_STATUSES.replaced
        : PUBLICATION_STATUSES.updated;
}

function commitSubject(message) {
    return message.split("\n", 1)[0]?.trim() || "Untitled checkpoint";
}

function logCommitMessage(dependencies, label, message) {
    dependencies.log(`${label}:`);
    for (const line of message.split("\n")) {
        dependencies.log(`  ${line}`);
    }
}

async function stageReplaySnapshot(plan, snapshot, dependencies) {
    await dependencies.syncReplayTree({
        checkout: plan.workspace.checkout,
        outputDirectory: plan.config.outputDirectory,
        snapshot,
    });
    const changedPaths = await dependencies.collectChangedPaths(
        plan.workspace.checkout
    );
    if (changedPaths.length > 0) {
        await dependencies.stagePaths(
            plan.workspace.checkout,
            changedPaths
        );
    }
    return changedPaths;
}

async function materializeReplayCommits(
    plan,
    replay,
    history,
    dependencies
) {
    const checkout = plan.workspace.checkout;
    let commit = plan.workspace.remoteCommit;
    let commitCount = 0;
    const baselinePaths = await stageReplaySnapshot(
        plan,
        replay.base,
        dependencies
    );

    if (plan.exists && history !== HISTORY_MODES.fresh) {
        if (baselinePaths.length > 0) {
            throw new Error([
                `${plan.config.repository}: append replay baseline does not match remote main.`,
                "Choose the factory revision that generated the published tree, or use fresh history to replace it.",
                `Mismatched paths: ${baselinePaths.join(", ")}`,
            ].join("\n"));
        }
        dependencies.log(
            `${plan.variant}: replay baseline matches remote main`
        );
    } else {
        logCommitMessage(
            dependencies,
            "Baseline commit message",
            INITIAL_COMMIT_MESSAGE
        );
        await dependencies.showStagedDiff(checkout);
        commit = await dependencies.createCommit({
            changedPaths: baselinePaths,
            checkout,
            expectedCommit: plan.workspace.remoteCommit,
            history: plan.exists ? HISTORY_MODES.fresh : undefined,
            message: INITIAL_COMMIT_MESSAGE,
        });
        await dependencies.showCreatedCommit(checkout, commit);
        commitCount += 1;
    }

    for (const checkpoint of replay.checkpoints) {
        const changedPaths = await stageReplaySnapshot(
            plan,
            checkpoint,
            dependencies
        );
        if (changedPaths.length === 0) {
            dependencies.log(
                `Skip checkpoint for ${plan.variant}: ${commitSubject(checkpoint.message)}`
            );
            continue;
        }
        logCommitMessage(
            dependencies,
            "Checkpoint commit message",
            checkpoint.message
        );
        await dependencies.showStagedDiff(checkout);
        commit = await dependencies.createCommit({
            changedPaths,
            checkout,
            history: HISTORY_MODES.append,
            message: checkpoint.message,
        });
        commitCount += 1;
    }

    await dependencies.syncGeneratedTree(
        plan.config.outputDirectory,
        checkout
    );
    const finalPaths = await dependencies.collectChangedPaths(checkout);
    if (finalPaths.length > 0) {
        throw new Error([
            `${plan.config.repository}: replay did not reproduce the generated HEAD tree.`,
            `Mismatched paths: ${finalPaths.join(", ")}`,
        ].join("\n"));
    }
    if (!commit) {
        throw new Error(
            `${plan.config.repository}: replay did not produce a publishable commit.`
        );
    }
    dependencies.log(
        `${plan.variant}: replay prepared ${commitCount} ${commitCount === 1 ? "commit" : "commits"}`
    );
    return { commit, commitCount };
}

async function recordVerifiedFactoryRevision(
    plan,
    factoryRevision,
    dependencies
) {
    try {
        await dependencies.recordFactoryRevision({
            revision: factoryRevision,
            variant: plan.variant,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error([
            `${plan.config.repository}: verified factory revision was not recorded in factory state ${factoryRevisionVariable(plan.variant)}.`,
            message,
        ].join("\n"));
    }
    dependencies.log(`${plan.variant}: factory publication state recorded`);
}

function resolveReplayHistory(repoRoot, from) {
    const resolved = runCommand(
        "git",
        ["rev-parse", "--verify", `${from}^{commit}`],
        { allowFailure: true, cwd: repoRoot }
    );
    if (resolved.status !== 0) {
        throw new Error(`Unknown replay baseline revision: ${from}`);
    }
    const baseRevision = resolved.stdout.trim();
    const firstParentHistory = captured(
        "git",
        ["rev-list", "--first-parent", "HEAD"],
        { cwd: repoRoot }
    ).trim().split("\n").filter(Boolean);
    const baselineIndex = firstParentHistory.indexOf(baseRevision);
    if (baselineIndex === -1) {
        throw new Error(
            "The replay baseline must be on HEAD's uninterrupted first-parent history."
        );
    }
    const revisions = firstParentHistory.slice(0, baselineIndex).reverse();
    return { baseRevision, revisions };
}

export async function publishTemplates(options, dependencies) {
    const variants = selectedVariants(options.variant);
    const wantsReplay = replayRequested(options);
    if (options.clobber && options.history !== HISTORY_MODES.fresh) {
        throw new Error("Clobber publication requires fresh history.");
    }
    const replays = new Map();
    const replayStateByVariant = new Map();
    const workspaces = [];

    const retainedBackups = await logRetainedBackups(options, dependencies);
    assertExplicitFreshBackupsAvailable(
        options,
        variants,
        retainedBackups
    );
    logPhase(dependencies, "Verify factory", retainedBackups.length > 0);
    const factoryRevision = await dependencies.assertFactoryReady();
    dependencies.log("Factory main matches origin/main.");
    if (options.replay) {
        logPhase(dependencies, "Read replay cursors");
        for (const variant of variants) {
            const config = TEMPLATE_VARIANTS[variant];
            const exists = await dependencies.repositoryExists(
                config.repository
            );
            if (!exists) {
                throw new Error(
                    `${config.repository} does not exist, so recorded replay has no published baseline. Bootstrap replay with --replay-from <revision>.`
                );
            }
            const replayFrom = (
                await dependencies.readFactoryRevision(variant)
            )?.trim();
            if (!replayFrom) {
                throw new Error(
                    `Factory publication state has no revision for ${config.repository}. Bootstrap replay with --replay-from <revision>.`
                );
            }
            replayStateByVariant.set(variant, { exists, replayFrom });
            dependencies.log(`${variant}: factory replay cursor found`);
        }
    }
    if (wantsReplay) {
        logPhase(dependencies, "Verify replay baselines");
        const baselines = options.replay
            ? [...replayStateByVariant.values()].map(
                ({ replayFrom }) => replayFrom
            )
            : [options.replayFrom];
        for (const from of new Set(baselines)) {
            await dependencies.assertReplayBaseline({ from });
        }
        dependencies.log("Replay baselines are on factory first-parent history.");
    }
    await trashRetainedBackupsForClobber(
        options,
        variants,
        retainedBackups,
        dependencies
    );

    logPhase(dependencies, "Test and generate");
    await dependencies.generate();
    dependencies.log("Factory checks and template generation passed.");

    const plans = [];
    try {
        logPhase(dependencies, "Compare templates");
        for (const variant of variants) {
            const config = TEMPLATE_VARIANTS[variant];
            const replayState = replayStateByVariant.get(variant);
            const exists = replayState?.exists
                ?? await dependencies.repositoryExists(config.repository);
            const replayFrom = replayState?.replayFrom ?? options.replayFrom;
            const workspace = await dependencies.prepareCheckout({
                config,
                exists,
            });
            if (exists && !workspace.remoteCommit) {
                throw new Error(
                    `${config.repository}: temporary checkout did not capture remote main.`
                );
            }
            workspaces.push(workspace);
            await dependencies.syncGeneratedTree(
                config.outputDirectory,
                workspace.checkout
            );
            await dependencies.assertTemplatePolicy({
                checkout: workspace.checkout,
                repository: config.repository,
                verifyRemote: exists,
            });
            const changedPaths = await dependencies.collectChangedPaths(
                workspace.checkout
            );
            if (changedPaths.length === 0 && !exists) {
                throw new Error(
                    `${config.repository}: generated template contains no publishable files.`
                );
            }

            const explicitFresh = exists
                && options.history === HISTORY_MODES.fresh;
            const requiresPublication = wantsReplay
                || changedPaths.length > 0
                || explicitFresh;
            const plan = {
                changedPaths,
                config,
                exists,
                replayFrom,
                requiresPublication,
                variant,
                workspace,
            };
            plans.push(plan);
            if (!requiresPublication) {
                dependencies.log(`${variant}: unchanged`);
            } else if (wantsReplay) {
                dependencies.log(`${variant}: checkpoint replay ready`);
            } else if (changedPaths.length === 0) {
                dependencies.log(`${variant}: fresh history ready`);
            } else if (exists) {
                dependencies.log(`${variant}: existing repository changed`);
            } else {
                dependencies.log(`${variant}: create ready`);
            }
        }

        if (wantsReplay) {
            logPhase(dependencies, "Prepare checkpoint replay");
            for (const plan of plans) {
                let replay = replays.get(plan.replayFrom);
                if (!replay) {
                    replay = await dependencies.prepareReplay({
                        from: plan.replayFrom,
                    });
                    replays.set(plan.replayFrom, replay);
                    dependencies.log(
                        `Prepared a generated baseline and ${replay.checkpoints.length} factory checkpoints.`
                    );
                }
                plan.replay = replay;
            }
        }

        const publishPlans = plans.filter(
            ({ requiresPublication }) => requiresPublication
        );

        // Prepare every replay before writing any template or factory cursor
        for (const plan of publishPlans) {
            if (!plan.replay) continue;
            plan.history = await historyModeFor(plan, options, dependencies);
            await assertFreshBackupAvailable(plan, plan.history, dependencies);
            plan.preparedReplay = await materializeReplayCommits(
                plan,
                plan.replay,
                plan.history,
                dependencies
            );
        }

        const results = [];
        for (const plan of plans.filter(
            ({ requiresPublication }) => !requiresPublication
        )) {
            dependencies.log(`${plan.variant}: downstream policy verified`);
            await recordVerifiedFactoryRevision(
                plan,
                factoryRevision,
                dependencies
            );
            results.push({
                action: PUBLICATION_ACTIONS.update,
                repository: plan.config.repository,
                status: PUBLICATION_STATUSES.unchanged,
                variant: plan.variant,
            });
        }

        if (publishPlans.length > 0) {
            logPhase(dependencies, "Publish templates");
        }
        for (const plan of publishPlans) {
            dependencies.log("");
            dependencies.log(
                `${plan.variant}: publish ${plan.config.repository}`
            );
            const replay = plan.replay;
            if (!replay) {
                if (plan.changedPaths.length > 0) {
                    await dependencies.stagePaths(
                        plan.workspace.checkout,
                        plan.changedPaths
                    );
                }
                await dependencies.showStagedDiff(plan.workspace.checkout);
                if (plan.changedPaths.length === 0) {
                    dependencies.log(
                        "Generated files are unchanged; fresh mode will replace history with the same tree."
                    );
                }
            }
            const history = plan.history ?? await historyModeFor(
                plan,
                options,
                dependencies
            );
            const action = publicationAction(plan, history);
            if (history) dependencies.log(`History mode: ${history}`);
            if (!replay) {
                await assertFreshBackupAvailable(plan, history, dependencies);
            }
            let commit;
            let commitCount;
            let commitMessage;
            if (replay) {
                ({ commit, commitCount } = plan.preparedReplay);
                if (commitCount === 0) {
                    dependencies.log(
                        `${plan.variant}: downstream policy verified`
                    );
                    await recordVerifiedFactoryRevision(
                        plan,
                        factoryRevision,
                        dependencies
                    );
                    dependencies.log(`${plan.variant}: unchanged`);
                    results.push({
                        action,
                        repository: plan.config.repository,
                        status: PUBLICATION_STATUSES.unchanged,
                        variant: plan.variant,
                    });
                    continue;
                }
            } else {
                commitMessage = await commitMessageFor(
                    plan,
                    history,
                    options,
                    dependencies
                );
            }
            const confirmed = options.yes || await dependencies.confirm({
                action,
                commitCount,
                history,
                repository: plan.config.repository,
            });
            if (!confirmed) {
                dependencies.log(`${plan.variant}: cancelled`);
                results.push({
                    action,
                    repository: plan.config.repository,
                    status: PUBLICATION_STATUSES.cancelled,
                    variant: plan.variant,
                });
                continue;
            }

            let backup;
            if (history === HISTORY_MODES.fresh) {
                backup = await dependencies.createMirrorBackup({
                    expectedCommit: plan.workspace.remoteCommit,
                    repository: plan.config.repository,
                });
                dependencies.log(`Mirror backup created at ${backup}`);
            }
            if (!replay) {
                commit = await dependencies.createCommit({
                    changedPaths: plan.changedPaths,
                    checkout: plan.workspace.checkout,
                    expectedCommit: plan.workspace.remoteCommit,
                    history,
                    message: commitMessage,
                });
            }
            if (plan.exists) {
                if (history === HISTORY_MODES.fresh) {
                    await dependencies.pushFresh({
                        checkout: plan.workspace.checkout,
                        commit,
                        expectedCommit: plan.workspace.remoteCommit,
                    });
                } else {
                    await dependencies.pushUpdate(plan.workspace.checkout);
                }
            } else {
                await dependencies.createRepository(
                    plan.workspace.checkout,
                    plan.config.repository
                );
            }
            await dependencies.ensureTemplate(plan.config.repository);
            await dependencies.verifyPublished({
                commit,
                repository: plan.config.repository,
            });
            await dependencies.assertTemplatePolicy({
                checkout: plan.workspace.checkout,
                repository: plan.config.repository,
                verifyRemote: true,
            });
            dependencies.log(`${plan.variant}: downstream policy verified`);
            await recordVerifiedFactoryRevision(
                plan,
                factoryRevision,
                dependencies
            );

            const status = publicationStatus(plan, history);
            dependencies.log(`${plan.variant}: ${status} ${commit}`);
            let backupTrashed = false;
            if (backup && (options.clobber || !options.yes)) {
                dependencies.log(
                    `Verified replacement: https://github.com/${plan.config.repository}/commit/${commit}`
                );
                const cleanupRequested = options.clobber
                    || await dependencies.confirmBackupCleanup({
                        repository: plan.config.repository,
                    });
                if (cleanupRequested) {
                    try {
                        await dependencies.moveBackupsToTrash([backup]);
                        dependencies.log("Mirror backup moved to Trash.");
                        backup = undefined;
                        backupTrashed = true;
                    } catch (error) {
                        const message = error instanceof Error
                            ? error.message
                            : String(error);
                        if (options.clobber) {
                            throw new Error([
                                `${plan.config.repository} was published and verified, but clobber cleanup failed.`,
                                `Recovery mirror retained at ${backup}`,
                                `Trash error: ${message}`,
                            ].join("\n"));
                        }
                        dependencies.log(
                            `Could not move the mirror to Trash: ${message}`
                        );
                    }
                }
            }
            if (backup) {
                dependencies.log(`Mirror backup retained at ${backup}`);
            }
            results.push({
                action,
                backup,
                backupTrashed,
                commit,
                commitCount,
                repository: plan.config.repository,
                status,
                variant: plan.variant,
            });
        }

        results.sort(
            (left, right) =>
                variants.indexOf(left.variant) - variants.indexOf(right.variant)
        );
        logSummary(dependencies, results);
        return results;
    } finally {
        await Promise.all(
            workspaces.map((workspace) => dependencies.cleanup(workspace))
        );
        await Promise.all(
            [...new Set(replays.values())].map((replay) =>
                dependencies.cleanupReplay(replay)
            )
        );
    }
}

export function createSystemDependencies(repoRoot) {
    let factoryRepository;
    const resolveFactoryRepository = () => {
        if (factoryRepository) return factoryRepository;
        factoryRepository = captured(
            "gh",
            ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
            { cwd: repoRoot }
        ).trim();
        if (!factoryRepository) {
            throw new Error("Could not resolve the factory GitHub repository.");
        }
        return factoryRepository;
    };

    return {
        async assertFactoryReady() {
            const status = captured(
                "git",
                ["status", "--porcelain=v1", "--untracked-files=all"],
                { cwd: repoRoot }
            );
            if (status) {
                throw new Error(
                    "The factory worktree must be clean before publishing a template."
                );
            }

            const branch = captured(
                "git",
                ["symbolic-ref", "--quiet", "--short", "HEAD"],
                { cwd: repoRoot }
            ).trim();
            if (branch !== DEFAULT_BRANCH) {
                throw new Error(
                    `Publish templates from ${DEFAULT_BRANCH}, not ${branch || "detached HEAD"}.`
                );
            }

            runCommand(
                "git",
                ["fetch", "--quiet", FACTORY_REMOTE, DEFAULT_BRANCH],
                { cwd: repoRoot }
            );
            const head = captured("git", ["rev-parse", "HEAD"], {
                cwd: repoRoot,
            }).trim();
            const upstream = captured(
                "git",
                ["rev-parse", `refs/remotes/${FACTORY_REMOTE}/${DEFAULT_BRANCH}`],
                { cwd: repoRoot }
            ).trim();
            if (head !== upstream) {
                throw new Error(
                    `Factory HEAD must match ${FACTORY_REMOTE}/${DEFAULT_BRANCH}. Push the reviewed factory commit first.`
                );
            }
            return head;
        },

        async generate() {
            inherited("npm", ["run", "test:generate"], repoRoot);
            inherited("npm", ["run", "generate"], repoRoot);
        },

        async assertReplayBaseline({ from }) {
            resolveReplayHistory(repoRoot, from);
        },

        async prepareReplay({ from }) {
            const { baseRevision, revisions } = resolveReplayHistory(
                repoRoot,
                from
            );

            const tempRoot = mkdtempSync(join(tmpdir(), REPLAY_TEMP_PREFIX));
            const snapshot = (revision, name) => {
                const root = join(tempRoot, name);
                const archive = join(tempRoot, `${name}.tar`);
                mkdirSync(root);
                try {
                    runCommand(
                        "git",
                        [
                            "archive",
                            "--format=tar",
                            `--output=${archive}`,
                            revision,
                        ],
                        { cwd: repoRoot }
                    );
                    runCommand(
                        "tar",
                        ["-xf", archive, "-C", root],
                        { cwd: repoRoot }
                    );
                } finally {
                    rmSync(archive, { force: true });
                }
                inherited("npm", ["run", "generate"], root);
                return { revision, root };
            };

            try {
                const base = snapshot(baseRevision, "baseline");
                const checkpoints = revisions.map((revision, index) => {
                    const message = captured(
                        "git",
                        ["show", "-s", "--format=%B", revision],
                        { cwd: repoRoot }
                    ).trim();
                    if (!message) {
                        throw new Error(
                            "A factory checkpoint selected for replay has an empty commit message."
                        );
                    }
                    return {
                        ...snapshot(revision, `checkpoint-${index + 1}`),
                        message,
                    };
                });
                return { base, checkpoints, tempRoot };
            } catch (error) {
                rmSync(tempRoot, { force: true, recursive: true });
                throw error;
            }
        },

        async syncReplayTree({ checkout, outputDirectory, snapshot }) {
            syncGeneratedTree(
                join(snapshot.root, outputDirectory),
                checkout
            );
        },

        async cleanupReplay(replay) {
            rmSync(replay.tempRoot, { force: true, recursive: true });
        },

        async repositoryExists(repository) {
            const result = runCommand(
                "gh",
                ["api", "--include", `repos/${repository}`],
                { allowFailure: true, cwd: repoRoot }
            );
            if (result.status === 0) return true;

            const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
            if (parseHttpStatus(output) === NOT_FOUND_STATUS) return false;
            throw commandFailure(
                "gh",
                ["api", "--include", `repos/${repository}`],
                result
            );
        },

        async readFactoryRevision(variant) {
            return readRepositoryVariable(
                repoRoot,
                resolveFactoryRepository(),
                factoryRevisionVariable(variant)
            );
        },

        async recordFactoryRevision({ revision, variant }) {
            const repository = resolveFactoryRepository();
            const variable = factoryRevisionVariable(variant);
            const existing = readRepositoryVariable(
                repoRoot,
                repository,
                variable
            );
            if (existing === revision) return;

            runCommand(
                "gh",
                repositoryVariableWriteArguments({
                    repository,
                    revision,
                    variable,
                    variableExists: existing !== undefined,
                }),
                { cwd: repoRoot }
            );

            const recorded = readRepositoryVariable(
                repoRoot,
                repository,
                variable
            );
            if (recorded !== revision) {
                throw new Error(
                    `${repository}: GitHub publication state verification failed.`
                );
            }
        },

        async prepareCheckout({ config, exists }) {
            const tempRoot = mkdtempSync(join(tmpdir(), PUBLISH_TEMP_PREFIX));
            const checkout = join(tempRoot, "checkout");
            try {
                let remoteCommit;
                if (exists) {
                    runCommand(
                        "git",
                        [
                            "clone",
                            "--quiet",
                            "--branch",
                            DEFAULT_BRANCH,
                            "--single-branch",
                            repositoryUrl(config.repository),
                            checkout,
                        ],
                        { cwd: repoRoot }
                    );
                    remoteCommit = captured(
                        "git",
                        ["-C", checkout, "rev-parse", "HEAD"],
                        { cwd: repoRoot }
                    ).trim();
                } else {
                    mkdirSync(checkout);
                    runCommand(
                        "git",
                        ["init", "--quiet", "-b", DEFAULT_BRANCH, checkout],
                        { cwd: repoRoot }
                    );
                }
                return { checkout, remoteCommit, tempRoot };
            } catch (error) {
                rmSync(tempRoot, { force: true, recursive: true });
                throw error;
            }
        },

        async syncGeneratedTree(outputDirectory, checkout) {
            syncGeneratedTree(join(repoRoot, outputDirectory), checkout);
        },

        async assertTemplatePolicy({
            checkout,
            repository,
            verifyRemote,
        }) {
            const configPath = join(
                checkout,
                ...FACTORY_DEPENDABOT_CONFIG_PATH.split("/")
            );
            if (existsSync(configPath)) {
                throw new Error(
                    `${repository}: generated template contains factory-owned ${FACTORY_DEPENDABOT_CONFIG_PATH}.`
                );
            }
            if (verifyRemote) {
                assertDependabotSecurityUpdatesDisabled(
                    repoRoot,
                    repository
                );
            }
        },

        async collectChangedPaths(checkout) {
            const tracked = captured(
                "git",
                ["-C", checkout, "diff", "--name-only", "-z", "--"],
                { cwd: repoRoot }
            );
            const untracked = captured(
                "git",
                [
                    "-C",
                    checkout,
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                ],
                { cwd: repoRoot }
            );
            return mergeChangedPaths(tracked, untracked);
        },

        async stagePaths(checkout, changedPaths) {
            runCommand(
                "git",
                ["-C", checkout, "add", "--", ...changedPaths],
                { cwd: repoRoot }
            );
        },

        async showStagedDiff(checkout) {
            inherited(
                "git",
                ["-C", checkout, "diff", "--cached", "--check", "--"],
                repoRoot
            );
            inherited(
                "git",
                ["-C", checkout, "status", "--short"],
                repoRoot
            );
            inherited(
                "git",
                ["-C", checkout, "--no-pager", "diff", "--cached", "--binary", "--"],
                repoRoot
            );
        },

        async showCreatedCommit(checkout, commit) {
            inherited(
                "git",
                [
                    "-C",
                    checkout,
                    "diff-tree",
                    "--check",
                    "--root",
                    "-r",
                    commit,
                    "--",
                ],
                repoRoot
            );
            inherited(
                "git",
                [
                    "-C",
                    checkout,
                    "--no-pager",
                    "show",
                    "--root",
                    "--binary",
                    "--format=fuller",
                    commit,
                    "--",
                ],
                repoRoot
            );
        },

        async confirm({ action, commitCount, history, repository }) {
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                throw new Error(
                    "Interactive confirmation requires a terminal. Pass --yes for an intentional non-interactive publication."
                );
            }

            const readline = createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            try {
                const answer = await readline.question(
                    publicationConfirmationQuestion({
                        action,
                        commitCount,
                        history,
                        repository,
                    })
                );
                return isAffirmativeResponse(answer);
            } finally {
                readline.close();
            }
        },

        async requestHistoryMode({ replay, repository }) {
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                throw new Error(
                    `Choosing history for ${repository} requires a terminal. Pass --history for a non-interactive publication.`
                );
            }

            const readline = createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            try {
                console.log(`History mode for ${repository}:`);
                for (const choice of historyModeChoices({ replay })) {
                    console.log(choice);
                }
                while (true) {
                    const answer = (await readline.question(
                        "Choose 1 or 2: "
                    )).trim().toLowerCase();
                    if (answer === "1" || answer === HISTORY_MODES.append) {
                        return HISTORY_MODES.append;
                    }
                    if (answer === "2" || answer === HISTORY_MODES.fresh) {
                        return HISTORY_MODES.fresh;
                    }
                    console.log("Choose 1 for append or 2 for fresh.");
                }
            } finally {
                readline.close();
            }
        },

        async requestCommitMessage({ repository }) {
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                throw new Error(
                    `A commit message for ${repository} requires a terminal. Pass --message for a non-interactive publication.`
                );
            }

            const readline = createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            try {
                return await readline.question(
                    `Commit message for ${repository}: `
                );
            } finally {
                readline.close();
            }
        },

        async confirmBackupCleanup({ repository }) {
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                throw new Error(
                    `Choosing recovery-mirror cleanup for ${repository} requires a terminal.`
                );
            }
            const readline = createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            try {
                const answer = await readline.question(
                    `Move the recovery mirror for ${repository} to Trash? [y/N] `
                );
                return isAffirmativeResponse(answer);
            } finally {
                readline.close();
            }
        },

        async listRetainedBackups(repository) {
            return listRetainedMirrorBackups({ repository });
        },

        async moveBackupsToTrash(paths) {
            moveMirrorBackupsToTrash(paths, { cwd: repoRoot });
        },

        async createMirrorBackup({
            backupRoot = templateBackupRoot(),
            expectedCommit,
            repository,
            url = repositoryUrl(repository),
        }) {
            if (!expectedCommit) {
                throw new Error(
                    `Cannot back up ${repository} without the observed remote commit.`
                );
            }
            const retained = listRetainedMirrorBackups({
                backupRoot,
                repository,
            });
            if (retained.length > 0) {
                throw new Error(
                    `${repository} already has a retained recovery mirror. Fresh publication stopped before creating another one.`
                );
            }
            const backup = availableBackupPath(backupRoot, repository);
            try {
                runCommand(
                    "git",
                    ["clone", "--mirror", "--quiet", url, backup],
                    { cwd: repoRoot }
                );
            } catch (error) {
                rmSync(backup, { force: true, recursive: true });
                throw error;
            }
            const backedUpCommit = captured(
                "git",
                ["-C", backup, "rev-parse", `refs/heads/${DEFAULT_BRANCH}`],
                { cwd: repoRoot }
            ).trim();
            if (backedUpCommit !== expectedCommit) {
                throw new Error(
                    `${repository} moved after comparison. Nothing was rewritten. The newer mirror is retained at ${backup}.`
                );
            }
            return backup;
        },

        async createCommit({
            changedPaths,
            checkout,
            expectedCommit,
            history,
            message,
        }) {
            let commit;
            if (history === HISTORY_MODES.fresh) {
                const currentCommit = captured(
                    "git",
                    ["-C", checkout, "rev-parse", "HEAD"],
                    { cwd: repoRoot }
                ).trim();
                if (!expectedCommit || currentCommit !== expectedCommit) {
                    throw new Error(
                        "The temporary template checkout moved before the fresh commit. Nothing was pushed."
                    );
                }
                const tree = captured(
                    "git",
                    ["-C", checkout, "write-tree"],
                    { cwd: repoRoot }
                ).trim();
                commit = captured(
                    "git",
                    ["-C", checkout, "commit-tree", tree, "-F", "-"],
                    { cwd: repoRoot, input: `${message.trimEnd()}\n` }
                ).trim();
                runCommand(
                    "git",
                    [
                        "-C",
                        checkout,
                        "update-ref",
                        `refs/heads/${DEFAULT_BRANCH}`,
                        commit,
                        expectedCommit,
                    ],
                    { cwd: repoRoot }
                );
            } else {
                if (changedPaths.length === 0) {
                    throw new Error(
                        "A normal template commit requires changed paths."
                    );
                }
                runCommand(
                    "git",
                    [
                        "-C",
                        checkout,
                        "commit",
                        "--quiet",
                        "--file=-",
                        "--",
                        ...changedPaths,
                    ],
                    { cwd: repoRoot, input: `${message.trimEnd()}\n` }
                );
                commit = captured(
                    "git",
                    ["-C", checkout, "rev-parse", "HEAD"],
                    { cwd: repoRoot }
                ).trim();
            }
            const status = captured(
                "git",
                ["-C", checkout, "status", "--porcelain=v1"],
                { cwd: repoRoot }
            );
            if (status) {
                throw new Error(
                    "The temporary template checkout changed during commit. Nothing was pushed."
                );
            }
            return commit;
        },

        async pushUpdate(checkout) {
            runCommand(
                "git",
                [
                    "-C",
                    checkout,
                    "push",
                    "--quiet",
                    TEMPLATE_REMOTE,
                    DEFAULT_BRANCH,
                ],
                { cwd: repoRoot }
            );
        },

        async pushFresh({ checkout, commit, expectedCommit }) {
            runCommand(
                "git",
                [
                    "-C",
                    checkout,
                    "push",
                    "--quiet",
                    `--force-with-lease=refs/heads/${DEFAULT_BRANCH}:${expectedCommit}`,
                    TEMPLATE_REMOTE,
                    `${commit}:refs/heads/${DEFAULT_BRANCH}`,
                ],
                { cwd: repoRoot }
            );
        },

        async createRepository(checkout, repository) {
            runCommand(
                "gh",
                [
                    "repo",
                    "create",
                    repository,
                    "--public",
                    "--source",
                    checkout,
                    "--remote",
                    TEMPLATE_REMOTE,
                    "--push",
                ],
                { cwd: repoRoot }
            );
        },

        async ensureTemplate(repository) {
            const template = captured(
                "gh",
                ["repo", "view", repository, "--json", "isTemplate", "--jq", ".isTemplate"],
                { cwd: repoRoot }
            ).trim();
            if (template !== "true") {
                runCommand(
                    "gh",
                    ["repo", "edit", repository, "--template"],
                    { cwd: repoRoot }
                );
            }
        },

        async verifyPublished({ commit, repository }) {
            const remote = captured(
                "git",
                ["ls-remote", repositoryUrl(repository), `refs/heads/${DEFAULT_BRANCH}`],
                { cwd: repoRoot }
            ).trim();
            const remoteCommit = remote.split(/\s+/)[0];
            if (remoteCommit !== commit) {
                throw new Error(
                    `Remote ${DEFAULT_BRANCH} does not match the published commit.`
                );
            }

            const template = captured(
                "gh",
                ["repo", "view", repository, "--json", "isTemplate", "--jq", ".isTemplate"],
                { cwd: repoRoot }
            ).trim();
            if (template !== "true") {
                throw new Error(`${repository} is not marked as a template repository.`);
            }
        },

        async cleanup(workspace) {
            rmSync(workspace.tempRoot, { force: true, recursive: true });
        },

        log(message) {
            console.log(message);
        },
    };
}

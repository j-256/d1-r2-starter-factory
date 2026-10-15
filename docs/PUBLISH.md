# Publishing the template repositories

This repository is the source factory for two GitHub templates: `d1-r2-starter-openai` and `d1-r2-starter-wrangler`. Make changes in the factory, regenerate the templates, and publish the generated outputs. Do not edit the template repositories directly because the next publication replaces their working trees from the factory output.

## Security and CI ownership

Dependency version updates are factory-owned. The factory's `.github/dependabot.yml` covers its root lockfile, the Wrangler overlay lockfile, and GitHub Actions. Generated templates do not receive a Dependabot version-update configuration.

Review every dependency lifecycle script before approving it, and keep each approval pinned to the exact package version in the applicable `allowScripts` manifest field. The OpenAI edition inherits the root manifest policy, while the Wrangler edition owns its policy in `variants/wrangler/package.json`; after a lockfile update, `npm install-scripts ls` must report no unreviewed scripts in each affected product.

CI and GitHub security scanning still run independently in the factory and each published template because generated layout, imports, runtime composition, and repository settings can expose findings that are not observable in the factory's source layout. The OpenAI workflow is copied from the factory, while the Wrangler workflow is emitted from its overlay.

Treat downstream alerts as reports against generated products, but author dependency and code fixes in this factory and publish them through the normal template workflow. Keep automated Dependabot security updates disabled in generated repositories so GitHub cannot create output-only fixes that the next publication would replace.

The generated-tree guards reject `.github/dependabot.yml` in either edition. Before any downstream write, the publisher verifies that automated Dependabot security updates remain disabled in each selected existing repository. It checks the generated policy and live setting again after publication and before advancing the factory cursor. A policy failure leaves the cursor unchanged and reports the command that disables the setting.

The short version: use replay to preserve factory commit boundaries in template history; omit replay to publish one net snapshot commit per changed template.

## Automatic publication

The [Publish templates workflow](../.github/workflows/publish-templates.yml) runs after a successful main Project cover workflow, which includes the factory release check. It checks out the latest factory `main`, repeats `npm run release:check` for that exact commit, then runs `npm run template:publish -- all --history append --replay --yes`. A scheduled run catches factory updates missed by earlier runs, and `workflow_dispatch` supports a manual retry. The workflow is serialized so concurrent factory updates cannot publish both templates at once. A failed run remains visible in Actions; no fallback skips the publisher's baseline, policy, remote, or cursor checks.

The workflow needs a dedicated `TEMPLATE_PUBLISH_TOKEN` repository secret on this factory. Use a fine-grained GitHub token limited to this factory and the two generated template repositories, with repository Contents write access for template pushes, Variables write access for the factory cursors, and Administration read access for the downstream Dependabot policy checks. Store the token in the factory's Actions secrets, never in source or logs. The workflow keeps that token out of dependency installation and the release gate, and supplies it only to the publisher step. An absent, expired, or insufficient token fails the run visibly; do not substitute the maintainer's broad local `gh` token.

The publisher prepares every selected replay and proves each append baseline matches its remote before changing either template or a factory cursor. A remote change after that preflight can still reject a push; retry the workflow after reconciling the new remote state. Keep security fixes and dependency updates in the factory. A direct edit to a generated template can block replay and needs an explicit one-time snapshot append or another reviewed recovery; the automatic workflow never changes history mode or force-pushes to work around it.

## How publication works

From a clean `main` branch, the bare command uses the normal checkpoint-preserving workflow for both templates:

```bash
npm run template:publish
```

Before running any checks or publication work, the publisher prints its expanded default command to stderr:

```bash
npm run template:publish -- all --history append --replay
```

This default retains each downstream repository's history, regenerates every factory checkpoint after its recorded cursor, and still asks for final publication approval. Once any arguments are supplied, continue to choose the target explicitly with `all`, `openai`, or `wrangler`; `both` remains a compatibility alias for `all`:

```bash
npm run template:publish -- openai
```

The publisher performs the following work in clearly labeled phases:

1. Surfaces any retained recovery mirrors from earlier fresh publications
2. Confirms that the factory worktree is clean and that `HEAD` matches `origin/main`
3. In replay mode, loads recorded cursors when requested and validates every selected baseline before cleanup or generation
4. In clobber mode, moves selected retained recovery mirrors to Trash
5. Runs the factory tooling tests and generates both templates once, even when both repositories are selected
6. Compares every selected generated tree with its GitHub template repository in a disposable checkout and verifies the downstream Dependabot policy
7. Shows the complete staged diff for every planned publication
8. For each changed existing repository, asks whether to append normal history or replace `main` with fresh history when `--history` was not supplied
9. In normal mode, resolves the root-commit default or prompts for a missing append message; in replay mode, prepares the relevant factory checkpoint commits and shows each diff
10. Asks for final yes-or-no publication approval, publishes `main` once, confirms the remote commit, and verifies the template and downstream Dependabot settings
11. Records each verified template's factory revision in factory-repository metadata
12. After an ordinary interactive fresh publication, offers a yes-or-no choice to move the verified recovery mirror to Trash
13. Prints a compact summary showing whether each selected template was unchanged, created, updated, replaced, or cancelled

If a generated tree already matches its existing template repository, the publisher normally does not ask for a message or confirmation and does not create a commit or push. It still records that the matching tree was verified at factory `HEAD`, making that revision available to later replay. Explicit `--history fresh` is the exception because replacing maintainer history is itself the requested publication.

Explicit fresh mode is preflighted before tests and generation. Without `--clobber`, any selected template with a retained recovery mirror stops the command immediately.

## First publication

When a selected GitHub repository does not exist, the publisher creates it as a public repository, pushes an initial commit, enables the GitHub template setting, and records the verified factory revision. The initial commit message defaults to `Initial commit`, so no message is required for this first publication. Checkpoint replay adds its relevant commits after that baseline root before the repository is pushed.

```bash
npm run template:publish -- openai
```

## Choosing history for an existing template

When a repository already exists and is selected for a changed, replayed, or explicitly fresh publication, the publisher shows the relevant diff and asks how to record the publication:

1. `append` (recommended) adds a normal commit to the template repository's maintainer history. It preserves an audit trail and makes rollback straightforward.
2. `fresh` replaces `main` with history that starts at one new root commit. Normal mode stops at that complete-tree root; checkpoint replay adds its relevant commits afterward. Fresh mode force-pushes with a lease and rewrites the template repository's maintainer history.

The publisher does not auto-squash commits. An append publication remains a normal child commit in the template repository. GitHub's separate template-generation behavior still gives a new downstream repository created with "Use this template" a single initial commit, regardless of how many maintainer commits the template repository has. See [Creating a repository from a template](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template).

### Common publishing scenarios

These scenarios assume the reviewed factory changes are committed on clean `main` and pushed so factory `HEAD` matches `origin/main`.

#### Preserve relevant teaching checkpoints

Use recorded replay for the normal checkpoint-preserving workflow:

```bash
npm run template:publish
```

The publisher regenerates both editions at every factory checkpoint after each template's cursor. A shared checkpoint can become a commit in both template repositories, an OpenAI-only checkpoint appears only in OpenAI, and a Wrangler-only checkpoint appears only in Wrangler. A checkpoint that produces no generated difference for an edition is skipped there. Each changed template repository receives its complete relevant sequence in one push, then its cursor advances to factory `HEAD`.

#### Combine several factory commits into one template commit

Omit replay and publish a normal snapshot:

```bash
npm run template:publish -- openai --history append --message "Improve document management"
```

The factory commits remain separate. The OpenAI template receives one child commit containing their net generated effect, and its cursor advances directly to factory `HEAD`. A later replay therefore starts after those factory commits instead of publishing them again. Target `all` instead when every matching template cursor should advance; only templates with a generated difference receive a commit or push.

#### Publish one template without advancing the other

Select one edition explicitly:

```bash
npm run template:publish -- openai --history append --replay
```

Only the OpenAI repository and its factory-owned cursor can change. The Wrangler repository and cursor remain untouched. A later Wrangler replay starts from its own older cursor, examines the intervening factory checkpoints, and skips any that do not affect Wrangler.

#### Bootstrap or recover replay state

Use an explicit baseline when a selected cursor has not been recorded, was lost, or refers to rewritten factory history:

```bash
npm run template:publish -- all --history append --replay-from <baseline-revision>
```

For append history, that revision must generate the exact tree already published by every selected template. A successful publication records factory `HEAD` as the new cursor. If OpenAI and Wrangler need different baseline revisions, publish them separately with the appropriate `--replay-from` value instead of targeting `all`.

#### Advance past factory-only work

Run recorded replay normally even when the intervening factory commits only change publisher tooling, tests, or other factory-owned files:

```bash
npm run template:publish
```

If no checkpoint changes a generated edition, that template receives no commit and no push. The publisher still verifies the generated tree and advances its factory-owned cursor, so the same irrelevant checkpoints do not need to be reconsidered later.

#### Replace maintainer history deliberately

To rebuild each selected history as a baseline root followed by relevant teaching checkpoints, use recorded replay with clobber:

```bash
npm run template:publish -- all --clobber --replay --yes
```

To replace each selected history with only one root commit containing the generated `HEAD` tree, omit replay:

```bash
npm run template:publish -- all --clobber --yes
```

Both commands force-push with a lease and use the verified recovery-mirror lifecycle. `--clobber` also authorizes moving retained mirrors for the selected templates to Trash; `--yes` removes interactive publication prompts.

### Replay curated factory checkpoints

Use checkpoint replay when the template repository's maintainer history should teach the architecture in the same deliberate steps as the factory. For routine publication, let the publisher start each selected template from its own last verified factory revision:

```bash
npm run template:publish
```

Replay is automatic rather than an interactive cherry-pick session. For each selected template, the publisher:

1. Starts at that template's recorded cursor, or at an explicit `--replay-from` baseline
2. Walks every first-parent factory commit after the baseline through `HEAD`
3. Regenerates the template at the baseline and at each factory checkpoint
4. Automatically skips a checkpoint when it produces no generated difference for that template
5. Creates a local downstream commit for every relevant difference, preserving the factory commit's subject and optional body
6. Shows every retained commit message and diff
7. Asks once whether to publish the complete prepared sequence
8. Pushes the sequence once, verifies the remote, and advances the template's factory-owned cursor

There is no per-commit take-or-skip prompt and no replay message prompt. If append replay finds no relevant commits, it asks nothing and pushes nothing; it verifies the final generated tree and advances the cursor. To change a replayed boundary or message, edit the factory history before publication. To combine the net result into one downstream commit, omit replay.

The cursors are [repository-level GitHub Actions variables](https://docs.github.com/en/rest/actions/variables) on the factory repository: `TEMPLATE_OPENAI_FACTORY_REVISION` and `TEMPLATE_WRANGLER_FACTORY_REVISION`. No cursor, variable, file, commit trailer, tag, or other factory breadcrumb is written to either template repository. Keeping separate factory-owned cursors lets a publication of only `openai` advance OpenAI state without claiming that Wrangler was published.

Use `--replay-from` only to bootstrap a cursor, recover from lost state, or deliberately override it. Supply the factory revision whose generated tree is the published baseline; the publisher replays every first-parent commit after that revision through `HEAD`:

```bash
npm run template:publish -- all --history append --replay-from <baseline-revision>
```

Append replay first proves that each downstream repository exactly matches its generated baseline. If it does not, publication stops before creating or pushing anything and asks for the correct baseline or fresh history. This prevents an unrelated downstream state from being folded into the first replayed checkpoint. Recorded replay also stops before downstream writes when a selected cursor is missing or no longer resolves; recover with `--replay-from` after identifying the equivalent baseline.

Fresh replay creates a parentless `Initial commit` from the generated baseline, then adds the relevant factory checkpoints. Combine it with clobber when old history and retained mirrors should both be replaced and cleaned through the verified backup lifecycle:

```bash
npm run template:publish -- all --clobber --replay --yes
```

After a downstream publication is verified, the publisher creates or updates that template's cursor on the factory repository and reads it back before reporting success. Normal snapshot publication records the same state, including an unchanged generated tree that exactly matches its remote. A failed state write leaves a fresh-history recovery mirror in place. A replay whose cursor already equals factory `HEAD` is valid: append mode verifies the tree and advances no commits, while fresh mode can still replace history with the generated baseline root.

`--replay` and `--replay-from` are mutually exclusive. `--message` cannot be combined with either because replayed messages come from the reviewed factory commits. Edit the factory commit message before publication when its downstream explanation needs improvement.

### Append a normal update

Choose `append` at the interactive prompt or pass it explicitly:

```bash
npm run template:publish -- openai --history append --message "Add portable authorization boundary"
```

Append uses a normal push and reports the template as `updated`.

### Replace history with a fresh root

Choose `fresh` at the interactive prompt or pass it explicitly:

```bash
npm run template:publish -- openai --history fresh
```

Normal fresh mode defaults to `Initial commit`; pass `--message` only when you want a different root-commit message. Replay always uses `Initial commit` for its generated baseline and preserves the factory messages that follow it.

Before changing the remote ref, the publisher creates a bare mirror of the existing repository and verifies that the mirror contains the exact `main` commit observed during comparison. It stores the mirror under `TEMPLATE_PUBLISH_BACKUP_DIR` when that variable is set, otherwise under `${XDG_STATE_HOME:-$HOME/.local/state}/d1-r2-starter/template-publish-backups`. The summary prints the exact retained path.

Fresh mode creates a parentless commit, then pushes with `--force-with-lease` pinned to the previously observed remote commit. If another publication moves `main` first, the push fails without overwriting it. The interactive publication prompt names the repository and the history-replacing action; answer `y` or `yes` to continue, and any other answer cancels that publication.

After the rewritten remote and template setting are verified, an interactive run prints the published commit URL and asks whether to move the mirror to Trash. Answer `y` or `yes` to move it, or press Enter to retain it. A non-interactive run retains the mirror because `--yes` authorizes publication but does not request post-publication cleanup.

Every publisher run surfaces retained mirrors before generation. Fresh mode refuses to create another mirror for a repository that already has one, preventing unresolved backups from accumulating unnoticed. Append mode remains available because it does not rewrite history or need another recovery mirror.

### Manage retained mirrors

List every retained template publication mirror:

```bash
npm run template:backups
```

Limit the list to one variant:

```bash
npm run template:backups -- openai
```

After you have inspected a rewritten repository and no longer need its recovery mirrors, ask the manager to show the exact paths and move them to Trash:

```bash
npm run template:backups -- trash openai
```

The explicit `trash` action and required variant are the cleanup approval, so the command does not ask for a second confirmation. If restoration is needed instead, use the retained bare mirror to inspect and deliberately restore the previous refs.

### Clobber selected histories and mirrors

Use clobber mode when the intended result is fresh root history with no retained publication mirrors after successful verification:

```bash
npm run template:publish -- all --clobber --yes
```

`--clobber` implies `--history fresh`, uses the normal `Initial commit` root-message default, and conflicts with `--history append`. After the clean-factory check, it moves pre-existing mirrors for the selected variants to Trash before generation. Each existing repository still gets a verified recovery mirror before its lease-protected force push; that new mirror moves to Trash only after the published commit and template setting are verified.

If publication or verification fails, the new recovery mirror remains available. If post-verification Trash cleanup fails, the command exits with an error that identifies the successfully published repository and retained mirror. Mirrors for unselected variants are never moved.

`--yes` authorizes publication without prompts. `--clobber` separately authorizes the fresh-history and mirror-cleanup lifecycle; neither flag silently acquires the other's meaning.

Passing `--history fresh` also replaces history when the generated files are unchanged. This is useful when the only intended change is collapsing the template repository's maintainer history to a new root. An interactive run without `--history` continues to skip unchanged repositories.

## Commit messages

Creating a repository and replacing one with `fresh` both default to the root-commit message `Initial commit`. An append publication has no default that can describe its changes, so the publisher asks for its message after showing the diff when `--message` was not supplied.

With `all`, one supplied message is used for every changed template selected by the run:

```bash
npm run template:publish -- all --history append --message "Refresh generated templates"
```

For append mode, omit `--message` when the templates need different commit messages; the publisher prompts for each changed repository separately. Run the variants separately when they also need different history modes.

Checkpoint replay is the exception to the one-message model. It carries each relevant factory subject and body into the template repository and reports how many commits each edition receives. `--replay` chooses the saved per-template cursor; `--replay-from` supplies one explicit cursor for every selected template.

## Non-interactive publication

Pass `--yes` to disable interactive prompts and make the command invocation itself the approval to publish after every safety check passes. It supplies consent, not a history choice: an existing repository selected for publication still needs `--history` unless `--clobber` supplies fresh history. `--message` supplies or overrides the commit message, but it is not always required. Creating a repository and replacing one with `fresh` both produce a root commit and therefore default to `Initial commit`; an `append` update has no meaningful default, so it requires `--message` under `--yes` or prompts without `--yes`.

Factory cursor recording follows verification and has no separate prompt. Invoking the publisher for selected targets authorizes that bookkeeping even when their generated trees already match, so `--yes` neither enables nor disables it.

The full staged diff is still printed before any commit. `--yes` does not bypass factory checks, generated-tree guards, remote leases, backup creation, remote verification, or factory cursor verification. By itself, it also does not delete a fresh-mode recovery mirror; `--clobber` is the separate cleanup authorization.

With `--replay` or `--replay-from`, the disposable checkout commits are prepared locally so their exact diffs can be reviewed before approval. `--yes` approves publishing that prepared sequence and recording the verified factory cursor; the template remote still receives only one push after final-tree verification.

Use non-interactive mode only when the complete command is the publication approval, such as a controlled release job:

```bash
npm run template:publish -- wrangler --history append --message "Refresh Worker dependencies" --yes
```

An explicit non-interactive fresh replacement uses the root-commit default unless `--message` overrides it:

```bash
npm run template:publish -- all --history fresh --yes
```

## Pre-publish checklist

- [ ] Shared core changes are complete and committed on `main`
- [ ] Factory checkpoint subjects and bodies make sense in each downstream template that will receive them
- [ ] The Wrangler tree has passed its generated dependency install and typecheck; migration application and a `wrangler dev` smoke test have passed in a provisioned Cloudflare environment
- [ ] The ChatGPT Sites artifact has been confirmed with `npm run test:build` or through the Sites save-version workflow
- [ ] `dist/openai/.openai/hosting.json` has no `project_id`, allowing Sites to provision a new project from the reusable template
- [ ] Each generated tree contains the MIT license and matching package metadata
- [ ] The generated Wrangler tree contains no OpenAI, ChatGPT, Next.js, React, or Vinext residue

The publisher enforces the clean factory state, factory tooling tests, generation gates, emitted manifest project-linkage guard, residue rules, generated tests, the generated Wrangler dependency install and typecheck, explicit changed-path staging, replay baseline matching, replay final-tree equivalence, factory-owned publication cursor verification, fresh-mode mirror backup, unresolved-mirror accumulation guard, lease-protected history replacement, and remote verification. The runtime-specific smoke checks remain manual because they require provisioned Cloudflare or Sites environments.

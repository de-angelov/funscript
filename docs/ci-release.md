# CI and npm release operations

## Continuous integration

The `CI` workflow runs for pull requests targeting `main` and pushes to `main`. It
uses Node.js 20, installs from `package-lock.json` with `npm ci`, builds both the
compiler and VS Code extension, checks formatting on supported `.fun` examples
with the CLI and Prettier, checks a `.funx` JSX fixture, and runs the Vitest
suite. The formatter preserves JSX source; `.funx` files with embedded
TypeScript blocks and several `.fun` examples with embedded TypeScript or
multiline strings remain outside the formatting check until those formatter
cases are supported. Superseded runs for the same pull request or branch are
cancelled.
The workflow needs no repository secrets and has read-only repository permissions.
On failure it uploads the captured build and test logs (and any generated source
maps) as a short-lived Actions artifact.

## Preparing a release

CI verifies changes; it does not publish packages. The manual `Prepare npm
Release` workflow verifies `main`, checks that the required version input exactly
matches `package.json`, packs the npm package, and uploads the tarball. Its final
job waits on the `npm-release` GitHub environment, then creates a **draft** GitHub
release with the tarball attached. A maintainer reviews the draft and release notes
before publishing the GitHub release. No npm publish command is present in this
workflow.

Before running it, maintainers should:

1. Merge the intended release commit to `main`, update `package.json` and
   `package-lock.json` to the release version, and confirm CI passes.
2. In repository Settings → Environments, create `npm-release` and configure
   required reviewers. Do not permit self-review if the repository's policy
   requires a separate approver.
3. In Actions → Prepare npm Release → Run workflow, enter the exact package
   version and select whether it is a prerelease. The environment approval is the
   explicit release approval before a draft release is created.
4. Inspect the uploaded tarball and draft release contents before publishing the
   GitHub release.

No repository secret is needed to create this draft GitHub release; GitHub's
workflow token receives `contents: write` only in the approval-gated release job.
The verification job has read-only permissions. The workflow declares no npm
token and does not publish to npm.

## Future npm publishing and rollback

The release job has narrowly scoped `id-token: write` permission for future OIDC
trusted publishing, but currently has no step that requests an OIDC token and does
not invoke `npm publish`. Before enabling npm trusted publishing, maintainers must configure
the npm package's trusted publisher to the exact GitHub owner, repository, and
release workflow, and configure the repository's `npm-release` environment
reviewers. Verify npm's current trusted publishing requirements at that time.
Only after TASK-064 is approved and completed may an authorized change add the
OIDC permission and publish step. Do not add long-lived npm automation tokens.

If package publication is later enabled, npm versions are immutable and cannot be
overwritten. For a bad release, deprecate the affected version with an explanatory
message, fix the issue, and publish a new patch version; do not attempt to replace
the tarball. For a draft GitHub release, delete the draft or edit it before
publishing. After publication, use a follow-up release and clear release notes to
identify the corrected version.

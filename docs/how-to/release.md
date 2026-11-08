# Releasing MossStudio

A release is a `v<version>` tag on `main`. `.github/workflows/release.yml` does the rest. This page covers the one-time setup, the steps for each release, and how to rotate the signing key.

## What the workflow does

1. **Checks** (job `prepare`, in the protected `release` environment):
   - the tagged commit is on `main`;
   - the tag is `v` + the version in both `package.json` and `apps/desktop/package.json` (they must be equal);
   - `release/notes/<version>.md` exists;
   - the secret `MOSS_UPDATE_SIGNING_KEY` is set, and its public half is in `PRODUCTION_UPDATE_KEYS` (`apps/desktop/src/shared/updateKeys.ts`).
2. **Builds** win32-x64, linux-x64, darwin-arm64 and darwin-x64. Each produces a setup (`.exe` / `.run` / `.dmg`), a portable package, the full update package and its file list.
3. **Publishes** (job `publish`, in the `release` environment):
   - builds delta packages against earlier releases;
   - writes `update-stable.json` / `update-beta.json`, then signs them with Ed25519;
   - verifies everything against the production keys;
   - creates the GitHub release `v<version>` with the notes;
   - replaces the feeds on the rolling `updates` release. The `.sig` goes up before the feed, so a client never trusts an unverified pair.

Channels:
- A stable version goes to `stable` and `beta`.
- A prerelease (`1.2.0-beta.1`) goes to `beta` only.
- A channel whose live feed already has the same or a newer version is skipped, so a backport (`v1.0.9` after `v1.1.0`) never sends clients backwards.

Test builds from `build.yml` trust an ephemeral key and read a local feed. They can never update from the real feed.

## Nightly builds

`.github/workflows/nightly.yml` builds `main` every night at 18:00 UTC. It replaces the rolling `nightly` prerelease, moving its tag to the new commit, and uploads the setups and portable packages for all four platforms.

- The version is `<next release>-nightly.<UTC date>`, for example `1.0.3-nightly.20261108`. The next release is the `package.json` version, or one patch later when that version is already tagged. So a nightly always ranks below the release that follows it.
- A nightly is download-only. It has no full or delta packages, it is on no update feed, and it never enters the `release` environment or touches the signing key.
- The scheduled run skips a night when `main` is still at the `nightly` tag. To build one now, run `gh workflow run nightly.yml`.

## One-time setup (a maintainer)

1. Run `pnpm release:keygen`. It prints a `PRODUCTION_UPDATE_KEYS` entry and the private key.
2. Add the entry to `apps/desktop/src/shared/updateKeys.ts` in a PR and merge it. Until then, release builds reject every feed and cannot update.
3. In GitHub, **Settings › Environments › `release`**:
   - add the secret `MOSS_UPDATE_SIGNING_KEY` (the private key);
   - require a reviewer;
   - limit deployment to tags matching `v*`.

   Do not keep the private key anywhere else in plain text.

## Each release

1. Bump the version in **both** `package.json` and `apps/desktop/package.json`. Use strict semver; a prerelease looks like `1.2.0-beta.1`.
2. Write `release/notes/<version>.md`. It is the GitHub release text and the in-app notes. Optional front matter:

   ```markdown
   ---
   minimumVersion: 1.0.4
   ---
   ```

   `minimumVersion` marks every older version as **必须更新**: it can no longer generate until it updates.
3. Open a PR (`chore(release): 1.0.4`), let CI pass, and merge it.
4. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag v1.0.4 && git push origin v1.0.4
   ```

5. Approve the `release` environment when GitHub asks. Then check that the release and the `updates` feeds exist.

To run the whole install → update → rollback → uninstall path locally before tagging, use `pnpm test:install`. It covers Linux, and works on Windows.

## Rotating the signing key

1. Generate a new pair (`pnpm release:keygen`), and add the new public key **next to** the old one in `PRODUCTION_UPDATE_KEYS`.
2. Release once still signing with the **old** key. Clients learn the new key from that release.
3. Replace the secret with the new private key, and release.
4. One release later, remove the old public key.

## Not yet in place

- The binaries are not code-signed (Windows Authenticode, macOS notarization). Users see the system's first-run warning.
- `PRODUCTION_UPDATE_KEYS` is empty until the one-time setup above is done.

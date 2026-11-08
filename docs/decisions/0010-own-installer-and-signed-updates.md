# ADR-0010: Own installer, launcher and signed update feed

- Status: **accepted, implemented** (2026-11-06, #27, with fixes in #29)
- Supersedes: [ADR-0005](0005-release-channel-and-updates.md) (`release.md` + `manifest.json` as the release source; open the installer to update)
- Related: [docs/how-to/release.md](../how-to/release.md)

## Context

The first update path, from ADR-0005, read a Markdown release document. It downloaded a Windows installer and asked the user to run it. It covered one platform, could not roll back, did not verify what it downloaded beyond a hash from the same unauthenticated source, and needed the user for every step.

## Decision

1. **The app installs and updates itself on Windows, Linux and macOS.** Installers and portable packages share one layout, the install root R:
   - Windows/Linux: a small Go launcher, an `app-<version>/` folder per version, `data/` by default, and `install.json`;
   - macOS: `MossStudio.app` plus hidden previous bundles.

   The first install asks for a location; later installs reuse it through a per-user locator.
2. **The launcher (`apps/launcher`, Go) owns switching versions.** It moves `pending` to `current`, and rolls back when a new version exits with an error before it confirms its health. It also finishes an uninstall from a temporary copy of itself. On macOS a `/bin/sh` helper does the bundle swap.
3. **Updates come from a signed feed.**
   - `update-<channel>.json` is signed with Ed25519 and verified before it is parsed.
   - The app trusts only `PRODUCTION_UPDATE_KEYS`.
   - A high-water mark rejects replayed older feeds.
   - Full and delta packages are verified against their file lists.
4. **Releases are built only by CI from a `v*` tag on `main`.** The signing key exists only in the protected `release` environment.
5. **The app tells the user what happened.** It reports a rolled-back version once and offers to try it again. It never re-offers a failed version on its own.

## Consequences

- Every install, update, rollback and uninstall path is exercised on all four platforms by `build.yml`'s integration test (`tools/release/integration`).
- The release process lives in [docs/how-to/release.md](../how-to/release.md). Until a production key is generated, release builds cannot update.
- Code signing (Authenticode, notarization) is still to do. It is independent of feed signing.

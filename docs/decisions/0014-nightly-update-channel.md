---
status: proposed
date: 2026-11-10
amends: ADR-0010
---

# ADR-0014: A nightly update channel signed by its own key

## Context and problem statement

`.github/workflows/nightly.yml` builds `main` every night, but a nightly is download-only: no feed names it, so someone who wants to follow `main` has to download and install a new setup by hand each day. ADR-0010 keeps the only signing key in the protected `release` environment, which requires a reviewer and accepts only `v*` tags, so an unattended nightly run cannot sign a feed with it. The maintainer asked for a nightly channel that updates by itself. How can nightlies be signed without weakening what stable and beta clients trust?

## Decision drivers

- A leaked or misused nightly signature must never reach people on 正式版 or 测试版.
- Nightlies run unattended at 18:00 UTC; nobody approves them.
- Launchers already installed are not replaced by updates and accept only `stable` and `beta` in `install.json`.
- Someone who rolls back from a nightly to a version from before this change must keep updating.

## Considered options

1. Sign nightlies with the production key and approve the `release` environment every night.
2. A second key, held by a `nightly` environment without a reviewer and limited to `main`, that clients trust for `update-nightly.json` only.
3. Keep nightlies download-only.

## Decision outcome

Chosen: option 2, as the maintainer chose on 2026-11-10. Option 1 means a manual approval every night, and one key for every channel. Option 3 is what the maintainer asked to change.

1. **Channel.** `UPDATE_CHANNELS` gains `nightly`. A client on 每日构建 reads the nightly, beta and stable feeds and takes the newest version (`channelsToRead` in `main/update/select.ts`).
2. **Key scope.** `NIGHTLY_UPDATE_KEYS` in `shared/updateKeys.ts` is trusted for the nightly feed only (`trustedUpdateKeys(channel)` in `main/update/keys.ts`); the signed feed also names its channel, so it cannot be replayed as another one. The private key is the secret `MOSS_NIGHTLY_SIGNING_KEY` of the `nightly` environment. The production key never enters the nightly workflow.
3. **Settings, not install.json.** `install.json` keeps `stable` or `beta` (`RECORD_CHANNELS`), so older launchers still read it. 每日构建 is saved as `updateChannel: 'beta'` plus `nightlyUpdates: true`; a version from before this change reads that as 测试版.
4. **Packages.** The nightly's full packages, file lists and deltas from the previous nightly go on the rolling `updates` release beside the feeds, which is never deleted. The downloadable `nightly` release is replaced as before.
5. **Leaving.** Switching back to 正式版 or 测试版 keeps the running nightly until that channel has a newer version; there is no downgrade.

### Consequences

- Good: people who want the newest build get it every morning without reinstalling, with deltas between consecutive nightlies.
- Good: the production key's reach is unchanged. A compromised nightly key can reach only clients on 每日构建.
- Bad: a second secret to keep and rotate. Until its public half ships in a release, nightlies stay download-only.
- Bad: a compromised nightly key can still ship anything to everyone on 每日构建, including a `minimumVersion` that blocks generation. That is the cost of signing without a reviewer.

## More information

- Amends [ADR-0010](0010-own-installer-and-signed-updates.md), point 4: the production key stays in `release`; the nightly key lives in `nightly`.
- Setup and rotation: [docs/how-to/release.md](../how-to/release.md#nightly-builds).

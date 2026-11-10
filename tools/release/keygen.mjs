#!/usr/bin/env node
// Generate an Ed25519 key pair for signing update feeds.
//
//   pnpm release:keygen               human-readable: the updateKeys.ts entry and the secret
//   pnpm release:keygen --nightly     the same for the nightly key (update-nightly.json only)
//   node tools/release/keygen.mjs --json   one JSON line { id, publicKey, privateKey } (CI test keys)
import { parseArgs } from 'node:util'
import { main } from './lib/cli.mjs'
import { generateKeyPair } from './lib/sign.mjs'

main(async () => {
  const { values } = parseArgs({ options: { json: { type: 'boolean', default: false }, nightly: { type: 'boolean', default: false } } })
  const pair = generateKeyPair()
  if (values.json) {
    console.log(JSON.stringify({ id: pair.id, publicKey: pair.publicKey, privateKey: pair.privateKeyBase64 }))
    return
  }
  const list = values.nightly ? 'NIGHTLY_UPDATE_KEYS' : 'PRODUCTION_UPDATE_KEYS'
  const secret = values.nightly ? 'MOSS_NIGHTLY_SIGNING_KEY' : 'MOSS_UPDATE_SIGNING_KEY'
  const environment = values.nightly ? 'nightly' : 'release'
  console.log(`Public key: add this entry to ${list} in apps/desktop/src/shared/updateKeys.ts`)
  console.log('')
  console.log(`  { id: '${pair.id}', publicKey: '${pair.publicKey}' },`)
  console.log('')
  console.error(
    values.nightly
      ? 'WARNING: the private key below signs updates for every MossStudio install on 每日构建.'
      : 'WARNING: the private key below signs updates for every MossStudio install.',
  )
  console.error(`Store it only as the secret ${secret} of the GitHub environment \`${environment}\` (Settings ›`)
  console.error('Environments). Never commit it, paste it into an issue or keep it in shell history.')
  console.log('')
  console.log(`Private key (${secret}, base64 Ed25519 seed):`)
  console.log('')
  console.log(pair.privateKeyBase64)
})

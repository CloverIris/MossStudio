#!/usr/bin/env node
// Generate an Ed25519 key pair for signing update feeds.
//
//   pnpm release:keygen            human-readable: the updateKeys.ts entry and the secret
//   node tools/release/keygen.mjs --json   one JSON line { id, publicKey, privateKey } (CI test keys)
import { parseArgs } from 'node:util'
import { main } from './lib/cli.mjs'
import { generateKeyPair } from './lib/sign.mjs'

main(async () => {
  const { values } = parseArgs({ options: { json: { type: 'boolean', default: false } } })
  const pair = generateKeyPair()
  if (values.json) {
    console.log(JSON.stringify({ id: pair.id, publicKey: pair.publicKey, privateKey: pair.privateKeyBase64 }))
    return
  }
  console.log('Public key: add this entry to PRODUCTION_UPDATE_KEYS in apps/desktop/src/shared/updateKeys.ts')
  console.log('')
  console.log(`  { id: '${pair.id}', publicKey: '${pair.publicKey}' },`)
  console.log('')
  console.error('WARNING: the private key below signs updates for every MossStudio install.')
  console.error('Store it only as the GitHub Actions secret MOSS_UPDATE_SIGNING_KEY (Settings › Secrets and')
  console.error('variables › Actions). Never commit it, paste it into an issue or keep it in shell history.')
  console.log('')
  console.log('Private key (MOSS_UPDATE_SIGNING_KEY, base64 Ed25519 seed):')
  console.log('')
  console.log(pair.privateKeyBase64)
})

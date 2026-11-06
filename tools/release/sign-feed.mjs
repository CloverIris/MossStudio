#!/usr/bin/env node
// Sign feeds: writes <feed>.sig ({ keyId, signature }, Ed25519 over the exact feed bytes).
//
//   MOSS_UPDATE_SIGNING_KEY=<PKCS8 PEM | base64 seed> node tools/release/sign-feed.mjs <update-stable.json> [...]
//   node tools/release/sign-feed.mjs --key-file <file> <feed> [...]          (local tests)
//
// Fails when no key is given: an unsigned feed must never be published.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { main } from './lib/cli.mjs'
import { parsePrivateKey, publicKeyBase64, signFeed } from './lib/sign.mjs'

main(async () => {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'key-file': { type: 'string' } } })
  if (positionals.length === 0) throw new Error('no feed files given')
  const source = values['key-file'] ? readFileSync(values['key-file'], 'utf8') : process.env.MOSS_UPDATE_SIGNING_KEY
  if (!source?.trim()) throw new Error('MOSS_UPDATE_SIGNING_KEY is not set (and no --key-file): refusing to publish unsigned feeds')
  const key = parsePrivateKey(source)
  console.log(`signing with public key ${publicKeyBase64(key)}`)
  for (const feed of positionals) {
    const sig = signFeed(readFileSync(feed), key)
    writeFileSync(`${feed}.sig`, `${JSON.stringify(sig)}\n`)
    console.log(`${feed}.sig: keyId ${sig.keyId}`)
  }
})

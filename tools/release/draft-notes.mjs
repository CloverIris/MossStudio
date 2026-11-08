#!/usr/bin/env node
// `pnpm release:notes`: drafts release/notes/<version>.md from the Conventional Commit subjects on
// main since the last release tag, grouped by type. The draft is for the person cutting the release:
// rewrite it for users (Chinese, by what they notice) before tagging. It never overwrites a file.
//   --since <tag>   start after this tag instead of the latest release tag
//   --stdout        print the draft instead of writing the file
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_DIR, REPO_ROOT, fail, main } from './lib/cli.mjs'

const GROUPS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['build|ci|chore|style|test|revert', 'Maintenance'],
]

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

/** The newest release tag reachable from HEAD: `v1.2.3` or the older `1.2.3`, never `nightly`. */
function latestReleaseTag() {
  const tags = git('tag', '--merged', 'HEAD').split('\n').filter((tag) => /^v?\d+\.\d+\.\d+$/.test(tag))
  const key = (tag) => tag.replace(/^v/, '').split('.').map(Number)
  tags.sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  })
  return tags.at(-1)
}

main(async () => {
  const args = process.argv.slice(2)
  const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : latestReleaseTag()
  if (!since) fail('no release tag found; pass --since <tag>')
  const version = JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')).version

  const subjects = git('log', '--first-parent', '--format=%s', `${since}..HEAD`).split('\n').filter(Boolean)
  const grouped = new Map(GROUPS.map(([, title]) => [title, []]))
  const other = []
  for (const subject of subjects) {
    const match = /^([a-z]+)(\([^)]*\))?!?: (.+)$/.exec(subject)
    const group = match && GROUPS.find(([types]) => types.split('|').includes(match[1]))
    if (group) grouped.get(group[1]).push(`- ${match[2] ? `${match[2].slice(1, -1)}: ` : ''}${match[3]}`)
    else other.push(`- ${subject}`)
  }

  const sections = [...grouped].filter(([, lines]) => lines.length).map(([title, lines]) => `## ${title}\n\n${lines.join('\n')}`)
  if (other.length) sections.push(`## Not in Conventional Commit form\n\n${other.join('\n')}`)
  const draft = [
    `<!-- Draft for ${version} from ${subjects.length} commits since ${since} (pnpm release:notes).`,
    '     Rewrite for users in Chinese, by what they notice, then delete this comment. -->',
    '',
    ...sections.flatMap((section) => [section, '']),
  ].join('\n')

  if (args.includes('--stdout')) {
    process.stdout.write(draft)
    return
  }
  const file = join(REPO_ROOT, 'release', 'notes', `${version}.md`)
  if (existsSync(file)) fail(`${file} exists; use --stdout to see the draft`)
  writeFileSync(file, draft)
  console.log(`wrote ${file} (${subjects.length} commits since ${since})`)
})

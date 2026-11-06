// Local update server for the integration test (node:http, no dependencies):
//   /files/<name>  the built artifacts (HTTP Range supported, so resumed downloads are exercised)
//   /feed/<name>   update-<channel>.json(.sig) from the feed folder currently selected
// setFeedDir() switches what /feed serves, which is how the test moves from X+1 to X+2.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join } from 'node:path'

export const IT_PORT = Number(process.env.MOSS_IT_PORT || 47613)
export const IT_HOST = '127.0.0.1'
export const itFeedUrl = (port = IT_PORT) => `http://${IT_HOST}:${port}/feed/`
export const itFilesUrl = (port = IT_PORT) => `http://${IT_HOST}:${port}/files/`

function send(res, status, headers = {}, body) {
  res.writeHead(status, headers)
  res.end(body)
}

export function startUpdateServer({ filesDir, feedDir, port = IT_PORT, log = () => {} }) {
  let currentFeedDir = feedDir
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${IT_HOST}`)
    const [, area, rawName] = /^\/(files|feed)\/([^/]+)$/.exec(url.pathname) ?? []
    const name = rawName ? decodeURIComponent(rawName) : ''
    if (!area || !name || name !== basename(name) || name.startsWith('.')) return send(res, 404)
    const path = join(area === 'files' ? filesDir : currentFeedDir, name)
    if (!existsSync(path) || !statSync(path).isFile()) {
      log(`${req.method} ${url.pathname} 404`)
      return send(res, 404)
    }
    const size = statSync(path).size
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    requests.push({ path: url.pathname, range: req.headers.range ?? null })
    if (range) {
      const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1])
      const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start > end || start >= size) return send(res, 416, { 'Content-Range': `bytes */${size}` })
      log(`${req.method} ${url.pathname} 206 ${start}-${end}/${size}`)
      res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' })
      if (req.method === 'HEAD') return res.end()
      return createReadStream(path, { start, end }).pipe(res)
    }
    log(`${req.method} ${url.pathname} 200 ${size}`)
    res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Content-Type': name.endsWith('.json') || name.endsWith('.sig') ? 'application/json' : 'application/octet-stream', 'Cache-Control': 'no-store' })
    if (req.method === 'HEAD') return res.end()
    createReadStream(path).pipe(res)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, IT_HOST, () => {
      resolve({
        port: server.address().port,
        requests,
        setFeedDir(dir) { currentFeedDir = dir },
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()) }),
      })
    })
  })
}

const fs = require('fs')
const http = require('http')
const path = require('path')

const PAGE = path.join(__dirname, '..', 'public', 'index.html')
const MAX_BODY = 64 * 1024
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' https://mc-heads.net; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff'
}

// Blocks other websites and DNS rebinding from reaching the accounts through your browser.
function isAllowedRequest ({ method, headers }, port) {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`]
  if (!allowed.includes(headers.host)) return false
  if (headers.origin && !allowed.includes(headers.origin.replace(/^http:\/\//, ''))) return false
  if (method === 'GET') return true
  return !!headers.origin && (headers['content-type'] ?? '').startsWith('application/json')
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Request too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function actions (manager, quit) {
  return {
    quit: () => quit(),
    addAccount: () => { manager.addAccount() }, // finishes later; progress reaches the page through summary()
    removeAccount: b => manager.removeAccount(b.id),
    addServer: b => manager.addServer(b.accountId, b.address, b.autoConnect),
    removeServer: b => manager.removeServer(b.id),
    setAutoConnect: b => manager.setAutoConnect(b.id, b.value),
    connect: b => manager.connect(b.id),
    disconnect: b => manager.disconnect(b.id),
    send: b => manager.send(b.id, b.text),
    runGroup: b => manager.runGroup(b.address, b.text),
    runAll: b => manager.runAll(b.address),
    setButtons: b => manager.setButtons(b.address, b.buttons),
    setCheckAddress: b => manager.setCheckAddress(b.address, b.value),
    setLobbyCommand: b => manager.setLobbyCommand(b.address, b.value),
    click: b => manager.click(b.id, b.slot, b.button),
    closeMenu: b => manager.closeMenu(b.id),
    selectHotbar: b => manager.selectHotbar(b.id, b.slot),
    useItem: b => manager.useItem(b.id),
    control: b => manager.control(b.id, b.key, b.state),
    look: b => manager.look(b.id, b.yaw, b.pitch)
  }
}

function startServer (manager, port, quit) {
  const routes = actions(manager, quit)
  const clients = new Set()
  let pending = new Set()
  let flush = null

  // Coalesced, and idle with no page open, so walking bots don't cost anything.
  manager.on('changed', id => {
    if (!clients.size) return
    pending.add(id ?? '')
    flush ??= setTimeout(() => {
      const data = `data: ${JSON.stringify([...pending])}\n\n`
      pending = new Set()
      flush = null
      for (const res of clients) res.write(data)
    }, 200)
  })

  const server = http.createServer(async (req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { ...HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body ?? {}))
    }
    if (!isAllowedRequest(req, port)) return json(403, { error: 'Forbidden' })
    const url = new URL(req.url, 'http://localhost')
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(fs.readFileSync(PAGE))
      }
      if (req.method === 'GET' && /^\/cat-(cream|tabby)\.png$/.test(url.pathname)) {
        res.writeHead(200, { ...HEADERS, 'Content-Type': 'image/png' })
        return res.end(fs.readFileSync(path.join(path.dirname(PAGE), url.pathname)))
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
        res.write(': connected\n\n')
        clients.add(res)
        return req.on('close', () => {
          clients.delete(res)
          if (!clients.size) manager.releaseControls() // don't keep walking after the page is gone
        })
      }
      if (req.method === 'GET' && url.pathname === '/api/summary') return json(200, manager.summary())
      if (req.method === 'GET' && url.pathname === '/api/groups') return json(200, manager.groups())
      if (req.method === 'GET' && url.pathname === '/api/detail') return json(200, manager.detail(url.searchParams.get('id')))
      const match = /^\/api\/action\/(\w+)$/.exec(url.pathname)
      if (req.method === 'POST' && match && Object.hasOwn(routes, match[1])) {
        return json(200, await routes[match[1]](await readJson(req)))
      }
      json(404, { error: 'Not found' })
    } catch (err) {
      json(400, { error: err.message })
    }
  })
  server.listen(port, '127.0.0.1')
  return server
}

module.exports = { startServer, isAllowedRequest }

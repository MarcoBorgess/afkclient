const fs = require('fs')
const http = require('http')
const path = require('path')

const PUBLIC = path.join(__dirname, '..', 'public')
const MAX_BODY = 64 * 1024
const HEARTBEAT = 30000 // proxies close a stream that stays silent for too long
const COOKIE = 'afk_session'
const COOKIE_LIFE = 30 * 24 * 3600
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' https://mc-heads.net; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
}

// Blocks other websites from acting with a logged-in browser. GETs change nothing.
function isAllowedRequest ({ method, headers }, allowedHosts) {
  if (method === 'GET') return true
  if (!headers.origin || !(headers['content-type'] ?? '').startsWith('application/json')) return false
  return allowedHosts.includes(headers.origin.replace(/^https?:\/\//, '').toLowerCase())
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

function actions (manager) {
  return {
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

function adminActions (users, userId) {
  return {
    createUser: b => users.create(b.name, b.password, b.maxAccounts),
    setUserMax: b => users.setMaxAccounts(b.id, b.maxAccounts),
    setUserPassword: b => users.setPassword(b.id, b.password),
    removeUser: b => users.remove(b.id, userId)
  }
}

function startServer (users, { port, host = '127.0.0.1', allowedHosts, secure = false }) {
  const clients = new Map() // open /events stream -> { token, userId }
  const pending = new Map() // userId -> changed connection ids
  let flush = null

  const streamsOf = userId => [...clients].filter(([, c]) => c.userId === userId).map(([res]) => res)

  const dropEnded = () => {
    for (const [res, { token }] of clients) {
      if (!users.session(token)) res.end()
    }
  }

  // Coalesced, and idle with no page open, so walking bots don't cost anything.
  users.on('changed', (userId, id) => {
    if (!streamsOf(userId).length) return
    if (!pending.has(userId)) pending.set(userId, new Set())
    pending.get(userId).add(id ?? '')
    flush ??= setTimeout(() => {
      for (const [user, ids] of pending) {
        const data = `data: ${JSON.stringify([...ids])}\n\n`
        for (const res of streamsOf(user)) res.write(data)
      }
      pending.clear()
      flush = null
    }, 200)
  })

  setInterval(() => {
    dropEnded()
    for (const res of clients.keys()) res.write(': ping\n\n')
  }, HEARTBEAT).unref()

  const server = http.createServer(async (req, res) => {
    const json = (code, body, headers = {}) => {
      res.writeHead(code, { ...HEADERS, 'Content-Type': 'application/json', ...headers })
      res.end(JSON.stringify(body ?? {}))
    }
    const file = (name, type) => {
      res.writeHead(200, { ...HEADERS, 'Content-Type': type })
      res.end(fs.readFileSync(path.join(PUBLIC, name)))
    }
    if (!isAllowedRequest(req, allowedHosts)) return json(403, { error: 'Forbidden' })
    const url = new URL(req.url, 'http://localhost')
    const cookie = (`Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`)
    try {
      if (req.method === 'GET' && url.pathname === '/login') return file('login.html', 'text/html; charset=utf-8')
      if (req.method === 'GET' && /^\/cat-(cream|tabby)\.png$/.test(url.pathname)) return file(url.pathname.slice(1), 'image/png')
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const { name, password } = await readJson(req)
        const token = await users.login(name, password)
        return json(200, {}, { 'Set-Cookie': `${COOKIE}=${token}; Max-Age=${COOKIE_LIFE}; ${cookie}` })
      }

      const token = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`).exec(req.headers.cookie ?? '')?.[1]
      const session = users.session(token)
      if (!session) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(302, { ...HEADERS, Location: '/login' })
          return res.end()
        }
        return json(401, { error: 'Log in first' })
      }
      const { userId } = session
      const user = users.user(userId)
      const manager = users.manager(userId)

      if (req.method === 'GET' && url.pathname === '/') return file('index.html', 'text/html; charset=utf-8')
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' })
        res.write(': connected\n\n')
        clients.set(res, { token, userId })
        return req.on('close', () => {
          clients.delete(res)
          if (!streamsOf(userId).length) users.manager(userId)?.releaseControls() // don't keep walking after the page is gone
        })
      }
      if (req.method === 'GET' && url.pathname === '/api/me') return json(200, { id: user.id, name: user.name, admin: !!user.admin })
      if (req.method === 'GET' && url.pathname === '/api/summary') return json(200, manager.summary())
      if (req.method === 'GET' && url.pathname === '/api/groups') return json(200, manager.groups())
      if (req.method === 'GET' && url.pathname === '/api/detail') return json(200, manager.detail(url.searchParams.get('id')))
      if (req.method === 'GET' && url.pathname === '/api/maps') return json(200, manager.maps(url.searchParams.get('id')))
      if (req.method === 'GET' && url.pathname === '/api/users') {
        return user.admin ? json(200, users.overview()) : json(403, { error: 'Forbidden' })
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        users.logout(token)
        dropEnded()
        return json(200, {}, { 'Set-Cookie': `${COOKIE}=; Max-Age=0; ${cookie}` })
      }
      if (req.method === 'POST' && url.pathname === '/api/password') {
        const { current, next } = await readJson(req)
        await users.changePassword(userId, current, next)
        dropEnded()
        return json(200)
      }
      const match = /^\/api\/action\/(\w+)$/.exec(url.pathname)
      if (req.method === 'POST' && match) {
        const admin = adminActions(users, userId)
        if (Object.hasOwn(admin, match[1])) {
          if (!user.admin) return json(403, { error: 'Forbidden' })
          const result = await admin[match[1]](await readJson(req))
          dropEnded()
          return json(200, result)
        }
        const routes = actions(manager)
        if (Object.hasOwn(routes, match[1])) return json(200, await routes[match[1]](await readJson(req)))
      }
      json(404, { error: 'Not found' })
    } catch (err) {
      json(err.status ?? 400, { error: err.message })
    }
  })
  server.listen(port, host)
  return server
}

module.exports = { startServer, isAllowedRequest }

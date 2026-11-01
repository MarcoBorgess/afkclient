// Run with: node test/selfcheck.js
// Uses a local fake 1.21.11 server and a temp folder. Needs no Microsoft account or real server.
const assert = require('assert')
const crypto = require('crypto')
const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const mc = require('minecraft-protocol')
const nbt = require('prismarine-nbt')
const { computeChatChecksum } = require('minecraft-protocol/src/datatypes/checksums')
const { Manager, VERSION, belowShown, blocksReconnect, fillAmounts, parseSteps, serverName, showsAddress, chatLine, toSignedByte, windowChecksum, isNetworkError, nextDelay, parseAddress } = require('../src/bots')
const { isAllowedRequest, startServer } = require('../src/server')
const { createTokenStore } = require('../src/tokenCache')
const { Users } = require('../src/users')

const PORT = 25598
const WEB_PORT = 25597
const TOKEN_KEY = 'a-test-key-with-at-least-32-characters'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until (what, test, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return
    await wait(50)
  }
  throw new Error('Timed out waiting for: ' + what)
}

function checksumOrder () {
  const sig = n => ({ signature: Buffer.from([n, n + 1, n + 2]) })
  const [a, b, c, d] = [sig(1), sig(40), sig(90), sig(200)]
  const wrapped = Object.assign([d, b, c], { capacity: 3, offset: 1 }) // d overwrote a: oldest is b
  assert.equal(windowChecksum(wrapped), computeChatChecksum([b, c, d]))
  assert.notEqual(computeChatChecksum([d, b, c]), computeChatChecksum([b, c, d]), 'test needs an order-sensitive case')
  const notFull = Object.assign([a, b], { capacity: 20, offset: 2 })
  assert.equal(windowChecksum(notFull), computeChatChecksum([a, b]))
  const empty = Object.assign([], { capacity: 20, offset: 0 })
  assert.equal(windowChecksum(empty), 1)
}

function signedCommandChecksum () {
  const serializer = mc.createSerializer({ state: 'play', version: VERSION, isServer: false })
  for (const checksum of [0, 127, 128, 187, 255]) {
    const signed = toSignedByte(checksum)
    assert(signed >= -128 && signed <= 127)
    const buffer = serializer.createPacketBuffer({
      name: 'chat_command_signed',
      params: { command: 'r hi', timestamp: 0n, salt: 0n, argumentSignatures: [], messageCount: 0, acknowledged: Buffer.alloc(3), checksum: signed }
    })
    assert.equal(buffer.at(-1), checksum, 'same byte on the wire')
  }
}

function rules () {
  const says = (text, unsigned) => ({ toString: () => text, unsigned: unsigned && { toString: () => unsigned } })
  assert.equal(chatLine(says('hi', '[VIP] Bob » hi'), 'Bob'), '[VIP] Bob » hi', 'full line wins')
  assert.equal(chatLine(says('hi'), 'Bob'), 'Bob: hi', 'name added when missing')
  assert.equal(chatLine(says('<Bob> hi'), 'Bob'), '<Bob> hi', 'name not doubled')
  assert.equal(chatLine(says('Server restarting'), null), 'Server restarting', 'system line')
  assert.equal(nextDelay(5000), 10000)
  assert.equal(nextDelay(300000), 300000)
  assert(blocksReconnect('You logged in from another location'))
  assert(blocksReconnect('{"translate":"multiplayer.disconnect.duplicate_login"}'))
  assert(blocksReconnect('ʏᴏᴜ ᴀʀᴇ ʙᴀɴɴᴇᴅ'), 'small caps text')
  assert(!blocksReconnect('Server restarting'))
  assert(isNetworkError({ code: 'ECONNREFUSED' }))
  assert(isNetworkError({ cause: { code: 'ENOTFOUND' } }))
  assert(!isNetworkError(new Error('Forbidden')))
  assert.deepEqual(parseAddress('Play.Example.com'), { host: 'play.example.com', port: 25565 })
  assert.deepEqual(parseAddress('a.b:1234'), { host: 'a.b', port: 1234 })
  for (const bad of ['', 'a b', 'a:99999', 'a:b', 'http://a']) assert.throws(() => parseAddress(bad), bad)
}

function groupRules () {
  const sidebar = { title: 'FARMING', lines: ['┃ ᴘᴜʀꜱᴇ 50.00k · 637', '┃ ꜱʜᴀʀᴅꜱ 401 (04:45)', '┃ ᴄᴏʙʙʟᴇ ⓒ11', '┃ ᴛᴏᴋᴇɴꜱ 0', 'play.cobblestone.gg'].map(text => ({ text, number: '' })) }
  const fill = text => fillAmounts(text, sidebar).command
  assert.equal(fill('/paygems {purse.2} p'), '/paygems 637 p')
  assert.equal(fill('/pay {purse} p'), '/pay 49.99k p', 'rounded value goes one step down')
  assert.equal(fill('/payshards {shards} p'), '/payshards 401 p', 'a timer after the number is ignored')
  assert.equal(fill('/paycobble {COBBLE} p'), '/paycobble 11 p', 'symbol before the number')
  assert(fillAmounts('{tokens}', sidebar).nothing)
  assert.throws(() => fill('{gems}'), /not on the scoreboard/)
  assert.throws(() => fill('{purse.3}'), /not on the scoreboard/)
  assert.throws(() => fillAmounts('{purse}', null), /not on the scoreboard/)
  for (const [shown, sent] of [['2.8k', '2.7k'], ['1k', '0.9k'], ['2k', '1k'], ['1,234', '1234'], ['80', '80']]) {
    const [, digits, suffix] = /([\d.,]+)([a-z]*)/.exec(shown)
    assert.equal(belowShown([shown, digits, suffix]), sent)
  }
  const board = (title, ...lines) => ({ title, lines: lines.map(text => ({ text, number: '' })) })
  assert.equal(serverName(sidebar), 'Cobble', 'the real Cobblestone board')
  assert.equal(serverName(board('MINEHUT', 'Type /link to', 'link your account.', 'Players: 5448')), 'Minehut')
  assert.equal(serverName(board('ᴍɪɴᴇʜᴜᴛ')), 'Minehut', 'small caps')
  assert.equal(serverName(board('Hi', 'ᴘʟᴀʏ.ᴇxᴀᴍᴘʟᴇ.ɴᴇᴛ')), 'Example', 'small caps address')
  assert.equal(serverName(board('Hi', 'techmines.minehut.gg')), 'Techmines', 'a server on a hosting domain')
  assert.equal(serverName(board('Hi', 'play.minehut.gg')), 'Minehut', 'the host itself')
  assert.equal(serverName(board('Hi', 'discord.gg', 'mc.foo.com')), 'Foo')
  assert.equal(serverName(board('Hi', 'mc.foo.com', 'discord.gg')), 'Foo', 'a link is not the server')
  assert.equal(serverName(board('SKYWARS', 'Level 1.5x', 'Money 7.90k')), 'SKYWARS', 'numbers are not addresses')
  assert.equal(serverName(null), '')
  assert(showsAddress(sidebar, 'play.cobblestone.gg'))
  assert(!showsAddress(sidebar, 'lobby.minehut.gg'))
  assert(!showsAddress(null, 'play.cobblestone.gg'))
  assert.deepEqual(parseSteps('/rewards\n\nclick 2 minecraft:chest_minecart\nclick all diamond\nclose').map(s => s.type), ['send', 'click', 'clickAll', 'close'])
  assert.throws(() => parseSteps('click diamond'), /click <slot>/)
  assert.throws(() => parseSteps('  \n'), /Nothing to run/)
}

function requestChecks () {
  const req = (method, headers) => ({ method, headers })
  const hosts = ['https://afk.example.com']
  const json = 'application/json'
  const origin = 'https://afk.example.com'
  assert(isAllowedRequest(req('GET', {}), hosts))
  assert(isAllowedRequest(req('POST', { origin, 'content-type': json }), hosts))
  assert(!isAllowedRequest(req('POST', { origin: 'https://evil.com', 'content-type': json }), hosts), 'other website')
  assert(!isAllowedRequest(req('POST', { origin: 'https://afk.example.com.evil.com', 'content-type': json }), hosts), 'lookalike website')
  assert(!isAllowedRequest(req('POST', { origin: 'http://afk.example.com', 'content-type': json }), hosts), 'plain http')
  assert(!isAllowedRequest(req('POST', { 'content-type': json }), hosts), 'no origin')
  assert(!isAllowedRequest(req('POST', { origin, 'content-type': 'text/plain' }), hosts), 'form post')
}

async function tokens (dir) {
  const store = createTokenStore(dir, TOKEN_KEY)
  const cache = store.factory({ username: 'acct', cacheName: 'live' })
  assert.deepEqual(await cache.getCached(), {})
  await cache.setCachedPartial({ secret: 'super-secret-token' })
  const [file] = fs.readdirSync(dir)
  assert(!Buffer.from(fs.readFileSync(path.join(dir, file), 'utf8'), 'base64').includes('super-secret-token'), 'token stored in plain text')
  const fresh = createTokenStore(dir, TOKEN_KEY).factory({ username: 'acct', cacheName: 'live' })
  assert.deepEqual(await fresh.getCached(), { secret: 'super-secret-token' })
  const wrongKey = createTokenStore(dir, TOKEN_KEY + 'x').factory({ username: 'acct', cacheName: 'live' })
  assert.deepEqual(await wrongKey.getCached(), {}, 'another key reads nothing')
  await store.remove('acct')
  assert.equal(fs.readdirSync(dir).length, 0)
}

async function multiUser (dataDir) {
  const options = { dataDir, tokenKey: TOKEN_KEY, adminName: 'Boss', adminPassword: 'boss-password', allowedServers: ['*.example.com', 'exact.test'] }
  assert.throws(() => new Users({ dataDir, tokenKey: TOKEN_KEY }), /ADMIN_USER/, 'first start needs an admin')
  const uuids = ['uuid-1', 'uuid-2', 'uuid-3', 'uuid-1']
  class FakeFlow {
    getMinecraftJavaToken () {
      const id = uuids.shift()
      return Promise.resolve({ profile: { id, name: 'Player' + id.slice(-1) } })
    }
  }
  const users = new Users({ ...options, managerOptions: { flow: FakeFlow } })
  const host = `127.0.0.1:${WEB_PORT}`
  const server = startServer(users, { port: WEB_PORT, allowedHosts: [host] })
  await new Promise(resolve => server.on('listening', resolve))

  const call = async (method, url, cookie, body) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { origin: `http://${host}`, 'content-type': 'application/json' } : {}) }
    const res = await fetch(`http://${host}${url}`, { method, headers, redirect: 'manual', body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined })
    const text = await res.text()
    let data = text
    try { data = JSON.parse(text) } catch {}
    return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0], setCookie: res.headers.get('set-cookie') }
  }
  const login = async (name, password) => (await call('POST', '/api/login', null, { name, password })).cookie

  // Nothing but the login page without a session.
  const home = await call('GET', '/')
  assert.equal(home.status, 302)
  assert.equal((await call('GET', '/login')).status, 200)
  for (const url of ['/api/summary', '/api/groups', '/api/users', '/events', '/api/detail?id=x']) assert.equal((await call('GET', url)).status, 401, url)
  assert.equal((await call('POST', '/api/action/addAccount')).status, 401)
  assert.equal((await call('POST', '/api/login', null, { name: 'boss', password: 'wrong-password' })).status, 401)
  assert.equal((await call('POST', '/api/login', null, { name: 'nobody', password: 'wrong-password' })).status, 401)
  assert.equal((await fetch(`http://${host}/api/login`, { method: 'POST', headers: { origin: 'https://evil.com', 'content-type': 'application/json' }, body: '{}' })).status, 403)

  const boss = await login('BOSS', 'boss-password')
  assert(boss, 'names ignore case')
  const signed = await call('POST', '/api/login', null, { name: 'boss', password: 'boss-password' })
  assert(/HttpOnly/.test(signed.setCookie) && /SameSite=Lax/.test(signed.setCookie))
  assert.equal((await call('GET', '/api/me', boss)).data.admin, true)
  users.outgoingIp = '203.0.113.5'
  assert.equal((await call('GET', '/api/me', boss)).data.ip, '203.0.113.5')
  assert.equal(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8').includes('boss-password'), false, 'password stored in plain text')

  // Admin only.
  const admin = (name, body) => call('POST', '/api/action/' + name, boss, body)
  assert.match((await admin('createUser', { name: 'a b', password: 'long-enough', maxAccounts: 1 })).data.error, /username/)
  assert.match((await admin('createUser', { name: 'ann', password: 'short', maxAccounts: 1 })).data.error, /password/)
  assert.match((await admin('createUser', { name: 'ann', password: 'long-enough', maxAccounts: -1 })).data.error, /limit/)
  assert.equal((await admin('createUser', { name: 'ann', password: 'ann-password', maxAccounts: 1 })).status, 200)
  assert.equal((await admin('createUser', { name: 'bob', password: 'bob-password', maxAccounts: 2 })).status, 200)
  assert.match((await admin('createUser', { name: 'ANN', password: 'ann-password', maxAccounts: 1 })).data.error, /already exists/)
  const ann = await login('ann', 'ann-password')
  const bob = await login('bob', 'bob-password')
  assert.equal((await call('GET', '/api/me', ann)).data.admin, false)
  assert.equal((await call('GET', '/api/me', ann)).data.ip, undefined, 'only the admin sees the IP')
  assert.equal((await call('GET', '/api/users', ann)).status, 403)
  for (const name of ['createUser', 'setUserMax', 'setUserPassword', 'removeUser']) assert.equal((await call('POST', '/api/action/' + name, ann, {})).status, 403, name)
  assert.equal((await call('POST', '/api/action/quit', boss)).status, 404, 'nobody stops the app from the page')

  // Old hashes keep working and get replaced at login.
  const bossUser = users.list.find(u => u.name === 'boss')
  const oldHash = crypto.scryptSync('boss-password', 'oldsalt', 64).toString('hex')
  Object.assign(bossUser, { salt: 'oldsalt', hash: oldHash })
  delete bossUser.cost
  assert(await login('boss', 'boss-password'), 'old hash accepted')
  assert(bossUser.cost > 16384 && bossUser.hash !== oldHash, 'old hash replaced')
  assert(await login('boss', 'boss-password'), 'new hash accepted')

  // Limits and sign-in stay per user; one Minecraft account has one user.
  const summary = async cookie => (await call('GET', '/api/summary', cookie)).data
  const add = async cookie => {
    const result = await call('POST', '/api/action/addAccount', cookie)
    await wait(50)
    return result
  }
  assert.equal((await add(ann)).status, 200)
  assert.equal((await summary(ann)).accounts[0].name, 'Player1')
  assert.equal((await summary(ann)).maxAccounts, 1)
  assert.match((await add(ann)).data.error, /limit is 1/)
  assert.equal((await add(bob)).status, 200)
  assert.equal((await summary(bob)).accounts[0].name, 'Player2')
  assert.equal((await admin('setUserMax', { id: users.overview().find(u => u.name === 'bob').id, maxAccounts: 3 })).status, 200)
  assert.equal((await add(bob)).status, 200)
  assert.equal((await summary(bob)).accounts.length, 2)
  await add(bob)
  assert.match((await summary(bob)).signIn.error, /already added/, 'account already on another user')
  assert.equal((await summary(bob)).accounts.length, 2)

  // Another user's ids and settings don't exist for you.
  const annAccount = (await summary(ann)).accounts[0]
  const bobAccount = (await summary(bob)).accounts[0]
  assert.equal((await call('POST', '/api/action/addServer', bob, { accountId: annAccount.id, address: 'x.example.com' })).status, 400)
  assert.equal((await call('POST', '/api/action/removeAccount', bob, { id: annAccount.id })).status, 400)
  assert.equal((await call('POST', '/api/action/addServer', ann, { accountId: annAccount.id, address: 'shared.example.com', autoConnect: false })).status, 200)
  assert.equal((await call('POST', '/api/action/addServer', bob, { accountId: bobAccount.id, address: 'shared.example.com', autoConnect: false })).status, 200)
  const serverId = (await summary(ann)).accounts[0].servers[0].id
  for (const name of ['connect', 'disconnect', 'removeServer', 'send', 'closeMenu']) assert.equal((await call('POST', '/api/action/' + name, bob, { id: serverId, text: 'x' })).status, 400, name)
  assert.equal((await call('GET', '/api/detail?id=' + serverId, bob)).status, 400)
  assert.equal((await call('GET', '/api/detail?id=' + serverId, ann)).status, 200)
  const address = 'shared.example.com:25565'
  assert.equal((await call('POST', '/api/action/setLobbyCommand', ann, { address, value: '/join ann' })).status, 200)
  assert.equal((await summary(bob)).accounts[0].servers[0].lobbyCommand, '', 'lobby command per user')
  // Addresses from a request are only keys, never a way into every object in the app.
  for (const name of ['setLobbyCommand', 'setCheckAddress']) {
    for (const bad of ['__proto__', 'constructor', 'nope:1']) {
      const refused = await call('POST', '/api/action/' + name, bob, { address: bad, value: '/pay bob 999' })
      assert.match(refused.data.error, /Unknown server/, bad)
    }
  }
  assert.match((await call('POST', '/api/action/runAll', bob, { address: '__proto__' })).data.error, /Unknown server/)
  assert.equal(({}).lobbyCommand, undefined, 'nothing added to every object')
  assert.equal(({}).checkAddress, undefined, 'nothing added to every object')
  assert.equal((await summary(ann)).accounts[0].servers[0].lobbyCommand, '/join ann', 'own setting intact')

  // Only listed servers: no internal addresses, no lookalikes.
  for (const bad of ['127.0.0.1:80', '169.254.169.254:80', 'localhost:22', '10.0.0.1:6379', 'evil.com', 'example.com.evil.com', 'notexample.com', 'exact.test.evil.com']) {
    assert.match((await call('POST', '/api/action/addServer', bob, { accountId: bobAccount.id, address: bad })).data.error, /allowed server list/, bad)
  }
  assert.equal((await call('POST', '/api/action/addServer', bob, { accountId: bobAccount.id, address: 'exact.test' })).status, 200)
  for (let i = 0; i < 8; i++) assert.equal((await call('POST', '/api/action/addServer', bob, { accountId: bobAccount.id, address: `s${i}.example.com` })).status, 200)
  assert.match((await call('POST', '/api/action/addServer', bob, { accountId: bobAccount.id, address: 'one-more.example.com' })).data.error, /10 servers/)
  const outsideId = users.overview().find(u => u.name === 'bob').id
  const bobServers = users.manager(outsideId).config.accounts[0].servers
  bobServers[0].host = 'old.not-listed.net' // saved before the list existed
  assert.equal((await call('POST', '/api/action/connect', bob, { id: bobServers[0].id })).status, 200)
  assert.equal(users.manager(outsideId).conns.get(bobServers[0].id).status, 'offline')
  assert.match(users.manager(outsideId).conns.get(bobServers[0].id).message, /allowed server list/)
  bobServers[0].host = 'shared.example.com'

  const annManager = users.manager(users.overview().find(u => u.name === 'ann').id)
  const bobManager = users.manager(users.overview().find(u => u.name === 'bob').id)
  annManager.setButtons(address, [{ label: 'Ann', steps: '/ann' }])
  assert.deepEqual(bobManager.settings(address).buttons, [], 'buttons per user')

  // Passwords: the old one and its sessions stop working.
  assert.match((await call('POST', '/api/password', bob, { current: 'wrong-password', next: 'bob-password-2' })).data.error, /current password/)
  assert.match((await call('POST', '/api/password', bob, { current: 'bob-password', next: 'short' })).data.error, /password/)
  assert.equal((await call('POST', '/api/password', bob, { current: 'bob-password', next: 'bob-password-2' })).status, 200)
  assert.equal((await call('GET', '/api/me', bob)).status, 401)
  assert.equal((await call('POST', '/api/login', null, { name: 'bob', password: 'bob-password' })).status, 401)
  const bob2 = await login('bob', 'bob-password-2')
  assert(bob2)
  assert.equal((await call('POST', '/api/logout', bob2)).status, 200)
  assert.equal((await call('GET', '/api/me', bob2)).status, 401)

  // Wrong passwords never lock anyone out, and the slow hash stays limited to two at a time.
  for (let i = 0; i < 8; i++) assert.equal((await call('POST', '/api/login', null, { name: 'ann', password: 'wrong-password' })).status, 401)
  assert(await login('ann', 'ann-password'), 'still able to log in')
  const parallel = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/api/login', null, { name: 'ann', password: 'wrong-password' })))
  assert.equal(parallel.filter(result => result.status === 401).length, 2)
  assert.equal(parallel.filter(result => result.status === 429).length, 10)
  assert(await login('ann', 'ann-password'), 'the limit ends with the requests')

  // A bad request target gets an answer instead of leaving the connection open.
  const answer = await new Promise(resolve => {
    const socket = net.connect(WEB_PORT, '127.0.0.1', () => socket.write(`GET // HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
    socket.once('data', chunk => { socket.destroy(); resolve(chunk.toString()) })
    setTimeout(() => { socket.destroy(); resolve('no answer') }, 5000)
  })
  assert.match(answer, /^HTTP\/1\.1 400/)

  // Hosted: the cookie cannot be set by a neighbour site, and only https origins count.
  const hosted = startServer(users, { port: WEB_PORT + 1, allowedHosts: ['afk.example.com'], secure: true })
  await new Promise(resolve => hosted.on('listening', resolve))
  const hostedLogin = origin => fetch(`http://127.0.0.1:${WEB_PORT + 1}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'boss', password: 'boss-password' }) })
  assert.equal((await hostedLogin('http://afk.example.com')).status, 403)
  const hostedCookie = (await hostedLogin('https://afk.example.com')).headers.get('set-cookie')
  assert.match(hostedCookie, /^__Host-afk_session=[0-9a-f]+;.*Path=\/; HttpOnly; SameSite=Lax; Secure$/)
  const hostedMe = cookie => fetch(`http://127.0.0.1:${WEB_PORT + 1}/api/me`, { headers: { cookie } })
  assert.equal((await hostedMe(hostedCookie.split(';')[0])).status, 200)
  assert.equal((await hostedMe(hostedCookie.split(';')[0].replace('__Host-', ''))).status, 401, 'a cookie without the prefix is ignored')
  hosted.closeAllConnections()
  hosted.close()

  // Everything survives a restart, and a removed user leaves nothing behind.
  const again = new Users({ ...options, managerOptions: { flow: FakeFlow } })
  assert.deepEqual(again.overview().map(u => [u.name, u.accounts]), [['boss', 0], ['ann', 1], ['bob', 2]])
  assert.deepEqual(again.manager(again.overview()[1].id).settings(address).buttons, [{ label: 'Ann', steps: '/ann' }])
  const annId = users.overview().find(u => u.name === 'ann').id
  const bossId = users.overview().find(u => u.name === 'boss').id
  assert.match((await admin('removeUser', { id: bossId })).data.error, /yourself/)
  assert.equal((await admin('removeUser', { id: annId })).status, 200)
  assert.equal((await call('GET', '/api/me', ann)).status, 401)
  assert(!fs.existsSync(path.join(dataDir, 'users', annId)), 'saved logins deleted')
  server.closeAllConnections()
  server.close()
}

function fakeServer () {
  const data = require('minecraft-data')(VERSION)
  const clicks = []
  const chats = []
  const doubleMoves = { count: 0, seen: 0, ticks: 0 }
  const server = mc.createServer({ 'online-mode': false, port: PORT, version: VERSION, host: '127.0.0.1', registryCodec: data.loginPacket?.dimensionCodec })
  server.on('playerJoin', client => { // 'login' is too early: the client is still in the configuration phase
    client.on('error', () => {})
    const login = { ...data.loginPacket, entityId: client.id, levelType: 'default' }
    client.write('login', login)
    client.write('position', { teleportId: 1, x: 0, y: 64, z: 0, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {} })
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
    // Same rule as real servers: a second position before tick_end is a kick.
    let moved = false
    for (const name of ['position', 'position_look']) {
      client.on(name, () => {
        if (moved) doubleMoves.count++
        moved = true
        doubleMoves.seen++
      })
    }
    client.on('tick_end', () => { moved = false; doubleMoves.ticks++ })
    client.on('window_click', p => clicks.push(p))
    client.on('chat_command', p => chats.push('/' + p.command))
    client.on('chat_command_signed', p => chats.push('/' + p.command))
    client.on('chat_message', p => chats.push(p.message))
    client.write('system_chat', { content: nbt.comp({ text: nbt.string('hello from server') }), isActionBar: false })
    server.lastClient = client
  })
  return { server, clicks, chats, doubleMoves }
}

function openMenu (client) {
  client.write('open_window', { windowId: 3, inventoryType: 0, windowTitle: nbt.comp({ text: nbt.string('Rewards') }) })
  client.write('window_items', {
    windowId: 3,
    stateId: 1,
    items: Array.from({ length: 45 }, (_, i) => i === 4 ? { itemCount: 2, itemId: 1, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } : { itemCount: 0 }),
    carriedItem: { itemCount: 0 }
  })
}

// Real timings: the pay loop and the click gaps are the part most likely to misbehave.
async function rewardsAndPayments (manager, id, conn, server, address, clicks, chats) {
  const data = require('minecraft-data')(VERSION)
  const sc = server.lastClient
  const stack = name => ({ itemCount: 1, itemId: data.itemsByName[name].id, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] })
  // Same sizes as the real menus: 9 slots for /rewards (type 0), 45 for playtime (type 4).
  const show = (windowId, inventoryType, slots) => {
    sc.write('open_window', { windowId, inventoryType, windowTitle: nbt.comp({ text: nbt.string('Menu') }) })
    sc.write('window_items', { windowId, stateId: 1, items: Array.from({ length: inventoryType ? 81 : 45 }, (_, i) => slots[i] ? stack(slots[i]) : { itemCount: 0 }), carriedItem: { itemCount: 0 } })
  }
  const opened = name => show(3, 0, { 1: 'minecart', 2: name })
  const seen = clicks.length
  const steps = '/rewards\nclick 2 chest_minecart\nclick all diamond\nclose'
  sc.on('window_click', p => {
    if (p.windowId === 3 && p.slot === 2) show(4, 4, { 11: 'lime_stained_glass_pane', 15: 'diamond', 20: 'diamond', 30: 'gray_dye' })
    if (p.windowId === 4) sc.write('set_slot', { windowId: 4, stateId: 2, slot: p.slot, item: stack('lime_stained_glass_pane') })
  })
  const rewards = p => { if (p.command === 'rewards') opened(sc.claimed ? 'minecart' : 'chest_minecart') }
  sc.on('chat_command', rewards)
  sc.on('chat_command_signed', rewards)
  manager.runGroup(address, steps)
  await until('rewards claimed', () => !conn.running, 20000)
  assert.equal(conn.result, 'Clicked 2 diamond')
  assert.deepEqual(clicks.slice(seen).map(c => c.slot), [2, 15, 20], 'only the slot asked for, then each diamond once')
  assert.equal(manager.detail(id).menu, null, 'menu closed afterwards')
  sc.claimed = true
  manager.runGroup(address, steps)
  await until('nothing to claim', () => !conn.running, 20000)
  assert.equal(conn.result, 'Nothing to do: slot 2 is minecart')
  assert.equal(clicks.length, seen + 3, 'plain minecart is never clicked')

  const text = value => nbt.comp({ text: nbt.string(value) })
  const gems = value => sc.write('scoreboard_score', { itemName: 'purse', scoreName: 'side', value: 1, display_name: text('ᴘᴜʀꜱᴇ 1k · ' + value), number_format: 0 })
  sc.write('scoreboard_objective', { name: 'side', action: 0, displayText: text('Board'), type: 0 })
  sc.write('scoreboard_display_objective', { position: 1, name: 'side' })
  gems('2.8k')
  await until('balance on the scoreboard', () => manager.detail(id).sidebar?.lines.length)
  const pay = p => {
    if (p.command === 'paygems 2.7k main') gems('80')
    if (p.command === 'paygems 80 main') gems('0')
  }
  sc.on('chat_command', pay)
  sc.on('chat_command_signed', pay)
  manager.setButtons(address, [{ label: 'Gems', steps: '/paygems {purse.2} main' }])
  assert.equal(manager.groups()[0].buttons[0].label, 'Gems')
  assert.equal(manager.groups()[0].accounts[0].name, 'Tester')
  assert.throws(() => manager.setButtons(address, [{ label: 'x', steps: 'click nope' }]), /click <slot>/)
  manager.runGroup(address, manager.groups()[0].buttons[0].steps)
  await until('balance drained', () => !conn.running, 30000)
  assert.equal(conn.result, 'All sent in 2 payments')
  assert(chats.includes('/paygems 2.7k main') && chats.includes('/paygems 80 main'))
  gems('500')
  manager.runGroup(address, '/paygems {purse.2} main')
  await until('refused payment stops', () => !conn.running, 30000)
  assert.equal(conn.result, 'Stuck at 500: the payment changed nothing')

  manager.setButtons(address, [{ label: 'Bad', steps: '/x {nothere}' }, { label: 'Ok', steps: '/after' }, { label: 'Self', steps: '/pay tester' }])
  manager.runAll(address)
  await until('run all', () => !conn.running && conn.result.startsWith('Bad'), 20000)
  assert.equal(conn.result, 'Bad: {nothere} is not on the scoreboard · Ok: Done · Self: Skipped: named in the command')
  await until('button after a failed one', () => chats.includes('/after'))
  manager.setButtons(address, [])
  assert.throws(() => manager.runAll(address), /no buttons/)
}

async function endToEnd (dataDir) {
  const { server, clicks, chats, doubleMoves } = fakeServer()
  await new Promise(resolve => server.on('listening', resolve))
  const manager = new Manager({ dataDir, tokens: { factory: () => { throw new Error('unused') }, remove: async () => {} }, botOptions: { auth: 'offline', username: 'Tester' } })
  manager.config.accounts.push({ id: 'a1', name: 'Tester', uuid: 'u', servers: [] })
  manager.addServer('a1', `127.0.0.1:${PORT}`, true)
  const id = manager.config.accounts[0].servers[0].id
  const conn = manager.conns.get(id)

  manager.connect(id)
  await until('spawn', () => conn.status === 'online')
  await until('server chat line', () => conn.chat.some(c => c.text === 'hello from server'))
  await until('tick_end after a position', () => doubleMoves.seen > 0 && doubleMoves.ticks > 0)
  manager.addChat(conn, 'x'.repeat(5000))
  assert.equal(conn.chat.at(-1).text.length, 2000, 'long lines are cut')
  assert.equal(doubleMoves.count, 0, 'second position sent without tick_end')

  manager.send(id, '/daily')
  manager.send(id, 'hi all')
  const address = `127.0.0.1:${PORT}`
  assert.deepEqual(manager.runGroup('other.server:25565', '/elsewhere'), { started: 0 }, 'other servers are left alone')
  assert.deepEqual(manager.runGroup(address, '/everyone'), { started: 1 })
  await until('commands reach the server', () => ['/daily', 'hi all', '/everyone'].every(c => chats.includes(c)))
  await until('group run to finish', () => !conn.running)
  assert(!chats.includes('/elsewhere'))
  manager.runGroup(address, '/pay 5 tester')
  await until('skip report', () => conn.result?.startsWith('Skipped'))
  assert(!chats.includes('/pay 5 tester'), 'an account never pays itself')

  // Sidebar: order, custom labels, hidden numbers, team text, removals.
  const text = value => nbt.comp({ text: nbt.string(value) })
  const sc = server.lastClient
  assert.equal(manager.detail(id).sidebar, null)
  sc.write('scoreboard_objective', { name: 'side', action: 0, displayText: text('§aMy Board'), type: 0 })
  sc.write('scoreboard_display_objective', { position: 1, name: 'side' })
  sc.write('scoreboard_score', { itemName: 'kills', scoreName: 'side', value: 7 })
  sc.write('scoreboard_score', { itemName: 'hidden', scoreName: 'side', value: 9, display_name: text('Money: 5k'), number_format: 0 })
  sc.write('scoreboard_score', { itemName: 'gone', scoreName: 'side', value: 1 })
  sc.write('teams', { team: 't1', mode: 'add', name: text('t1'), flags: {}, nameTagVisibility: 'always', collisionRule: 'always', formatting: 0, prefix: text('Rank: '), suffix: text(' VIP'), players: ['§r'] })
  sc.write('scoreboard_score', { itemName: '§r', scoreName: 'side', value: 3, number_format: 0 })
  sc.write('reset_score', { entity_name: 'gone', objective_name: 'side' })
  await until('sidebar lines', () => manager.detail(id).sidebar?.lines.length === 3)
  assert.deepEqual(manager.detail(id).sidebar, {
    title: 'My Board',
    lines: [{ text: 'Money: 5k', number: '' }, { text: 'kills', number: '7' }, { text: 'Rank:  VIP', number: '' }]
  })

  // A map's picture, whole or in pieces; icon-only updates change nothing.
  const pixelsOf = map => Buffer.from(map.pixels, 'base64')
  const newest = () => manager.maps(id).loose
  sc.write('map', { itemDamage: 7, scale: 0, locked: true, columns: 128, rows: 128, x: 0, y: 0, data: Buffer.alloc(16384, 34) })
  await until('map picture', () => newest().length === 1)
  sc.write('map', { itemDamage: 7, scale: 0, locked: true, columns: 2, rows: 1, x: 10, y: 3, data: Buffer.from([50, 51]) })
  await until('map update', () => pixelsOf(newest()[0])[3 * 128 + 11] === 51)
  assert.equal(pixelsOf(newest()[0])[3 * 128 + 10], 50)
  assert.equal(pixelsOf(newest()[0])[3 * 128 + 12], 34, 'the rest stays')
  sc.write('map', { itemDamage: 7, scale: 0, locked: true, columns: 0 })
  for (let n = 1; n <= 4; n++) sc.write('map', { itemDamage: n, scale: 0, locked: true, columns: 1, rows: 1, x: 0, y: 0, data: Buffer.from([n]) })
  await until('newest maps', () => newest()[0]?.id === 4)
  assert.deepEqual(newest().map(m => m.id), [4, 3, 2, 1, 7], 'newest first')
  assert.equal(manager.maps(id).wall, null)
  for (let n = 10; n < 20; n++) sc.write('map', { itemDamage: n, scale: 0, locked: true, columns: 1, rows: 1, x: 0, y: 0, data: Buffer.from([n]) })
  await until('more maps', () => newest()[0]?.id === 19)

  // The captcha wall: 5 by 2 framed maps seen looking south, so higher x is on the left.
  const frameType = require('minecraft-data')(VERSION).entitiesByName.item_frame.id
  const mapItem = mapId => ({ itemCount: 1, itemId: require('minecraft-data')(VERSION).itemsByName.filled_map.id, addedComponentCount: 1, removedComponentCount: 0, components: [{ type: 'map_id', data: mapId }], removeComponents: [] })
  const hang = (entityId, x, y, direction, mapId) => {
    sc.write('spawn_entity', { entityId, objectUUID: '00000000-0000-0000-0000-' + String(entityId).padStart(12, '0'), type: frameType, x, y, z: 5.97, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, headPitch: 0, objectData: direction })
    sc.write('entity_metadata', { entityId, metadata: [{ key: 9, type: 'item_stack', value: mapItem(mapId) }] })
  }
  let tile = 10
  for (const y of [22, 21]) for (const x of [2, 1, 0, -1, -2]) hang(1000 + tile, x + 0.5, y + 0.5, 2, tile++)
  hang(1100, 40.5, 64.5, 4, 1) // a stray frame elsewhere must not stretch the picture
  await until('wall of maps', () => manager.maps(id).wall?.tiles.length === 10)
  const { wall, loose } = manager.maps(id)
  const place = tileId => { const t = wall.tiles.find(t => t.id === tileId); return [t.column, t.row] }
  assert.deepEqual([wall.columns, wall.rows], [5, 2])
  assert.deepEqual(place(10), [0, 0])
  assert.deepEqual(place(14), [4, 0])
  assert.deepEqual(place(19), [4, 1])
  assert(!loose.some(m => m.id === 10), 'a framed map is not shown twice')
  sc.write('entity_destroy', { entityIds: [1010] })
  await until('frame removed', () => manager.maps(id).wall.tiles.length === 9)

  // A deleted message must not wipe the tracking counters.
  const client = conn.bot._client
  const signature = Buffer.alloc(256, 7)
  client._lastSeenMessages.push(Buffer.alloc(256, 6))
  client._lastSeenMessages.push(signature)
  assert.equal(client._lastSeenMessages.pending, 2)
  client.emit('hide_message', { signature })
  assert.equal(client._lastSeenMessages.pending, 1)
  assert.equal(client._lastSeenMessages.offset, 2)
  assert.equal(client._lastSeenMessages[1], null)

  // Being moved to another server on the same connection starts chat tracking over.
  const respawned = new Promise(resolve => client.once('login', resolve))
  server.lastClient.write('login', { ...require('minecraft-data')(VERSION).loginPacket, entityId: server.lastClient.id })
  await respawned
  await until('tracking reset after a server switch', () => client._lastSeenMessages.offset === 0)
  assert.equal(client._lastSeenMessages.length, 0)
  assert.equal(client._lastSeenMessages.pending, 0)
  assert.equal(conn.status, 'online')
  assert.equal(manager.detail(id).sidebar, null, 'sidebar cleared by a server switch')
  assert.deepEqual(manager.maps(id), { wall: null, loose: [] }, 'maps cleared by a server switch')

  await rewardsAndPayments(manager, id, conn, server, address, clicks, chats)

  openMenu(server.lastClient)
  await until('menu to open', () => manager.detail(id).menu)
  const { menu } = manager.detail(id)
  assert.equal(menu.title, 'Rewards')
  assert(menu.slots[4], 'item appears in slot 4')
  await assert.rejects(manager.click(id, 9999, 'left'), /Invalid slot/)
  await assert.rejects(manager.click(id, 4, 'middle'), /Invalid click/)
  manager.click(id, 4, 'left').catch(() => {}) // the fake server doesn't confirm clicks
  await until('click reaches the server', () => clicks.some(c => c.slot === 4))
  manager.closeMenu(id)
  assert.equal(manager.detail(id).menu, null)

  assert.throws(() => manager.control(id, 'fly', true), /Invalid control/)
  manager.control(id, 'forward', true)
  manager.releaseControls()
  assert.equal(conn.bot.getControlState('forward'), false)

  // A restart reconnects by itself; the timer is shortened only for this test.
  conn.delay = 200
  server.lastClient.end('Server restarting')
  await until('reconnecting status', () => conn.status === 'reconnecting')
  await until('rejoin after restart', () => conn.status === 'online')

  // Mojang's login limit: wait long enough for it to clear instead of hammering it.
  conn.bot.emit('error', new Error('Response is not JSON. Status code: 429'))
  await until('rate limit noticed', () => conn.status === 'reconnecting')
  assert.match(conn.message, /too many logins/)
  assert(conn.retryAt - Date.now() > 100000, 'long wait after a 429')
  assert(conn.wanted, 'keeps trying')
  manager.connect(id)
  await until('online after the limit', () => conn.status === 'online')

  // Held in a captcha world: visible, answerable, and nothing else gets sent as the answer.
  const loginData = require('minecraft-data')(VERSION).loginPacket
  const world = name => server.lastClient.write('respawn', { worldState: { ...loginData.worldState, name }, copyMetadata: 0 })
  const captchaState = () => manager.summary().accounts[0].servers[0].captcha
  assert.equal(captchaState(), false)
  world('minecraft:captcha')
  await until('captcha noticed', () => captchaState())
  assert.equal(manager.detail(id).captcha, true)
  assert.equal(manager.groups()[0].accounts[0].captcha, true)
  assert.equal(manager.summary().accounts[0].servers[0].where, '', 'no server name while held')
  assert.equal(conn.status, 'online', 'still connected, chat has to work')
  assert.deepEqual(manager.runGroup(address, '/paygems 5 main'), { started: 0 }, 'a payment must not become the answer')
  const held = server.lastClient
  held.write('scoreboard_objective', { name: 'hub', action: 0, displayText: text('MINEHUT'), type: 0 })
  held.write('scoreboard_display_objective', { position: 1, name: 'hub' })
  manager.setLobbyCommand(address, '/join held')
  manager.setCheckAddress(address, true)
  const grace = manager.addressGrace
  manager.addressGrace = 300
  await wait(1500)
  assert(!chats.includes('/join held'), 'no lobby command in the captcha')
  assert.equal(conn.status, 'online', 'no reconnect in the captcha')
  manager.send(id, 'abc12')
  await until('the answer goes out', () => chats.includes('abc12'))
  manager.setCheckAddress(address, false)
  manager.setLobbyCommand(address, '')
  manager.addressGrace = grace
  world('minecraft:overworld')
  await until('out of the captcha', () => !captchaState())
  assert.deepEqual(manager.runGroup(address, '/free'), { started: 1 })
  await until('group commands work again', () => !conn.running && chats.includes('/free'))

  // A duplicate-login kick must leave real Minecraft alone.
  server.lastClient.write('kick_disconnect', { reason: nbt.comp({ translate: nbt.string('multiplayer.disconnect.duplicate_login') }) })
  await until('stop after duplicate login', () => conn.status === 'offline')
  const report = conn.chat.slice(-3).map(line => line.text)
  assert.match(report[0], /^\[client\] Lost the connection: Kicked/)
  assert.match(report[1], /^\[client\] Raw kick: .*duplicate_login/)
  assert.match(report[2], /^\[client\] Last packets: .*got:play:kick_disconnect/)
  assert(!/position|tick_end/.test(report[2]), 'movement would push out everything useful')
  assert.equal(conn.wanted, false)
  await wait(500)
  assert.equal(conn.status, 'offline', 'must stay offline')

  // Dropped in a lobby on the same connection: the scoreboard no longer shows the address.
  manager.connect(id)
  await until('connect for lobby check', () => conn.status === 'online')
  const lobby = server.lastClient
  lobby.write('scoreboard_objective', { name: 'hub', action: 0, displayText: text('MINEHUT'), type: 0 })
  lobby.write('scoreboard_display_objective', { position: 1, name: 'hub' })
  await until('lobby scoreboard', () => manager.detail(id).sidebar?.title === 'MINEHUT')
  assert.equal(manager.summary().accounts[0].servers[0].where, 'Minehut')
  await wait(1500)
  assert(!chats.includes('/join cobble'), 'no command until one is set')
  manager.setLobbyCommand(address, ' /join cobble ')
  await until('join from the lobby', () => chats.includes('/join cobble'))
  await wait(2500)
  assert.equal(chats.filter(c => c === '/join cobble').length, 1, 'not repeated every check')
  assert.equal(manager.summary().accounts[0].servers[0].lobbyCommand, '/join cobble')
  manager.setLobbyCommand(address, '')
  manager.addressGrace = 300
  await wait(1500)
  assert.equal(conn.status, 'online', 'off by default')
  manager.setCheckAddress(address, true)
  await until('lobby reconnect', () => conn.message === 'Server address not on the scoreboard')
  assert.equal(conn.wanted, true)
  manager.setCheckAddress(address, false)
  clearTimeout(conn.timer)
  manager.open(conn)
  await until('back online', () => conn.status === 'online')

  // A manual disconnect stays disconnected.
  manager.connect(id)
  await until('connect again', () => conn.status === 'online')
  manager.disconnect(id)
  await until('manual disconnect', () => conn.status === 'offline')
  await wait(500)
  assert.equal(conn.status, 'offline')

  // Config survives a restart and never holds tokens.
  const saved = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')
  assert(saved.includes(`127.0.0.1`) && !/token/i.test(saved))
  server.close()
}

async function main () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'afkclient-'))
  try {
    rules(); console.log('ok  reconnect rules and address parsing')
    checksumOrder(); console.log('ok  chat checksum order')
    signedCommandChecksum(); console.log('ok  signed command checksum')
    groupRules(); console.log('ok  scoreboard amounts and button steps')
    requestChecks(); console.log('ok  request checks')
    await tokens(path.join(root, 'tokens')); console.log('ok  encrypted token round trip')
    await multiUser(path.join(root, 'site')); console.log('ok  login, admin, account limits, users kept apart')
    await endToEnd(path.join(root, 'data')); console.log('ok  connect, chat, commands, menu click, controls, reconnect rules')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  process.exit(0)
}

main().catch(err => {
  console.error('FAILED:', err)
  process.exit(1)
})

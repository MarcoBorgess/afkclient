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
const guild = require('../src/guild')

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

// Real lines from the /guild dump (2026-11-02), as the menu reader receives them.
const head = (name, lines, skin) => ({ id: 'player_head', lines, profile: { name, properties: skin ? [{ name: 'textures', value: Buffer.from(JSON.stringify({ textures: { SKIN: { url: skin } } })).toString('base64') }] : [] } })

async function guildRules () {
  const slots = [
    { id: 'black_stained_glass_pane', lines: ['Black Stained Glass Pane'] },
    head('eggenjoyer', ['GUILD INFO (10/10)', 'Guild Creation Date: 10/28/26'], 'http://textures.minecraft.net/texture/abc'),
    head('parmegio', ['parmegio (Online)', 'Guild Owner', '874.08k Crops Farmed', '14 Quests Completed', 'Click to Open Stats'], 'http://textures.minecraft.net/texture/def'),
    head('p4rme', ['p4rme (Online)', 'Elder', '18 Quests Completed']),
    head('D1NN0', ['D1NN0 (Online)', 'Member', '15 Quests Completed'], 'http://evil.example/skin.png'),
    head('Ernani_', ['Ernani_ (Online)', '31 Quests Completed']),
    head('nxly_', ['nxly_ (Offline)', '15 Quests Completed'])
  ]
  const members = guild.readMembers(slots)
  assert.deepEqual(members.map(m => [m.name, m.quests]), [['parmegio', 14], ['p4rme', 18], ['D1NN0', 15], ['Ernani_', 31], ['nxly_', 15]], 'icon heads are not members')
  assert.equal(members[0].skin, 'http://textures.minecraft.net/texture/def')
  assert.equal(members[0].crops, '874.08k')
  assert.equal(members[2].skin, null, 'skins only from Mojang')
  const rank = name => guild.questRank(members, members.find(m => m.name === name))
  assert.deepEqual(['Ernani_', 'p4rme', 'D1NN0', 'nxly_', 'parmegio'].map(rank), [1, 2, 3, 3, 5], 'ties share a place')
  const before = new Map(members.map(m => [m.name, m]))
  const after = members.map(m => m.name === 'D1NN0' ? { ...m, quests: 17 } : m).concat({ name: 'newbie', quests: 3 })
  assert.deepEqual(guild.questRises(before, after).map(m => [m.name, m.quests]), [['D1NN0', 17]], 'one post with the final count, a new member is no rise')

  // Real lines from /guild quests (2026-11-02); \ue822 stands for the server's point icon.
  const questSlots = [
    { id: 'clock', lines: ['QUEST INFO', 'Farming Quest #1s: 56', 'Playtime Quests: 107', 'Total Quests: 328', 'Guild Points: \ue8222571', 'New quests available in', '⌚ 26m 59s!'] },
    { id: 'book', lines: ['(⏺) FARMING QUEST #1', 'Quest', '| Farm 3,000 Black Paint', '| Progress: 0/3,000', 'Reward', '| \ue82250 Guild Points', 'Quest progress is shared', 'within the guild.', '┃ Reroll: Available'] },
    { id: 'written_book', lines: ['(⏺) FARMING QUEST #2', 'Quest', '| Farm 7,500 Pineapple', '| Progress: 7,500/7,500', 'Reward', '| \ue822125 Guild Points'] },
    { id: 'written_book', lines: ['(⏺) PLAYTIME QUEST', 'Quest', '| Play for 15 minutes', '| Progress: 15/15', 'Reward', '| \ue8225 Guild Points'] },
    { id: 'arrow', lines: ['Back to Guild Info'] }
  ]
  const read = guild.readQuests(questSlots, 1000)
  assert.deepEqual(read.quests, [
    { name: 'FARMING QUEST #1', task: 'Farm 3,000 Black Paint', points: '50', done: false },
    { name: 'FARMING QUEST #2', task: 'Farm 7,500 Pineapple', points: '125', done: true },
    { name: 'PLAYTIME QUEST', task: 'Play for 15 minutes', points: '5', done: true }
  ])
  assert.equal(read.endsAt, 1000 + (26 * 60 + 59) * 1000)
  assert.equal(read.total, 328)
  assert.equal(read.points, 2571)
  assert.equal(guild.readQuests([{ id: 'book', lines: ['GUILD QUESTS'] }]), null, 'not the quests menu')
  const message = guild.questsMessage({ ...read, endsAt: Date.UTC(2026, 10, 2, 17, 0) }, { quests: [{ done: true }, { done: false }] }, 2571, '123456789012345678')
  assert.equal(message.content, '<@&123456789012345678>')
  assert.deepEqual(message.allowed_mentions, { roles: ['123456789012345678'] })
  assert.equal(message.embeds[0].title, '🆕 Novas quests da guilda (até 14:00)', 'Brasília time')
  assert.equal(message.embeds[0].description.split('\n')[0], '⛏ **Farming #1** — Farm 3,000 Black Paint · 50 pts')
  assert.equal(message.embeds[0].description.split('\n')[2], '⏱ **Playtime** — Play for 15 minutes · 5 pts')
  assert.equal(message.embeds[0].footer.text, 'Hora passada: 1/2 feitas · Guild Points 2571')
  assert.equal(guild.questsMessage(read, null, NaN, '').content, '', 'no role, no ping')
  assert.throws(() => guild.guildSettings({}, { roleId: '<@&12>' }), /Role ID/)

  assert.equal(guild.findValue(['Completion 18.1%', 'Crops Discovered 20/48'], 'completion'), '18.1%')
  assert.equal(guild.findValue(['Completion', '12%'], 'completion'), '12%')
  assert.equal(guild.findValue(['Crops Farmed [#329]', 'Total: 257,500'], 'total'), '257,500')
  assert.equal(guild.findValue(['nothing'], 'total'), null)
  assert.equal(guild.numberValue('257,500'), 257500)
  assert.equal(guild.numberValue('1.5k'), 1500)
  assert.equal(guild.numberValue(null), -1)

  assert.equal(guild.rankingSlot(Date.UTC(2026, 10, 2, 2, 59)), '2026-11-01/7', '23:59 in Brasília')
  assert.equal(guild.rankingSlot(Date.UTC(2026, 10, 2, 3, 0)), '2026-11-02/0', 'midnight in Brasília')
  assert.equal(guild.rankingSlot(Date.UTC(2026, 10, 2, 13, 0)), '2026-11-02/3', '10h in Brasília')

  const hook = 'https://discord.com/api/webhooks/123/abc-DEF_9'
  assert.throws(() => guild.guildSettings({}, { track: true }), /needs a webhook/)
  assert.throws(() => guild.guildSettings({}, { trackWebhook: 'https://evil.example/api/webhooks/1/x' }), /Discord webhook/)
  assert.throws(() => guild.guildSettings({}, { rankingWebhook: 'http://discord.com/api/webhooks/1/x' }), /Discord webhook/)
  const on = guild.guildSettings({}, { track: true, trackWebhook: ' ' + hook + ' ', ranking: true, rankingWebhook: hook })
  assert.equal(on.trackWebhook, hook)
  assert.equal(on.lastSlot, guild.rankingSlot(), 'switching on does not post right away')
  assert.equal(guild.guildSettings({ ...on, lastSlot: 'old' }, on).lastSlot, 'old', 'already on: keeps its slot')

  // Rendered offline: no skin, and mc-heads.net may be unreachable; both must still give a picture.
  const png = await guild.questImage({ name: 'D1NN0', quests: 16 }, 3)
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  const podium = await guild.podiumImage([
    { name: 'a', completion: '20%', crops: '1' }, { name: 'b', completion: null, crops: null }, { name: 'c', completion: '5%', crops: '3' }, { name: 'd', completion: '1%', crops: '4' }
  ])
  assert.equal(podium.subarray(1, 4).toString(), 'PNG')
  const questPlayers = members.map((m, i) => ({ ...m, delta: i % 2 ? 2 : 0 })).sort((a, b) => b.quests - a.quests)
  const questPodium = await guild.podiumImage(questPlayers, guild.questLayout(questPlayers, 'Quests da hora: 5/5 · Guild Points 2571'))
  assert.equal(questPodium.subarray(1, 4).toString(), 'PNG')
  if (process.env.GUILD_IMAGES) {
    fs.writeFileSync(path.join(process.env.GUILD_IMAGES, 'quest.png'), png)
    fs.writeFileSync(path.join(process.env.GUILD_IMAGES, 'podium.png'), podium)
    fs.writeFileSync(path.join(process.env.GUILD_IMAGES, 'quests-podium.png'), questPodium)
  }
}

// Quests reset on the hour: the new ones are announced, a quest ranking goes out when all are done
// or at the reset if anyone did one. A 3-hour ranking reads /stats of everyone, through one cooldown.
async function guildFlow (dataDir) {
  const data = require('minecraft-data')(VERSION)
  const { server, chats } = fakeServer()
  await new Promise(resolve => server.on('listening', resolve))
  const posts = []
  const manager = new Manager({
    dataDir,
    tokens: { factory: () => { throw new Error('unused') }, remove: async () => {} },
    botOptions: { auth: 'offline', username: 'p4rme' },
    guildTiming: { ready: 200, questDelay: 200, questRetries: [300, 300], statsGap: [50, 100], cooldownStep: 100, cooldownMax: 200, afterReset: 100 },
    postWebhook: async (url, png, filename, payload) => { posts.push({ url, png, filename, payload }) }
  })
  manager.config.accounts.push({ id: 'a1', name: 'p4rme', uuid: 'u', servers: [] })
  manager.addServer('a1', `127.0.0.1:${PORT}`, false)
  const id = manager.config.accounts[0].servers[0].id
  const conn = manager.conns.get(id)
  const text = value => nbt.comp({ text: nbt.string(value) })
  const quests = { p4rme: 18, D1NN0: 15, parmegio: 14 }
  const item = (name, components = []) => ({ itemCount: 1, itemId: data.itemsByName[name].id, addedComponentCount: components.length, removedComponentCount: 0, components, removeComponents: [] })
  const named = (title, lore) => [{ type: 'custom_name', data: text(title) }, { type: 'lore', data: lore.map(text) }]
  const memberHead = name => item('player_head', [...named(`${name} (Online)`, ['Member', `${quests[name]} Quests Completed`]), { type: 'profile', data: { type: 'partial', name, properties: [], skinPatch: {} } }])
  const show = (sc, title, slots) => {
    sc.write('open_window', { windowId: 5, inventoryType: 5, windowTitle: text(title) })
    sc.write('window_items', { windowId: 5, stateId: 1, items: Array.from({ length: 90 }, (_, i) => slots[i] ?? { itemCount: 0 }), carriedItem: { itemCount: 0 } })
  }
  let cooled = false
  // The hour ends at resetAt, then a new set of quests starts.
  const hour = { resetAt: Date.now() + 3600000, set: 1, done: [false, false] }
  // Ends the announced hour early: the server shows the new countdown, the client already announced that hour.
  const shift = ms => { hour.resetAt = Date.now() + ms; conn.server.guild.announced = hour.resetAt }
  const questMenu = () => {
    if (Date.now() >= hour.resetAt) Object.assign(hour, { resetAt: Date.now() + 3600000, set: hour.set + 1, done: [false, false] })
    const left = Math.ceil((hour.resetAt - Date.now()) / 1000)
    const quest = (n, done) => item(done ? 'written_book' : 'book', named(`(⏺) FARMING QUEST #${n}`, ['Quest', `| Farm ${hour.set * 10 + n} Wheat`, `| Progress: ${done ? 5 : 0}/5`, 'Reward', '| 50 Guild Points']))
    return { 4: item('clock', named('QUEST INFO', ['Total Quests: 9', 'Guild Points: 100', 'New quests available in', `⌚ ${Math.floor(left / 60)}m ${left % 60}s!`])), 11: quest(1, hour.done[0]), 12: quest(2, hour.done[1]) }
  }
  const say = (sc, line) => sc.write('system_chat', { content: text(line), isActionBar: false })
  const command = sc => ({ command }) => {
    if (command === 'guild quests') show(sc, 'Guild Quests', questMenu())
    if (command === 'guild') show(sc, 'Guild Info | test', { 4: item('player_head', [...named('GUILD INFO', ['x']), { type: 'profile', data: { type: 'partial', name: 'eggenjoyer', properties: [], skinPatch: {} } }]), 11: memberHead('parmegio'), 12: memberHead('p4rme'), 13: memberHead('D1NN0') })
    const stats = /^stats (\w+)$/.exec(command)
    if (!stats) return
    if (stats[1] === 'D1NN0' && !cooled) {
      cooled = true
      return say(sc, 'Wait a moment before using /stats again.')
    }
    show(sc, `${stats[1]}'s Stats`, { 10: item('beacon', named('Completion ' + quests[stats[1]] + '%', [])), 12: item('wheat', named('Crops Farmed [#329]', ['Total: 1,000'])) })
  }
  server.on('playerJoin', sc => {
    sc.on('chat_command', command(sc))
    sc.on('chat_command_signed', command(sc))
    sc.write('scoreboard_objective', { name: 'side', action: 0, displayText: text('COBBLESTONE'), type: 0 })
    sc.write('scoreboard_display_objective', { position: 1, name: 'side' })
  })

  manager.setGuild(id, { track: true, trackWebhook: 'https://discord.com/api/webhooks/1/quests', roleId: '424242424242', ranking: true, rankingWebhook: 'https://discord.com/api/webhooks/1/ranking' })
  assert.equal(manager.summary().accounts[0].servers[0].guild.track, true, 'the page sees its settings')
  manager.connect(id)
  await until('first reads', () => posts.length === 1)
  assert.equal(conn.guildMembers.size, 3)
  assert.equal(manager.detail(id).menu, null, 'menu closed after reading')
  assert.equal(posts[0].png, null, 'this hour\'s quests, as a message')
  assert.equal(posts[0].payload.content, '<@&424242424242>')
  assert.match(posts[0].payload.embeds[0].description, /Farm 11 Wheat/)
  assert(!posts[0].payload.embeds[0].footer?.text.includes('Hora passada'), 'no last hour seen yet')
  const announced = manager.config.accounts[0].servers[0].guild.announced
  assert(announced > Date.now(), 'kept, so a restart does not announce the same hour again')
  posts.length = 0

  // The count goes up a moment after the chat line, as on the real server.
  say(server.lastClient, 'GUILDS • Guild quest complete: Play for 30 minutes')
  say(server.lastClient, 'GUILDS • Guild received 10 Points')
  setTimeout(() => { quests.D1NN0 = 17 }, 400)
  await until('quest posted', () => posts.length === 1, 10000)
  assert.equal(posts[0].url, 'https://discord.com/api/webhooks/1/quests')
  assert.equal(posts[0].filename, 'quest.png')
  assert.equal(posts[0].png.subarray(1, 4).toString(), 'PNG')
  await until('quests menu read after the post', () => chats.filter(c => c === '/guild quests').length === 2)
  await until('lock released', () => !conn.running)
  assert(conn.chat.some(line => /^\[guild\] D1NN0 completed quest 17 \[#2\], posted$/.test(line.text)))
  assert.equal(chats.filter(c => c === '/guild').length, 3, 'snapshot, then the first check found nothing, then the retry')
  assert.equal(posts.length, 1, 'quests still open: no ranking')

  say(server.lastClient, 'GUILDS • Guild quest complete: Farm 1000 crops')
  await until('nobody went up', () => conn.chat.at(-1).text === '[guild] Quest completed, but nobody went up', 10000)
  assert.equal(posts.length, 1)

  // The hour's last quest: its banner, then the quest ranking. The hour ends 3s later.
  hour.done = [true, true]
  shift(3000)
  quests.p4rme = 19
  say(server.lastClient, 'GUILDS • Guild quest complete: Farm 12 Wheat')
  await until('ranking after the last quest', () => posts.length === 3, 10000)
  assert.equal(posts[1].filename, 'quest.png')
  assert.equal(posts[2].filename, 'quests.png')
  assert.equal(posts[2].png.subarray(1, 4).toString(), 'PNG')
  // At the reset: the new quests, and no ranking, nothing changed since the last one.
  await until('new hour announced', () => posts.length === 4, 10000)
  assert.match(posts[3].payload.embeds[0].description, /Farm 21 Wheat/)
  assert.match(posts[3].payload.embeds[0].footer.text, /^Hora passada: 2\/2 feitas/)
  await wait(1000)
  assert.equal(posts.length, 4, 'no ranking without a change')

  // One quest this hour, then the reset: the ranking comes with the new quests.
  hour.done = [true, false]
  shift(3000)
  quests.parmegio = 15
  say(server.lastClient, 'GUILDS • Guild quest complete: Farm 21 Wheat')
  await until('banner, new hour and its ranking', () => posts.length === 7, 15000)
  assert.deepEqual(posts.slice(4).map(p => p.filename), ['quest.png', null, 'quests.png'])
  assert.match(posts[5].payload.embeds[0].footer.text, /^Hora passada: 1\/2 feitas/)
  posts.length = 0

  manager.runRanking(id)
  assert.throws(() => manager.runRanking(id), /already running/)
  await until('ranking posted', () => posts.length === 1, 20000)
  assert.equal(posts[0].filename, 'ranking.png')
  assert.equal(posts[0].url, 'https://discord.com/api/webhooks/1/ranking')
  assert.equal(posts[0].payload.embeds[0].image.url, 'attachment://ranking.png')
  assert.match(conn.chat.at(-1).text, /^\[guild\] Ranking sent: 3 players$/, 'the cooldown was waited out, nobody missing')
  assert.equal(chats.filter(c => c === '/stats D1NN0').length, 2)
  assert(!conn.running, 'the menu lock is released')
  manager.disconnect(id)
  await until('offline', () => conn.status === 'offline')
  assert.throws(() => manager.runRanking(id), /not online/)
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
    await guildRules(); console.log('ok  guild menu reading, ranks, settings, pictures')
    await guildFlow(path.join(root, 'guild')); console.log('ok  guild quest post and ranking on a fake server')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  process.exit(0)
}

main().catch(err => {
  console.error('FAILED:', err)
  process.exit(1)
})

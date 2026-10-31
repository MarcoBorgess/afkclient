// Run with: node test/selfcheck.js
// Uses a local fake 1.21.11 server and a temp folder. Needs no Microsoft account or real server.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const mc = require('minecraft-protocol')
const nbt = require('prismarine-nbt')
const { computeChatChecksum } = require('minecraft-protocol/src/datatypes/checksums')
const { Manager, VERSION, belowShown, blocksReconnect, fillAmounts, parseSteps, showsAddress, chatLine, toSignedByte, windowChecksum, isNetworkError, nextDelay, parseAddress } = require('../src/bots')
const { isAllowedRequest } = require('../src/server')
const { createTokenStore } = require('../src/tokenCache')

const PORT = 25598
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
  assert(showsAddress(sidebar, 'play.cobblestone.gg'))
  assert(!showsAddress(sidebar, 'lobby.minehut.gg'))
  assert(!showsAddress(null, 'play.cobblestone.gg'))
  assert.deepEqual(parseSteps('/rewards\n\nclick 2 minecraft:chest_minecart\nclick all diamond\nclose').map(s => s.type), ['send', 'click', 'clickAll', 'close'])
  assert.throws(() => parseSteps('click diamond'), /click <slot>/)
  assert.throws(() => parseSteps('  \n'), /Nothing to run/)
}

function requestChecks () {
  const req = (method, headers) => ({ method, headers })
  const host = '127.0.0.1:1'
  const json = 'application/json'
  assert(isAllowedRequest(req('GET', { host }), 1))
  assert(isAllowedRequest(req('POST', { host, origin: 'http://127.0.0.1:1', 'content-type': json }), 1))
  assert(!isAllowedRequest(req('GET', { host: 'evil.com:1' }), 1), 'DNS rebinding')
  assert(!isAllowedRequest(req('POST', { host, origin: 'http://evil.com', 'content-type': json }), 1), 'other website')
  assert(!isAllowedRequest(req('POST', { host, 'content-type': json }), 1), 'no origin')
  assert(!isAllowedRequest(req('POST', { host, origin: 'http://127.0.0.1:1', 'content-type': 'text/plain' }), 1), 'form post')
}

async function tokens (dir) {
  const store = createTokenStore(dir)
  const cache = store.factory({ username: 'acct', cacheName: 'live' })
  assert.deepEqual(await cache.getCached(), {})
  await cache.setCachedPartial({ secret: 'super-secret-token' })
  const [file] = fs.readdirSync(dir)
  assert(!fs.readFileSync(path.join(dir, file), 'utf8').includes('super-secret-token'), 'token stored in plain text')
  const fresh = createTokenStore(dir).factory({ username: 'acct', cacheName: 'live' })
  assert.deepEqual(await fresh.getCached(), { secret: 'super-secret-token' })
  await store.remove('acct')
  assert.equal(fs.readdirSync(dir).length, 0)
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

  // A duplicate-login kick must leave real Minecraft alone.
  server.lastClient.write('kick_disconnect', { reason: nbt.comp({ translate: nbt.string('multiplayer.disconnect.duplicate_login') }) })
  await until('stop after duplicate login', () => conn.status === 'offline')
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

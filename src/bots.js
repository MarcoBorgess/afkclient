const { EventEmitter } = require('events')
const { randomUUID } = require('crypto')
const fs = require('fs')
const path = require('path')
const { setTimeout: wait } = require('timers/promises')
const mineflayer = require('mineflayer')
const { Authflow, Titles } = require('prismarine-auth')
const { computeChatChecksum } = require('minecraft-protocol/src/datatypes/checksums')

// Change this one value to move to a newer Minecraft once mineflayer supports it.
const VERSION = '1.21.11'
const registry = require('prismarine-registry')(VERSION)
const ChatMessage = require('prismarine-chat')(registry)

const FIRST_DELAY = 5000
const MAX_DELAY = 300000
const RATE_LIMIT_DELAY = 120000 // retrying sooner keeps Mojang's limit from ever clearing
const RETRY_JITTER = 5000 // accounts dropped together must not all sign in together
const STABLE_AFTER = 60000
const SPAWN_TIMEOUT = 120000
const CHAT_LINES = 500
const MAX_CHAT_LINE = 2000 // servers choose the length, and 500 huge lines could take the whole app down
const MAX_SERVERS = 10
const TRACE_SIZE = 30
const SWITCH_PACKETS = ['login', 'respawn', 'start_configuration', 'finish_configuration', 'select_known_packs', 'add_resource_pack', 'remove_resource_pack', 'transfer', 'cookie_request', 'custom_payload', 'kick_disconnect', 'disconnect']
const MOVE_PACKETS = ['position', 'position_look', 'look', 'flying']
const QUIET_PACKETS = [...MOVE_PACKETS, 'tick_end', 'keep_alive', 'pong', 'ping_request', 'teleport_confirm', 'chunk_batch_received']
const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
const NETWORK_ERRORS = ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']
const SMALL_CAPS = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ'
const ADDRESS_GRACE = 60000 // a slow join or a blinking scoreboard must not count as the lobby
const LOBBY_RETRY = 15000
const STEP_GAP = 1000
const STEP_TIMEOUT = 10000
const DRAIN_GAP = 6000 // servers like Cobblestone refuse a second payment within 5s
const MAX_PAYMENTS = 5
const STAGGER = 1000
const SCOREBOARD_ADDRESS = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/
const NOT_A_SERVER = ['discord', 'youtube', 'twitter', 'tiktok', 'instagram']
const ADDRESS_PREFIXES = ['play', 'mc', 'hub', 'www', 'server', 'store', 'shop', 'lobby']
const HOSTING_DOMAINS = ['minehut', 'aternos', 'minefort']
const SERVER_NICKNAMES = { cobblestone: 'Cobble' }
const MAP_SIZE = 128
const MAX_MAPS = 16
const FRAME_TYPES = [registry.entitiesByName.item_frame.id, registry.entitiesByName.glow_item_frame.id]
// For each direction a frame can face: its axis along the wall, which way a viewer's right is, and the wall's depth axis.
const WALL_AXES = { 2: ['x', -1, 'z'], 3: ['x', 1, 'z'], 4: ['z', 1, 'x'], 5: ['z', -1, 'x'] }
const PLACEHOLDER = /\{([a-z0-9_]+)(?:\.(\d+))?\}/gi
const AMOUNT = /(?<![\d.,])(\d[\d,]*(?:\.\d+)?)([a-z]{0,2})(?![a-z0-9])/g

function toText (component) {
  try {
    return ChatMessage.fromNotch(component).toString()
  } catch {
    return String(component)
  }
}

const isNetworkError = err => NETWORK_ERRORS.includes(err?.code ?? err?.cause?.code)
const nextDelay = delay => Math.min(delay * 2, MAX_DELAY)

// Servers put the full line (rank, nick, message) in the unsigned part, which toString() ignores.
function chatLine (message, sender) {
  const text = (message.unsigned ?? message).toString()
  return sender && !text.includes(sender) ? `${sender}: ${text}` : text
}

function plainCaps (text) {
  return [...text.toLowerCase()].map(c => {
    const i = SMALL_CAPS.indexOf(c)
    return i < 0 ? c : String.fromCharCode(97 + i)
  }).join('')
}

// Reconnecting after these would kick you off real Minecraft or keep knocking on a ban.
function blocksReconnect (reason) {
  const text = plainCaps(reason)
  return ['duplicate_login', 'another location', 'already connected', 'already_connected', 'banned']
    .some(words => text.includes(words))
}

function parseAddress (address) {
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(String(address).trim())
  const port = match?.[2] ? Number(match[2]) : 25565
  if (!match || port < 1 || port > 65535) throw new Error('Address must look like play.example.com or play.example.com:25565')
  return { host: match[1].toLowerCase(), port }
}

function serializeItem (item) {
  if (!item) return null
  return {
    slot: item.slot,
    id: item.name,
    name: item.customName ? toText(item.customName) : item.displayName,
    count: item.count,
    lore: [item.customLore ?? []].flat().map(toText)
  }
}

const toSignedByte = value => value << 24 >> 24

// minecraft-protocol 1.68.0 hashes the ring buffer in slot order; the server expects oldest first.
function windowChecksum (seen) {
  const { capacity, offset } = seen
  return computeChatChecksum(Array.from({ length: capacity }, (_, i) => seen[(offset + i) % capacity]).filter(Boolean))
}

function resetLastSeen (seen) {
  seen.length = 0
  seen.offset = 0
  seen.pending = 0
}

// Each is a "Chat message validation failure" kick in minecraft-protocol 1.68.0.
// shortcut: reaches into library internals, drop whatever a newer release fixes.
function fixChatTracking (bot) {
  const client = bot._client
  client.once('playerJoin', () => {
    // The library's handler rebuilds the array with map(), which zeroes offset and pending.
    client.removeAllListeners('hide_message')
    client.on('hide_message', packet => {
      const seen = client._lastSeenMessages
      const signature = packet.signature || client._signatureCache[packet.id]
      if (!signature) return
      for (let i = 0; i < seen.length; i++) {
        if (seen[i]?.pending && seen[i].signature.equals(signature)) {
          seen[i] = null
          seen.pending--
        }
      }
    })
  })
  // A network moving you between servers sends login again on the same connection. The new
  // server starts its chat state from nothing, so do what a real client does: start over too.
  let joined = false
  client.on('login', () => {
    if (!joined) {
      joined = true
      return
    }
    resetLastSeen(client._lastSeenMessages)
    if (!client._session) return
    client._session = { index: 0, uuid: randomUUID() }
    client.write('chat_session_update', {
      sessionUUID: client._session.uuid,
      expireTime: BigInt(client.profileKeys.expiresOn.getTime()),
      publicKey: client.profileKeys.public.export({ type: 'spki', format: 'der' }),
      signature: client.profileKeys.signatureV2
    })
  })
}

// mineflayer 4.39.0 never sends tick_end. Servers count one position per tick and clear
// the count on tick_end, so without it the second position gets "Invalid move player packet".
// shortcut: wraps the client's write, remove once a mineflayer release sends tick_end itself.
function sendTickEnd (bot) {
  const client = bot._client
  const write = client.write.bind(client)
  let ended = false
  client.write = (name, params) => {
    // minecraft-data types the command checksum as i8 but it is computed as 0-255; same byte on the wire.
    if (name === 'chat_command_signed') params = { ...params, checksum: toSignedByte(windowChecksum(client._lastSeenMessages)) }
    if (name === 'chat_message') params = { ...params, checksum: windowChecksum(client._lastSeenMessages) }
    write(name, params)
    if (MOVE_PACKETS.includes(name)) {
      write('tick_end', {})
      ended = true
    }
  }
  // physicsTick fires before the position goes out, so decide after this tick's writes.
  bot.on('physicsTick', () => queueMicrotask(() => {
    if (!ended && client.state === 'play') write('tick_end', {})
    ended = false
  }))
}

// mineflayer's scoreboard expects an action field that 1.20.3+ score packets no longer have,
// and ignores reset_score, so its sidebar stays empty. Returns a function reading the sidebar.
function trackSidebar (bot, onChange) {
  const client = bot._client
  const objectives = new Map()
  let sidebar = null
  const scoreNumber = (value, format, styling) => format === 0 ? '' : format === 2 ? toText(styling) : String(value)
  const on = (packet, handler) => client.on(packet, data => {
    handler(data)
    onChange()
  })

  on('scoreboard_objective', ({ name, action, displayText, number_format: format, styling }) => {
    if (action === 1) {
      objectives.delete(name)
      return
    }
    const objective = objectives.get(name) ?? { scores: new Map() }
    objectives.set(name, Object.assign(objective, { title: toText(displayText), format, styling }))
  })
  on('scoreboard_display_objective', ({ position, name }) => {
    if (position === 1) sidebar = name
  })
  on('scoreboard_score', ({ itemName, scoreName, value, display_name: label, number_format: format, styling }) => {
    objectives.get(scoreName)?.scores.set(itemName, { value, label, format, styling })
  })
  on('reset_score', ({ entity_name: item, objective_name: name }) => {
    if (name) objectives.get(name)?.scores.delete(item)
    else for (const objective of objectives.values()) objective.scores.delete(item)
  })
  // A server switch on the same connection starts from an empty board, as in a real client.
  on('login', () => {
    objectives.clear()
    sidebar = null
  })

  return () => {
    const objective = objectives.get(sidebar)
    if (!objective) return null
    const lines = [...objective.scores].map(([item, score]) => {
      const text = score.label ? toText(score.label) : (bot.teamMap[item]?.displayName(item).toString() ?? item)
      const number = score.format === undefined
        ? scoreNumber(score.value, objective.format, objective.styling)
        : scoreNumber(score.value, score.format, score.styling)
      return { item, value: score.value, text: text.replace(/§./g, ''), number }
    })
    // Same order as the game: highest score first, then by name, and it only shows 15.
    lines.sort((a, b) => b.value - a.value || a.item.localeCompare(b.item))
    return { title: objective.title.replace(/§./g, ''), lines: lines.slice(0, 15).map(({ text, number }) => ({ text, number })) }
  }
}

// Held or in an item frame, a map's picture arrives the same way. Keeps the newest few, last
// updated last. An update may cover only part of the 128x128 map.
function updateMap (maps, { itemDamage: id, columns, rows, x, y, data }) {
  if (!columns) return false // icons only
  const pixels = maps.get(id) ?? Buffer.alloc(MAP_SIZE * MAP_SIZE)
  for (let row = 0; row < rows && y + row < MAP_SIZE; row++) {
    for (let column = 0; column < columns && x + column < MAP_SIZE; column++) {
      pixels[(y + row) * MAP_SIZE + x + column] = data[row * columns + column]
    }
  }
  maps.delete(id)
  maps.set(id, pixels)
  if (maps.size > MAX_MAPS) maps.delete(maps.keys().next().value)
  return true
}

// Servers build big pictures from a wall of framed maps, so the page needs them in place.
// shortcut: ignores a frame's rotation, the captcha wall seen so far is upright.
function mapWall (frames, maps) {
  const walls = new Map()
  for (const frame of frames.values()) {
    const axes = WALL_AXES[frame.direction]
    if (!axes || !maps.has(frame.mapId)) continue
    const key = `${frame.direction} ${Math.floor(frame[axes[2]])}`
    if (!walls.has(key)) walls.set(key, [])
    walls.get(key).push(frame)
  }
  const wall = [...walls.values()].sort((a, b) => b.length - a.length)[0]
  if (!wall) return null
  const [axis, sign] = WALL_AXES[wall[0].direction]
  const column = frame => sign * Math.floor(frame[axis])
  const row = frame => -Math.floor(frame.y)
  const left = Math.min(...wall.map(column))
  const top = Math.min(...wall.map(row))
  return {
    columns: Math.max(...wall.map(column)) - left + 1,
    rows: Math.max(...wall.map(row)) - top + 1,
    tiles: wall.map(frame => ({ id: frame.mapId, column: column(frame) - left, row: row(frame) - top, pixels: maps.get(frame.mapId).toString('base64') }))
  }
}

// Connected but held back: chat answers the captcha, so nothing else may be sent as if it were a command.
const inCaptcha = conn => conn.status === 'online' && conn.captcha

const sidebarText = line => plainCaps(`${line.text} ${line.number}`)

const inMinehutLobby = sidebar => plainCaps(sidebar?.title ?? '').trim() === 'minehut'

// Where the account really is, which can differ from the address it connected to.
function serverName (sidebar) {
  if (!sidebar) return ''
  if (inMinehutLobby(sidebar)) return 'Minehut'
  const found = [plainCaps(sidebar.title), ...sidebar.lines.map(sidebarText)].reverse().flatMap(text => SCOREBOARD_ADDRESS.exec(text)?.[0] ?? [])
  for (const address of found) {
    const parts = address.split('.').slice(0, -1) // without the .gg
    const site = parts.at(-1)
    if (NOT_A_SERVER.includes(site)) continue
    // On a hosting domain the server is the part before it: cobble.minehut.gg is Cobble.
    const name = HOSTING_DOMAINS.includes(site) ? parts.slice(0, -1).filter(part => !ADDRESS_PREFIXES.includes(part)).at(-1) ?? site : site
    return SERVER_NICKNAMES[name] ?? name[0].toUpperCase() + name.slice(1)
  }
  return sidebar.title.trim()
}

function showsAddress (sidebar, host) {
  return !!sidebar && [sidebar.title, ...sidebar.lines.map(sidebarText)].some(text => plainCaps(text).includes(host))
}

// nth number after the label on its line: "purse 50.00k · 637" gives 50.00k, then 637.
function readAmount (sidebar, label, nth) {
  const pattern = new RegExp(`\\b${label}\\b(.*)`)
  for (const line of sidebar?.lines ?? []) {
    const match = pattern.exec(sidebarText(line))
    if (match) return [...match[1].matchAll(AMOUNT)][nth]
  }
}

// Scoreboards round, and paying more than you have is refused, so go one shown step below.
// Numbers without a suffix are taken as exact. What is left gets paid on the next pass.
function belowShown ([, digits, suffix]) {
  const number = digits.replace(/,/g, '')
  if (!suffix) return number
  const decimals = number.split('.')[1]?.length ?? 0
  const lower = Number(number) - 10 ** -decimals
  return (lower > 0 ? lower.toFixed(decimals) : (Number(number) * 0.9).toFixed(decimals + 1)) + suffix
}

function fillAmounts (text, sidebar) {
  const shown = []
  const command = text.replace(PLACEHOLDER, (tag, label, nth) => {
    const amount = readAmount(sidebar, label.toLowerCase(), Number(nth ?? 1) - 1)
    if (!amount) throw new Error(`${tag} is not on the scoreboard`)
    shown.push(amount[0])
    return belowShown(amount)
  })
  return { command, shown: shown.join(' '), nothing: shown.every(a => parseFloat(a.replace(/,/g, '')) === 0) }
}

function parseSteps (text) {
  const steps = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    if (line.toLowerCase() === 'close') return { type: 'close' }
    if (!/^click\b/i.test(line)) return { type: 'send', text: line }
    const all = /^click all (?:minecraft:)?(\S+)$/i.exec(line)
    if (all) return { type: 'clickAll', item: all[1].toLowerCase() }
    const one = /^click (\d+) (?:minecraft:)?(\S+)$/i.exec(line)
    if (one) return { type: 'click', slot: Number(one[1]), item: one[2].toLowerCase() }
    throw new Error(`Write "click <slot> <item>" or "click all <item>", not "${line}"`)
  })
  if (!steps.length) throw new Error('Nothing to run')
  return steps
}

const namedIn = (steps, name) => steps.some(step => step.type === 'send' && new RegExp(`\\b${name.replace(/\W/g, '')}\\b`, 'i').test(step.text))

// A proxy's kick can be one generic line. What was exchanged just before it is the only other clue.
function traceConnection (bot) {
  const client = bot._client
  const trace = []
  const note = text => {
    trace.push(text)
    if (trace.length > TRACE_SIZE) trace.shift()
  }
  const write = client.write.bind(client)
  client.write = (name, params) => {
    if (!QUIET_PACKETS.includes(name)) note(`sent:${client.state}:${name}`)
    write(name, params)
  }
  client.on('packet', (data, { name, state }) => {
    if (SWITCH_PACKETS.includes(name)) note(`got:${state}:${name}`)
  })
  return () => trace.join(' ')
}

class Manager extends EventEmitter {
  constructor ({ dataDir, tokens, botOptions = {}, flow = Authflow, addressGrace = ADDRESS_GRACE, maxAccounts = () => Infinity, isTaken = () => false, isAllowedServer = () => true }) {
    super()
    this.configFile = path.join(dataDir, 'config.json')
    this.tokens = tokens
    this.maxAccounts = maxAccounts
    this.isTaken = isTaken
    this.isAllowedServer = isAllowedServer
    this.botOptions = botOptions
    this.flow = flow
    this.addressGrace = addressGrace
    this.conns = new Map()
    this.signIn = null
    fs.mkdirSync(dataDir, { recursive: true })
    try {
      this.config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'))
    } catch (err) {
      // A damaged file must not be overwritten with an empty account list.
      if (err.code !== 'ENOENT') throw new Error(`Cannot read ${this.configFile}: ${err.message}`)
      this.config = { accounts: [] }
    }
    // Per address, shared by every account on that server. No prototype: the keys come from requests.
    this.config.servers = Object.assign(Object.create(null), this.config.servers)
    for (const account of this.config.accounts) {
      for (const server of account.servers) this.conns.set(server.id, this.newConn(account, server))
    }
  }

  newConn (account, server) {
    return { account, server, wanted: false, status: 'offline', message: '', code: null, chat: [], delay: FIRST_DELAY, bot: null, timer: null, retryAt: null }
  }

  save () {
    fs.writeFileSync(this.configFile + '.tmp', JSON.stringify(this.config, null, 2))
    fs.renameSync(this.configFile + '.tmp', this.configFile)
    this.emit('changed')
  }

  // ----- accounts and servers -----

  // Not async: the page's request must get these refusals, the sign-in itself finishes later.
  addAccount () {
    if (this.signIn?.state === 'waiting') throw new Error('Another sign-in is already in progress')
    if (this.config.accounts.length >= this.maxAccounts()) throw new Error(`Your limit is ${this.maxAccounts()} accounts`)
    const id = randomUUID()
    this.signIn = { state: 'waiting', code: null, url: null, error: null }
    this.emit('changed')
    return this.finishSignIn(id)
  }

  async finishSignIn (id) {
    try {
      const flow = new this.flow(id, this.tokens.factory, { authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo', flow: 'live' }, code => {
        this.signIn.code = code.user_code
        this.signIn.url = code.verification_uri
        this.emit('changed')
      })
      const { profile } = await flow.getMinecraftJavaToken({ fetchProfile: true })
      if (!profile?.name) throw new Error('This Microsoft account does not own Minecraft')
      // Two users on one account would kick each other off the server forever.
      if (this.isTaken(profile.id) || this.config.accounts.some(a => a.uuid === profile.id)) throw new Error(`${profile.name} is already added`)
      this.config.accounts.push({ id, name: profile.name, uuid: profile.id, servers: [] })
      this.signIn = null
      this.save()
    } catch (err) {
      await this.tokens.remove(id)
      this.signIn = { state: 'failed', error: err.message }
      this.emit('changed')
    }
  }

  async removeAccount (id) {
    const account = this.account(id)
    for (const server of account.servers) this.removeConn(server.id)
    this.config.accounts = this.config.accounts.filter(a => a !== account)
    this.save()
    await this.tokens.remove(id)
  }

  addServer (accountId, address, autoConnect) {
    const account = this.account(accountId)
    const { host, port } = parseAddress(address)
    if (!this.isAllowedServer(host)) throw new Error(`${host} is not on the allowed server list`)
    if (account.servers.length >= MAX_SERVERS) throw new Error(`An account can have ${MAX_SERVERS} servers`)
    if (account.servers.some(s => s.host === host && s.port === port)) throw new Error('This server is already on the account')
    const server = { id: randomUUID(), host, port, autoConnect: !!autoConnect }
    account.servers.push(server)
    this.conns.set(server.id, this.newConn(account, server))
    this.save()
  }

  removeServer (id) {
    const { account, server } = this.conn(id)
    this.removeConn(id)
    account.servers = account.servers.filter(s => s !== server)
    this.save()
  }

  setAutoConnect (id, value) {
    this.conn(id).server.autoConnect = !!value
    this.save()
  }

  addressOf ({ server }) {
    return `${server.host}:${server.port}`
  }

  settings (address) {
    return (this.config.servers[address] ??= { buttons: [], checkAddress: false })
  }

  checkKnownAddress (address) {
    if (![...this.conns.values()].some(conn => this.addressOf(conn) === address)) throw new Error('Unknown server')
  }

  setCheckAddress (address, value) {
    this.checkKnownAddress(address)
    this.settings(address).checkAddress = !!value
    this.save()
  }

  setLobbyCommand (address, value) {
    this.checkKnownAddress(address)
    this.settings(address).lobbyCommand = String(value ?? '').trim().slice(0, 256)
    this.save()
  }

  setButtons (address, buttons) {
    this.checkKnownAddress(address)
    if (!Array.isArray(buttons)) throw new Error('Invalid buttons')
    const clean = buttons.map(({ label, steps }) => {
      if (!String(label ?? '').trim()) throw new Error('A button needs a name')
      parseSteps(steps)
      return { label: String(label).trim(), steps: String(steps) }
    })
    this.settings(address).buttons = clean
    this.save()
  }

  removeConn (id) {
    this.disconnect(id)
    this.conns.delete(id)
  }

  account (id) {
    const account = this.config.accounts.find(a => a.id === id)
    if (!account) throw new Error('Unknown account')
    return account
  }

  conn (id) {
    const conn = this.conns.get(id)
    if (!conn) throw new Error('Unknown connection')
    return conn
  }

  // ----- connection lifecycle -----

  connect (id) {
    const conn = this.conn(id)
    // Added before the list existed, or the list changed since.
    if (!this.isAllowedServer(conn.server.host)) return this.setStatus(conn, 'offline', 'This server is not on the allowed server list')
    conn.wanted = true
    conn.delay = FIRST_DELAY
    if (!conn.bot) this.open(conn)
  }

  disconnect (id) {
    const conn = this.conn(id)
    conn.wanted = false
    clearTimeout(conn.timer)
    conn.retryAt = null
    conn.code = null
    if (conn.bot) conn.bot.quit()
    else this.setStatus(conn, 'offline', '')
  }

  autoConnectAll (gap = 5000, start = 0) {
    const ids = [...this.conns.values()].filter(c => c.server.autoConnect).map(c => c.server.id)
    ids.forEach((id, i) => setTimeout(() => {
      if (this.conns.has(id)) this.connect(id)
    }, start + i * gap).unref())
    return start + ids.length * gap
  }

  shutdown () {
    for (const conn of this.conns.values()) {
      conn.wanted = false
      clearTimeout(conn.timer)
      conn.bot?.quit()
    }
  }

  setStatus (conn, status, message) {
    conn.status = status
    conn.message = message
    this.emit('changed', conn.server.id)
  }

  addChat (conn, text) {
    conn.chat.push({ at: Date.now(), text: String(text).slice(0, MAX_CHAT_LINE) })
    if (conn.chat.length > CHAT_LINES) conn.chat.shift()
    this.emit('changed', conn.server.id)
  }

  open (conn) {
    clearTimeout(conn.timer)
    conn.retryAt = null
    this.setStatus(conn, 'connecting', '')
    const bot = mineflayer.createBot({
      username: conn.account.id, // only the token key; the real name comes from the profile
      auth: 'microsoft',
      host: conn.server.host,
      port: conn.server.port,
      version: VERSION,
      viewDistance: 2,
      profilesFolder: this.tokens.factory,
      onMsaCode: code => {
        conn.code = { code: code.user_code, url: code.verification_uri }
        this.setStatus(conn, 'needs-signin', 'Saved login expired, sign in again')
      },
      logErrors: false,
      hideErrors: true,
      ...this.botOptions
    })
    conn.bot = bot
    sendTickEnd(bot)
    fixChatTracking(bot)
    const readTrace = traceConnection(bot)
    conn.readSidebar = trackSidebar(bot, () => this.emit('changed', conn.server.id))
    conn.captcha = false
    for (const packet of ['login', 'respawn']) {
      bot._client.on(packet, ({ worldState }) => {
        conn.captcha = /captcha/i.test(worldState?.name ?? '') // Minehut's world is minecraft:captcha
        this.emit('changed', conn.server.id)
      })
    }
    conn.maps = new Map()
    conn.frames = new Map()
    conn.mapsVersion = (conn.mapsVersion ?? 0) + 1
    const mapsChanged = () => {
      conn.mapsVersion++
      this.emit('changed', conn.server.id)
    }
    bot._client.on('login', () => { // a server switch leaves the old maps behind
      conn.maps.clear()
      conn.frames.clear()
      mapsChanged()
    })
    bot._client.on('map', packet => {
      if (updateMap(conn.maps, packet)) mapsChanged()
    })
    bot._client.on('spawn_entity', ({ entityId, type, x, y, z, objectData }) => {
      if (FRAME_TYPES.includes(type)) conn.frames.set(entityId, { x, y, z, direction: objectData, mapId: null })
    })
    bot._client.on('entity_metadata', ({ entityId, metadata }) => {
      const frame = conn.frames.get(entityId)
      const item = metadata.find(entry => entry.type === 'item_stack')
      if (!frame || !item) return
      frame.mapId = item.value?.components?.find(component => component.type === 'map_id')?.data ?? null
      mapsChanged()
    })
    bot._client.on('entity_destroy', ({ entityIds }) => {
      if (entityIds.map(id => conn.frames.delete(id)).some(Boolean)) mapsChanged()
    })

    let finished = false
    let signedIn = false
    let authFailed = false
    let spawnedAt = 0
    let kickReason = ''
    let watchdog = null
    let addressSeen = 0
    let lobbySent = 0

    // A network can drop you in its lobby without disconnecting you; only the scoreboard tells.
    const addressCheck = setInterval(() => {
      if (conn.status !== 'online') return
      const { lobbyCommand } = this.settings(this.addressOf(conn))
      if (lobbyCommand && !conn.captcha && inMinehutLobby(conn.readSidebar()) && Date.now() - lobbySent > LOBBY_RETRY) {
        lobbySent = Date.now()
        this.addChat(conn, `[client] In the Minehut lobby, sending ${lobbyCommand}`)
        this.send(conn.server.id, lobbyCommand)
      }
      if (conn.captcha || !this.settings(this.addressOf(conn)).checkAddress) { // reconnecting would throw away a captcha in progress
        addressSeen = Date.now()
      } else if (showsAddress(conn.readSidebar(), conn.server.host)) {
        addressSeen = Date.now()
        conn.delay = FIRST_DELAY
      } else if (Date.now() - addressSeen > this.addressGrace) {
        spawnedAt = 0 // keeps the backoff growing, the lobby can last longer than STABLE_AFTER
        finish('Server address not on the scoreboard')
      }
    }, 1000)

    const finish = message => {
      if (finished) return
      finished = true
      if (conn.wanted) {
        this.addChat(conn, `[client] Lost the connection: ${message}`)
        if (kickReason) this.addChat(conn, `[client] Raw kick: ${kickReason}`)
        this.addChat(conn, `[client] Last packets: ${readTrace()}`)
        console.error(new Date().toISOString(), conn.account.name, this.addressOf(conn), message, kickReason, readTrace())
      }
      clearTimeout(watchdog)
      clearInterval(addressCheck)
      conn.bot = null
      conn.code = null
      bot.removeAllListeners('move')
      bot.on('error', () => {})
      try { bot.end() } catch {}
      if (spawnedAt && Date.now() - spawnedAt > STABLE_AFTER) conn.delay = FIRST_DELAY
      if (conn.wanted && (authFailed || blocksReconnect(kickReason))) conn.wanted = false
      if (!conn.wanted) return this.setStatus(conn, 'offline', message)
      const retryIn = conn.delay + Math.random() * RETRY_JITTER
      conn.retryAt = Date.now() + retryIn
      conn.timer = setTimeout(() => this.open(conn), retryIn)
      conn.delay = nextDelay(conn.delay)
      this.setStatus(conn, 'reconnecting', message)
    }

    bot._client.once('session', () => {
      signedIn = true
      conn.code = null
      this.setStatus(conn, 'connecting', '')
      watchdog = setTimeout(() => finish('Timed out joining the server'), SPAWN_TIMEOUT)
    })
    bot.on('error', err => {
      const message = err?.message || String(err)
      if (isNetworkError(err)) return finish(message)
      if (/Status code: 429/.test(message)) {
        conn.delay = Math.max(conn.delay, RATE_LIMIT_DELAY)
        return finish('Mojang refused the login: too many logins from this IP (429)')
      }
      if (!signedIn && this.botOptions.auth !== 'offline') {
        authFailed = true
        return finish(`Sign-in failed: ${message}`)
      }
      this.addChat(conn, `[client error] ${message}`) // parse errors don't end the connection
    })
    bot.on('kicked', reason => {
      kickReason = `${toText(reason)} ${JSON.stringify(reason)}`
      finish(`Kicked: ${toText(reason)}`)
    })
    bot.on('end', reason => finish(conn.wanted ? `Disconnected: ${reason ?? ''}` : ''))
    bot.once('spawn', () => {
      clearTimeout(watchdog)
      spawnedAt = Date.now()
      addressSeen = spawnedAt
      this.setStatus(conn, 'online', '')
    })
    // Many servers kick players who refuse their pack. It is never downloaded.
    bot.on('resourcePack', () => {
      if (bot._client.state !== 'configuration') bot.acceptResourcePack()
    })
    let sender = null
    // Prepended so the name is known before mineflayer turns this packet into 'message'.
    bot._client.prependListener('playerChat', data => {
      sender = data.senderName ? toText(data.senderName) : null
    })
    bot.on('message', (message, position) => {
      if (position !== 'game_info') this.addChat(conn, chatLine(message, position === 'chat' ? sender : null))
    })
    for (const event of ['windowOpen', 'windowClose', 'health', 'move', 'teamUpdated', 'teamCreated', 'teamMemberAdded']) {
      bot.on(event, () => this.emit('changed', conn.server.id))
    }
    bot.once('inject_allowed', () => {
      bot.inventory.on('updateSlot', () => this.emit('changed', conn.server.id))
    })
    bot.on('windowOpen', window => {
      window.on('updateSlot', () => this.emit('changed', conn.server.id))
    })
  }

  // ----- actions from the page -----

  liveBot (id) {
    const conn = this.conn(id)
    if (conn.status !== 'online' || !conn.bot) throw new Error('This connection is not online')
    return conn.bot
  }

  send (id, text) {
    const clean = String(text).replace(/[\r\n]+/g, ' ').trim()
    if (!clean) throw new Error('Nothing to send')
    this.liveBot(id).chat(clean)
  }

  // Same steps on every online account of a server, each reporting in conn.result.
  runGroup (address, text) {
    return this.runJobs(address, [{ steps: parseSteps(text) }])
  }

  // Every button in its saved order. One failing or skipped button must not stop the next.
  runAll (address) {
    this.checkKnownAddress(address)
    const { buttons } = this.settings(address)
    if (!buttons.length) throw new Error('This server has no buttons')
    return this.runJobs(address, buttons.map(({ label, steps }) => ({ label, steps: parseSteps(steps) })))
  }

  runJobs (address, jobs) {
    const conns = [...this.conns.values()].filter(c => c.status === 'online' && !c.captcha && this.addressOf(c) === address)
    const report = (conn, result) => {
      conn.result = result
      this.emit('changed', conn.server.id)
    }
    conns.forEach(async (conn, i) => {
      if (conn.running) return
      conn.running = true
      report(conn, 'Running…')
      await wait(i * STAGGER)
      const results = []
      for (const [j, { label, steps }] of jobs.entries()) {
        const result = namedIn(steps, conn.account.name)
          ? 'Skipped: named in the command'
          : await this.runSteps(conn, steps).catch(err => err.message)
        results.push(label ? `${label}: ${result}` : result)
        report(conn, [...results, ...(j < jobs.length - 1 ? ['Running…'] : [])].join(' · '))
      }
      conn.running = false
    })
    return { started: conns.length }
  }

  async runSteps (conn, steps) {
    const id = conn.server.id
    const results = []
    this.closeMenu(id) // a menu left open would be read as the one the steps open
    try {
      for (const step of steps) {
        if (step.type === 'close') this.closeMenu(id)
        if (step.type === 'click') {
          const item = await this.waitFor(conn, window => window?.slots[step.slot] ?? undefined, `Slot ${step.slot} did not appear`)
          if (item.name !== step.item) throw new Error(`Nothing to do: slot ${step.slot} is ${item.name}`)
          await this.pacedClick(id, step.slot)
        }
        if (step.type === 'clickAll') results.push(await this.clickAll(conn, step.item))
        if (step.type === 'send') {
          if (step.text.search(PLACEHOLDER) >= 0) results.push(await this.drain(conn, step.text))
          else {
            this.send(id, step.text)
            await wait(STEP_GAP)
          }
        }
      }
    } finally {
      if (conn.status === 'online') this.closeMenu(id)
    }
    return results.join(', ') || 'Done'
  }

  async waitFor (conn, find, failure) {
    const end = Date.now() + STEP_TIMEOUT
    while (Date.now() < end) {
      const found = find(this.liveBot(conn.server.id).currentWindow)
      if (found !== undefined) return found
      await wait(200)
    }
    throw new Error(failure)
  }

  // Keeps the gap either way; a server that never answers a click must not hang the steps.
  async pacedClick (id, slot) {
    await Promise.all([Promise.race([this.click(id, slot, 'left'), wait(STEP_GAP)]), wait(STEP_GAP)])
  }

  // Each slot once: a reward that stays the same after its click would otherwise repeat forever.
  async clickAll (conn, name) {
    const id = conn.server.id
    const clicked = new Set()
    const find = window => window?.slots.slice(0, window.inventoryStart).find(i => i?.name === name && !clicked.has(i.slot))
    let item = await this.waitFor(conn, find, `No ${name} in the menu`)
    while (item) {
      clicked.add(item.slot)
      await this.pacedClick(id, item.slot)
      item = find(this.liveBot(id).currentWindow)
    }
    return `Clicked ${clicked.size} ${name}`
  }

  async drain (conn, text) {
    let last = null
    for (let paid = 0; ; paid++) {
      const { command, shown, nothing } = fillAmounts(text, conn.readSidebar())
      if (nothing) return paid ? `All sent in ${paid} payment${paid === 1 ? '' : 's'}` : 'Nothing to send'
      if (shown === last) throw new Error(`Stuck at ${shown}: the payment changed nothing`)
      if (paid === MAX_PAYMENTS) throw new Error(`${shown} left after ${paid} payments`)
      this.send(conn.server.id, command)
      last = shown
      await wait(DRAIN_GAP)
    }
  }

  async click (id, slot, button) {
    const bot = this.liveBot(id)
    const window = bot.currentWindow
    if (!window) throw new Error('No menu is open')
    if (!Number.isInteger(slot) || slot < 0 || slot >= window.inventoryStart) throw new Error('Invalid slot')
    const [mouse, mode] = { left: [0, 0], right: [1, 0], shift: [0, 1] }[button] ?? []
    if (mouse === undefined) throw new Error('Invalid click')
    await bot.clickWindow(slot, mouse, mode)
  }

  closeMenu (id) {
    const bot = this.liveBot(id)
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
  }

  selectHotbar (id, slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw new Error('Invalid hotbar slot')
    this.liveBot(id).setQuickBarSlot(slot)
    this.emit('changed', id)
  }

  useItem (id) {
    this.liveBot(id).activateItem()
  }

  control (id, key, state) {
    if (!CONTROLS.includes(key)) throw new Error('Invalid control')
    this.liveBot(id).setControlState(key, !!state)
  }

  look (id, yawDelta, pitchDelta) {
    if (!Number.isFinite(yawDelta) || !Number.isFinite(pitchDelta)) throw new Error('Invalid look')
    const bot = this.liveBot(id)
    const pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, bot.entity.pitch + pitchDelta))
    return bot.look(bot.entity.yaw + yawDelta, pitch, true)
  }

  releaseControls () {
    for (const conn of this.conns.values()) {
      if (conn.status === 'online') conn.bot?.clearControlStates()
    }
  }

  // ----- what the page sees; tokens are never included -----

  summary () {
    return {
      signIn: this.signIn,
      maxAccounts: this.maxAccounts(),
      accounts: this.config.accounts.map(account => ({
        id: account.id,
        name: account.name,
        uuid: account.uuid,
        servers: account.servers.map(server => {
          const conn = this.conns.get(server.id)
          return { ...server, captcha: inCaptcha(conn), where: conn.status === 'online' && conn.bot && !conn.captcha ? serverName(conn.readSidebar()) : '', checkAddress: this.settings(this.addressOf(conn)).checkAddress, lobbyCommand: this.settings(this.addressOf(conn)).lobbyCommand ?? '', status: conn.status, message: conn.message, code: conn.code, retryAt: conn.retryAt }
        })
      }))
    }
  }

  // Kept out of summary(): scoreboards change constantly and would redraw the account list's buttons.
  groups () {
    const groups = new Map()
    for (const conn of this.conns.values()) {
      if (conn.status === 'offline') continue
      const address = this.addressOf(conn)
      if (!groups.has(address)) groups.set(address, { address, buttons: this.settings(address).buttons, accounts: [] })
      groups.get(address).accounts.push({
        id: conn.server.id,
        name: conn.account.name,
        status: conn.status,
        captcha: inCaptcha(conn),
        sidebar: conn.status === 'online' && conn.bot ? conn.readSidebar() : null,
        result: conn.result ?? ''
      })
    }
    return [...groups.values()]
  }

  // Apart from detail(): pictures are large and rarely change, chat and movement would resend them.
  maps (id) {
    const conn = this.conn(id)
    if (conn.status !== 'online' || !conn.bot) return { wall: null, loose: [] }
    const wall = mapWall(conn.frames, conn.maps)
    const walled = new Set(wall?.tiles.map(tile => tile.id))
    return {
      wall,
      loose: [...conn.maps].reverse().filter(([mapId]) => !walled.has(mapId)).map(([mapId, pixels]) => ({ id: mapId, pixels: pixels.toString('base64') }))
    }
  }

  detail (id) {
    const conn = this.conn(id)
    const bot = conn.status === 'online' ? conn.bot : null
    const window = bot?.currentWindow
    return {
      id,
      name: conn.account.name,
      address: `${conn.server.host}:${conn.server.port}`,
      status: conn.status,
      message: conn.message,
      chat: conn.chat,
      sidebar: bot ? conn.readSidebar() : null,
      mapsVersion: conn.mapsVersion ?? 0,
      captcha: inCaptcha(conn),
      menu: window
        ? {
            title: toText(window.title),
            size: window.inventoryStart,
            slots: window.slots.slice(0, window.inventoryStart).map(serializeItem)
          }
        : null,
      inventory: bot ? bot.inventory.slots.slice(9, 36).map(serializeItem) : [],
      hotbar: bot ? bot.inventory.slots.slice(36, 45).map(serializeItem) : [],
      selected: bot?.quickBarSlot ?? 0,
      health: bot?.health ?? null,
      food: bot?.food ?? null,
      position: bot?.entity?.position ? ['x', 'y', 'z'].map(k => Math.round(bot.entity.position[k] * 10) / 10) : null,
      yaw: bot?.entity?.yaw ?? null,
      pitch: bot?.entity?.pitch ?? null
    }
  }
}

module.exports = { Manager, VERSION, belowShown, blocksReconnect, fillAmounts, parseSteps, serverName, showsAddress, chatLine, toSignedByte, windowChecksum, isNetworkError, nextDelay, parseAddress, toText }

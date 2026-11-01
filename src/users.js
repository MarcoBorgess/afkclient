const { EventEmitter } = require('events')
const { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } = require('crypto')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const { Manager } = require('./bots')
const { createTokenStore } = require('./tokenCache')

const hashWith = promisify(scrypt)
const KEY_LENGTH = 64
const COST = 2 ** 17
const OLD_COST = 2 ** 14 // hashes stored without a cost; replaced at their next login
const MAX_MEMORY = 256 * 1024 * 1024
const MIN_PASSWORD = 12
const MAX_PASSWORD = 200
const DEFAULT_MAX_ACCOUNTS = 5
const LOCK_AFTER = 5
const NAME_LOCK_AFTER = 30
const LOCK_FOR = 15 * 60000
const MAX_HASHING = 2 // leaves threads free: DNS lookups for the accounts use the same pool
const SESSION_LIFE = 30 * 24 * 3600000
const NAME = /^[a-z0-9_.-]{2,32}$/
const DUMMY = { salt: '00', hash: '00'.repeat(KEY_LENGTH), cost: COST } // unknown names take as long as wrong passwords

function fail (message, status) {
  return Object.assign(new Error(message), { status })
}

function cleanName (name) {
  const clean = String(name ?? '').trim().toLowerCase()
  if (!NAME.test(clean)) throw new Error('A username is 2 to 32 letters, numbers, dots, dashes or underscores')
  return clean
}

function checkPassword (password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new Error(`A password is ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`)
  }
}

function cleanMax (value) {
  const max = Number(value)
  if (!Number.isInteger(max) || max < 0 || max > 100) throw new Error('The account limit is a whole number from 0 to 100')
  return max
}

async function hashPassword (password) {
  const salt = randomBytes(16).toString('hex')
  return { salt, cost: COST, hash: (await hashWith(password, salt, KEY_LENGTH, { N: COST, maxmem: MAX_MEMORY })).toString('hex') }
}

async function passwordMatches (password, { salt, hash, cost = OLD_COST }) {
  return timingSafeEqual(await hashWith(String(password), salt, KEY_LENGTH, { N: cost, maxmem: MAX_MEMORY }), Buffer.from(hash, 'hex'))
}

// Servers can be listed exactly or as *.example.com. Anything else, internal addresses included, is refused.
function serverMatches (patterns, host) {
  return patterns.some(pattern => pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern)
}

class Users extends EventEmitter {
  constructor ({ dataDir, tokenKey, adminName, adminPassword, allowedServers = ['*'], managerOptions = {} }) {
    super()
    this.dataDir = dataDir
    this.tokenKey = tokenKey
    this.allowedServers = allowedServers
    this.managerOptions = managerOptions
    this.hashing = 0
    this.file = path.join(dataDir, 'users.json')
    this.managers = new Map()
    // shortcut: sessions live in memory, so a restart asks everyone to log in again; store them if that gets annoying.
    this.sessions = new Map()
    this.failures = new Map()
    fs.mkdirSync(dataDir, { recursive: true })
    try {
      this.list = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      // A damaged file must not be overwritten, that would lose every account.
      if (err.code !== 'ENOENT') throw new Error(`Cannot read ${this.file}: ${err.message}`)
      this.list = []
    }
    if (!this.list.length) {
      if (!adminName || !adminPassword) throw new Error('Set ADMIN_USER and ADMIN_PASSWORD to create the first user')
      checkPassword(adminPassword)
      const salt = randomBytes(16).toString('hex')
      this.list.push({ id: randomUUID(), name: cleanName(adminName), admin: true, maxAccounts: DEFAULT_MAX_ACCOUNTS, salt, cost: COST, hash: scryptSync(adminPassword, salt, KEY_LENGTH, { N: COST, maxmem: MAX_MEMORY }).toString('hex') })
      this.save()
    }
    for (const user of this.list) this.startManager(user)
  }

  save () {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.list, null, 2))
    fs.renameSync(this.file + '.tmp', this.file)
  }

  userDir (id) {
    return path.join(this.dataDir, 'users', id)
  }

  // One Manager per user: accounts, buttons and settings stay separate because nothing is shared.
  startManager (user) {
    const dir = this.userDir(user.id)
    const manager = new Manager({
      dataDir: dir,
      tokens: createTokenStore(path.join(dir, 'tokens'), this.tokenKey),
      maxAccounts: () => this.user(user.id).maxAccounts,
      isTaken: uuid => [...this.managers.values()].some(m => m.config.accounts.some(a => a.uuid === uuid)),
      isAllowedServer: host => this.allowedServers.includes('*') || serverMatches(this.allowedServers, host),
      ...this.managerOptions
    })
    manager.on('changed', id => this.emit('changed', user.id, id))
    this.managers.set(user.id, manager)
  }

  user (id) {
    const user = this.list.find(u => u.id === id)
    if (!user) throw new Error('Unknown user')
    return user
  }

  manager (id) {
    return this.managers.get(id)
  }

  autoConnectAll () {
    // One after another across users: Mojang limits logins per IP, and they all share this one.
    let start = 0
    for (const manager of this.managers.values()) start = manager.autoConnectAll(undefined, start)
  }

  shutdown () {
    for (const manager of this.managers.values()) manager.shutdown()
  }

  // ----- logging in -----

  async login (name, password, ip = '') {
    const key = String(name ?? '').trim().toLowerCase()
    if (!NAME.test(key) || typeof password !== 'string' || password.length > MAX_PASSWORD) throw fail('Wrong username or password', 401)
    const now = Date.now()
    for (const [k, f] of this.failures) if (f.until <= now) this.failures.delete(k)
    // A stranger only locks themselves out of a name; many strangers together still hit a ceiling.
    const fromIp = `ip ${ip} ${key}`
    const fromAnywhere = `name ${key}`
    if (this.failures.get(fromIp)?.count >= LOCK_AFTER || this.failures.get(fromAnywhere)?.count >= NAME_LOCK_AFTER) throw fail('Too many attempts, try again in 15 minutes', 429)
    if (this.hashing >= MAX_HASHING) throw fail('Too many logins right now, try again in a moment', 429)
    // Counted before the slow hash, or parallel guesses would all see the old count.
    for (const k of [fromIp, fromAnywhere]) this.failures.set(k, { count: (this.failures.get(k)?.count ?? 0) + 1, until: now + LOCK_FOR })
    const user = this.list.find(u => u.name === key)
    this.hashing++
    let matches = false
    try {
      matches = await passwordMatches(password, user ?? DUMMY)
    } finally {
      this.hashing--
    }
    if (!user || !matches) throw fail('Wrong username or password', 401)
    this.failures.delete(fromIp)
    const anywhere = this.failures.get(fromAnywhere)
    if (anywhere) anywhere.count--
    if (user.cost !== COST) {
      Object.assign(user, await hashPassword(password))
      this.save()
    }
    const token = randomBytes(32).toString('hex')
    this.sessions.set(token, { userId: user.id, expires: now + SESSION_LIFE })
    return token
  }

  session (token) {
    const session = this.sessions.get(token)
    if (!session) return null
    if (session.expires > Date.now()) return session
    this.sessions.delete(token)
    return null
  }

  logout (token) {
    this.sessions.delete(token)
  }

  endSessions (userId) {
    for (const [token, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(token)
    }
  }

  async changePassword (userId, current, next) {
    if (!await passwordMatches(current, this.user(userId))) throw new Error('The current password is wrong')
    await this.setPassword(userId, next)
  }

  async setPassword (userId, password) {
    checkPassword(password)
    Object.assign(this.user(userId), await hashPassword(password))
    this.endSessions(userId) // a leaked password must not leave a thief logged in
    this.save()
  }

  // ----- admin -----

  overview () {
    return this.list.map(({ id, name, admin, maxAccounts }) => ({ id, name, admin: !!admin, maxAccounts, accounts: this.manager(id).config.accounts.length }))
  }

  async create (name, password, maxAccounts) {
    const clean = cleanName(name)
    const max = cleanMax(maxAccounts)
    checkPassword(password)
    if (this.list.some(u => u.name === clean)) throw new Error(`${clean} already exists`)
    const hashed = await hashPassword(password)
    if (this.list.some(u => u.name === clean)) throw new Error(`${clean} already exists`) // created while hashing
    const user = { id: randomUUID(), name: clean, admin: false, maxAccounts: max, ...hashed }
    this.list.push(user)
    this.save()
    this.startManager(user)
  }

  setMaxAccounts (id, value) {
    this.user(id).maxAccounts = cleanMax(value)
    this.save()
    this.manager(id).emit('changed')
  }

  async remove (id, byId) {
    if (id === byId) throw new Error('You cannot remove yourself')
    this.user(id)
    this.manager(id).shutdown()
    this.managers.delete(id)
    this.endSessions(id)
    this.list = this.list.filter(u => u.id !== id)
    this.save()
    await fs.promises.rm(this.userDir(id), { recursive: true, force: true })
  }
}

module.exports = { Users }

const { EventEmitter } = require('events')
const { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } = require('crypto')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const { Manager } = require('./bots')
const { createTokenStore } = require('./tokenCache')

const hashWith = promisify(scrypt)
const KEY_LENGTH = 64
const MIN_PASSWORD = 8
const MAX_PASSWORD = 200
const DEFAULT_MAX_ACCOUNTS = 5
const LOCK_AFTER = 5
const LOCK_FOR = 15 * 60000
const SESSION_LIFE = 30 * 24 * 3600000
const NAME = /^[a-z0-9_.-]{2,32}$/
const DUMMY = { salt: '00', hash: '00'.repeat(KEY_LENGTH) } // unknown names take as long as wrong passwords

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
  return { salt, hash: (await hashWith(password, salt, KEY_LENGTH)).toString('hex') }
}

async function passwordMatches (password, { salt, hash }) {
  return timingSafeEqual(await hashWith(String(password), salt, KEY_LENGTH), Buffer.from(hash, 'hex'))
}

class Users extends EventEmitter {
  constructor ({ dataDir, tokenKey, adminName, adminPassword, managerOptions = {} }) {
    super()
    this.dataDir = dataDir
    this.tokenKey = tokenKey
    this.managerOptions = managerOptions
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
      this.list.push({ id: randomUUID(), name: cleanName(adminName), admin: true, maxAccounts: DEFAULT_MAX_ACCOUNTS, salt, hash: scryptSync(adminPassword, salt, KEY_LENGTH).toString('hex') })
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
    for (const manager of this.managers.values()) manager.autoConnectAll()
  }

  shutdown () {
    for (const manager of this.managers.values()) manager.shutdown()
  }

  // ----- logging in -----

  async login (name, password) {
    const key = String(name ?? '').trim().toLowerCase().slice(0, 32)
    const now = Date.now()
    for (const [k, f] of this.failures) if (f.until <= now) this.failures.delete(k)
    const failure = this.failures.get(key)
    if (failure?.count >= LOCK_AFTER) throw fail('Too many attempts, try again in 15 minutes', 429)
    const user = this.list.find(u => u.name === key)
    const matches = await passwordMatches(password, user ?? DUMMY)
    if (!user || !matches) {
      this.failures.set(key, { count: (failure?.count ?? 0) + 1, until: now + LOCK_FOR })
      throw fail('Wrong username or password', 401)
    }
    this.failures.delete(key)
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

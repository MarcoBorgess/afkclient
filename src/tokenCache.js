const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('crypto')
const fs = require('fs')
const path = require('path')

const IV_LENGTH = 12
const TAG_LENGTH = 16

function encrypt (key, text) {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

function decrypt (key, encoded) {
  const data = Buffer.from(encoded, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_LENGTH))
  decipher.setAuthTag(data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH))
  return Buffer.concat([decipher.update(data.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString('utf8')
}

// Same interface as prismarine-auth's FileCache, but encrypted with TOKEN_KEY.
class EncryptedCache {
  constructor (file, key) {
    this.file = file
    this.key = key
    this.writes = Promise.resolve()
  }

  getCached () {
    this.loaded ??= this.load()
    return this.loaded
  }

  async load () {
    try {
      this.cache = JSON.parse(decrypt(this.key, await fs.promises.readFile(this.file, 'utf8')))
    } catch {
      this.cache = {} // missing or unreadable: the account signs in again
    }
    return this.cache
  }

  async setCached (value) {
    this.cache = value
    this.loaded = Promise.resolve(value)
    // Queued so overlapping saves can't race; each one writes the newest state.
    const write = this.writes.then(() => this.save())
    this.writes = write.catch(() => {})
    return write
  }

  async setCachedPartial (value) {
    await this.getCached()
    return this.setCached({ ...this.cache, ...value })
  }

  reset () {
    return this.setCached({})
  }

  async save () {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
    await fs.promises.writeFile(this.file + '.tmp', encrypt(this.key, JSON.stringify(this.cache)))
    await fs.promises.rename(this.file + '.tmp', this.file)
  }
}

function createTokenStore (dir, secret) {
  const key = createHash('sha256').update(secret).digest()
  const caches = new Map() // shared so one account's connections see each other's refreshed tokens
  const prefix = username => createHash('sha256').update(username).digest('hex').slice(0, 32) + '_'
  return {
    factory ({ username, cacheName }) {
      const file = path.join(dir, `${prefix(username)}${cacheName}.dat`)
      if (!caches.has(file)) caches.set(file, new EncryptedCache(file, key))
      return caches.get(file)
    },
    async remove (username) {
      const start = prefix(username)
      for (const [file, cache] of caches) {
        if (path.basename(file).startsWith(start)) {
          await cache.writes
          caches.delete(file)
        }
      }
      const names = await fs.promises.readdir(dir).catch(() => [])
      await Promise.all(names.filter(n => n.startsWith(start))
        .map(n => fs.promises.rm(path.join(dir, n), { force: true })))
    }
  }
}

module.exports = { createTokenStore }

const { execFile } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')

function dpapi (method, base64) {
  // The secret goes over stdin because command-line arguments are visible to other processes.
  const script = 'Add-Type -AssemblyName System.Security;' +
    '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}($b,$null,'CurrentUser'))`
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()))
    child.stdin.end(base64)
  })
}

// Same interface as prismarine-auth's FileCache, but encrypted for the current Windows user.
class DpapiCache {
  constructor (file) {
    this.file = file
    this.writes = Promise.resolve()
  }

  getCached () {
    this.loaded ??= this.load()
    return this.loaded
  }

  async load () {
    try {
      const encrypted = await fs.promises.readFile(this.file, 'utf8')
      const plain = await dpapi('Unprotect', encrypted)
      this.cache = JSON.parse(Buffer.from(plain, 'base64').toString('utf8'))
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
    const plain = Buffer.from(JSON.stringify(this.cache), 'utf8').toString('base64')
    const encrypted = await dpapi('Protect', plain)
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
    await fs.promises.writeFile(this.file + '.tmp', encrypted)
    await fs.promises.rename(this.file + '.tmp', this.file)
  }
}

function createTokenStore (dir) {
  const caches = new Map() // shared so one account's connections see each other's refreshed tokens
  const prefix = username => createHash('sha256').update(username).digest('hex').slice(0, 32) + '_'
  return {
    factory ({ username, cacheName }) {
      const file = path.join(dir, `${prefix(username)}${cacheName}.dat`)
      if (!caches.has(file)) caches.set(file, new DpapiCache(file))
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

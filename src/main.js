const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { Manager } = require('./bots')
const { startServer } = require('./server')
const { createTokenStore } = require('./tokenCache')

const PORT = 25599
const URL = `http://127.0.0.1:${PORT}/`
const dataDir = path.join(process.env.LOCALAPPDATA, 'afkclient')

// Started from start.bat: relaunch with no console window, then let the bat close.
if (!process.argv.includes('--background')) {
  fs.mkdirSync(dataDir, { recursive: true })
  const log = fs.openSync(path.join(dataDir, 'app.log'), 'a') // with no console, this is the only trace of a failure
  spawn(process.execPath, [__filename, '--background'], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()
  process.exit(0)
}

const openPage = () => spawn('cmd', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref()

const manager = new Manager({ dataDir, tokens: createTokenStore(path.join(dataDir, 'tokens')) })

function quit () {
  manager.shutdown()
  setTimeout(() => process.exit(0), 500) // lets the disconnect packets and the page's reply go out
}

const server = startServer(manager, PORT, quit)

server.on('error', err => {
  // Already running: double-clicking again just reopens the page, and the new copy must not connect too.
  if (err.code === 'EADDRINUSE') {
    openPage()
    process.exit(0)
  }
  throw err
})
server.on('listening', () => {
  console.log(`${new Date().toISOString()} AFK Client is running at ${URL}`)
  openPage()
  manager.autoConnectAll()
})

// One bad packet from one server must not drop every other account.
process.on('uncaughtException', err => console.error(new Date().toISOString(), 'Unexpected error:', err))
process.on('SIGINT', quit)

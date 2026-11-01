const path = require('path')
const { startServer } = require('./server')
const { Users } = require('./users')

const PORT = Number(process.env.PORT ?? 25599)
const HOST = process.env.HOST ?? '127.0.0.1'
const LOCAL = HOST === '127.0.0.1'
const IP_CHECK = 10 * 60000
const SERVERS = process.env.ALLOWED_SERVERS ?? 'cobblestone.gg,*.cobblestone.gg,minehut.gg,*.minehut.gg'
const allowedHosts = process.env.PUBLIC_HOSTS?.split(',').map(host => host.trim().toLowerCase()).filter(Boolean) ??
  (LOCAL ? [`127.0.0.1:${PORT}`, `localhost:${PORT}`] : null)

function stop (message) {
  console.error(`${new Date().toISOString()} ${message}`)
  process.exit(1)
}

if (!allowedHosts?.length) stop('Set PUBLIC_HOSTS to the address of this site, for example afkparmegio.squareweb.app')
if ((process.env.TOKEN_KEY ?? '').length < 32) stop('Set TOKEN_KEY to a random value of at least 32 characters')

let users
try {
  users = new Users({
    dataDir: process.env.DATA_DIR ?? path.join(__dirname, '..', 'data'),
    tokenKey: process.env.TOKEN_KEY,
    adminName: process.env.ADMIN_USER,
    adminPassword: process.env.ADMIN_PASSWORD,
    allowedServers: SERVERS.split(',').map(server => server.trim().toLowerCase()).filter(Boolean)
  })
} catch (err) {
  stop(err.message)
}

// Servers limit accounts per IP, and the host can change this one, so the admin needs to see it.
async function checkOutgoingIp () {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(10000) })
    const ip = (await res.text()).trim()
    if (ip !== users.outgoingIp) console.log(`${new Date().toISOString()} Outgoing IP: ${ip}`)
    users.outgoingIp = ip
  } catch {} // only informative, and retried below
}

function quit () {
  users.shutdown()
  setTimeout(() => process.exit(0), 500) // lets the disconnect packets go out
}

const server = startServer(users, { port: PORT, host: HOST, allowedHosts, secure: !LOCAL })

server.on('listening', () => {
  console.log(`${new Date().toISOString()} AFK Client is running on ${HOST}:${PORT}`)
  users.autoConnectAll()
  checkOutgoingIp()
  setInterval(checkOutgoingIp, IP_CHECK).unref()
})

// One bad packet from one server must not drop every other account.
process.on('uncaughtException', err => console.error(new Date().toISOString(), 'Unexpected error:', err))
process.on('SIGINT', quit)
process.on('SIGTERM', quit)

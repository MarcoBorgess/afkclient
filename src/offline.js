// "Caiu" alert: a bot that should be in the game (not disconnected with the button) and has been out for 3 minutes
// straight - disconnected, reconnecting, or parked in the Minehut lobby - posts once to its server's webhook,
// and posts again when it is back. The webhook is per server per account: conn.server.guild.offlineWebhook.

const DOWN_AFTER = 3 * 60000
const CHECK_EVERY = 15000

// Pure, for the self-check: what to post now, if anything. state = { since, alerted }.
function offlineStep (state, { wanted, up }, now) {
  if (!wanted) return { state: { since: null, alerted: false }, post: null } // stopped with the button: no alert, no "back"
  if (up) return { state: { since: null, alerted: false }, post: state.alerted ? { kind: 'back', downFor: now - state.since } : null }
  const since = state.since ?? now
  if (!state.alerted && now - since >= DOWN_AFTER) return { state: { since, alerted: true }, post: { kind: 'down' } }
  return { state: { since, alerted: state.alerted }, post: null }
}

const minutes = ms => `${Math.max(1, Math.round(ms / 60000))} min`

function offlineMessage (post, name, address, reason) {
  return post.kind === 'down'
    ? { content: `🔴 **${name}** caiu de ${address} há 3 min${reason ? ` — ${reason}` : ''}` }
    : { content: `🟢 **${name}** voltou para ${address} (fora por ${minutes(post.downFor)})` }
}

// manager: conns, addressOf(conn), isUp(conn), post(url, png, filename, payload), addChat(conn, text)
function watchOffline (manager) {
  const timer = setInterval(() => {
    const now = Date.now()
    for (const conn of manager.conns.values()) {
      const step = offlineStep(conn.offline ?? {}, { wanted: conn.wanted, up: manager.isUp(conn) }, now)
      conn.offline = step.state
      const url = conn.server.guild?.offlineWebhook
      if (!step.post || !url) continue
      const payload = offlineMessage(step.post, conn.account.name, manager.addressOf(conn), conn.message)
      manager.post(url, null, null, payload).catch(err => manager.addChat(conn, `[offline] Discord: ${err.message}`))
    }
  }, CHECK_EVERY)
  timer.unref()
  return timer
}

module.exports = { offlineStep, offlineMessage, watchOffline, DOWN_AFTER }

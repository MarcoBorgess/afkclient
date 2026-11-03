// Guild tracking for Cobblestone, per connection: a post when a member completes a guild
// quest, and the guild ranking (/stats of every member) every 3 hours. Both read /guild.
const path = require('path')
const { setTimeout: wait } = require('timers/promises')
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas')

// The host has no fonts installed, so text would come out blank without these.
GlobalFonts.registerFromPath(path.join(__dirname, '..', 'fonts', 'inter-400.ttf'), 'Inter')
GlobalFonts.registerFromPath(path.join(__dirname, '..', 'fonts', 'inter-700.ttf'), 'Inter')

const WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/
const ROLE_ID = /^\d{5,25}$/
const AFTER_RESET = 15000 // the new quests need a moment to show up
const SAME_HOUR = 120000 // the countdown is read at slightly different moments
const SKIN_HOST = /^https?:\/\/textures\.minecraft\.net\//
const SETTLE = 400 // a menu's slots arrive a moment after it opens
const MENU_TIMEOUT = 10000
const DEFAULT_TIMING = {
  ready: 10000, // in the game this long before the first /guild
  snapshot: 30 * 60000,
  questDelay: 3000,
  questRetries: [10000, 30000],
  statsGap: [6000, 8000], // the server's /stats cooldown is about 5s
  cooldownStep: 2000,
  cooldownMax: 10000,
  maxCooldowns: 8,
  afterReset: AFTER_RESET
}
const NUMBER = /(\d[\d,]*(?:\.\d+)?)\s*([kmbt%])?(?![a-z])/i
const between = ([min, max]) => min + Math.random() * (max - min)

// ----- reading menus -----

function skinUrl (profile) {
  for (const property of profile?.properties ?? []) {
    if (property.name !== 'textures') continue
    try {
      const url = JSON.parse(Buffer.from(property.value, 'base64').toString('utf8')).textures?.SKIN?.url
      if (SKIN_HOST.test(url ?? '')) return url // the server picks this URL, so only Mojang's skin host is fetched
    } catch {}
  }
  return null
}

// Member heads only: icon heads such as GUILD INFO wear someone's skin without their name on them.
function readMembers (slots) {
  const members = []
  for (const slot of slots) {
    const name = slot?.profile?.name
    if (slot?.id !== 'player_head' || !/^\w{3,16}$/.test(name ?? '')) continue
    const text = slot.lines.join('\n')
    if (!text.toLowerCase().includes(name.toLowerCase()) || members.some(m => m.name === name)) continue
    const quests = /(\d[\d,]*)\s+quests?\s+completed/i.exec(text)
    const shown = label => new RegExp(`(\\d[\\d,.]*[kmbt]?)\\s+${label}`, 'i').exec(text)?.[1] ?? null
    members.push({ name, quests: quests ? Number(quests[1].replace(/,/g, '')) : null, crops: shown('crops farmed'), last24h: shown('last 24h'), skin: skinUrl(slot.profile) })
  }
  return members
}

// The /guild quests menu: QUEST INFO (totals and the reset countdown) and the five quests.
function readQuests (slots, now = Date.now()) {
  const info = slots.find(slot => slot && /^quest info$/i.test(slot.lines[0] ?? ''))
  if (!info) return null
  const text = info.lines.join('\n')
  const countdown = /available in[\s\S]*?((?:\d+\s*[hms]\s*)+)/i.exec(text)?.[1] ?? ''
  const seconds = [...countdown.matchAll(/(\d+)\s*([hms])/gi)].reduce((sum, [, n, unit]) => sum + Number(n) * { h: 3600, m: 60, s: 1 }[unit.toLowerCase()], 0)
  const number = label => Number(new RegExp(`${label}:\\D*([\\d,]+)`, 'i').exec(text)?.[1].replace(/,/g, '') ?? NaN)
  const quests = slots.filter(slot => slot && slot !== info && /quest/i.test(slot.lines[0] ?? '') && slot.lines.some(line => /progress:/i.test(line))).map(slot => {
    const rows = slot.lines.filter(line => line.startsWith('|')).map(line => line.replace(/^\|\s*/, ''))
    const progress = /progress:\s*([\d,]+)\s*\/\s*([\d,]+)/i.exec(slot.lines.join('\n'))
    const [done, goal] = progress ? [progress[1], progress[2]].map(n => Number(n.replace(/,/g, ''))) : [0, 1]
    return {
      name: slot.lines[0].replace(/^\W*\([^)]*\)\s*/, '').trim(), // "(⏺) FARMING QUEST #1"
      task: rows.find(row => !/^progress:/i.test(row) && !/guild points/i.test(row)) ?? '',
      points: /([\d,]+)\s*guild points/i.exec(slot.lines.join('\n'))?.[1] ?? '?',
      done: done >= goal
    }
  })
  return { quests, total: number('total quests'), points: number('guild points'), endsAt: seconds ? now + seconds * 1000 : null }
}

// Ties share a place: 15, 15, 14 are #1, #1, #3.
const questRank = (members, member) => 1 + members.filter(m => m.quests > member.quests).length

function questRises (before, after) {
  return after.filter(m => m.quests !== null && before.get(m.name)?.quests != null && m.quests > before.get(m.name).quests)
}

// "Completion 18.1%" or "Total: 257,500", the number after the keyword, else on the next line.
function findValue (lines, keyword) {
  for (const [i, line] of lines.entries()) {
    const at = line.toLowerCase().indexOf(keyword)
    if (at < 0) continue
    const match = NUMBER.exec(line.slice(at + keyword.length)) ?? NUMBER.exec(lines[i + 1] ?? '')
    if (match) return match[0].trim()
  }
  return null
}

function numberValue (shown) {
  const match = shown && NUMBER.exec(shown)
  if (!match) return -1
  return Number(match[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[match[2]?.toLowerCase()] ?? 1)
}

// Brazil has had no daylight saving since 2019, so Brasília is always UTC-3.
function rankingSlot (now = Date.now()) {
  const brasilia = new Date(now - 3 * 3600000)
  return `${brasilia.toISOString().slice(0, 10)}/${Math.floor(brasilia.getUTCHours() / 3)}`
}

// ----- pictures -----

const BG = '#2b2d31'
const MEDAL = ['#e6b422', '#b8bcc4', '#c07a3e']

async function download (url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    return res.ok ? await loadImage(Buffer.from(await res.arrayBuffer())) : null
  } catch {
    return null
  }
}

// The face and hat cut from the skin the /guild head carried, else mc-heads.net (it throttles, so twice), else grey.
async function drawHead (ctx, member, x, y, size) {
  ctx.imageSmoothingEnabled = false
  const skin = member.skin && await download(member.skin)
  if (skin?.width >= 64) {
    ctx.drawImage(skin, 8, 8, 8, 8, x, y, size, size)
    ctx.drawImage(skin, 40, 8, 8, 8, x, y, size, size)
    return
  }
  const avatar = `https://mc-heads.net/avatar/${encodeURIComponent(member.name)}/${size}`
  const image = await download(avatar) ?? await download(avatar)
  if (image) ctx.drawImage(image, x, y, size, size)
  else {
    ctx.fillStyle = '#4e5058'
    ctx.fillRect(x, y, size, size)
  }
}

function centered (ctx, text, x, y, font, color) {
  ctx.font = font
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.fillText(text, x, y)
}

// A banner: the head on the left, the nick and the quest count beside it.
async function questImage (member, rank) {
  const canvas = createCanvas(600, 160)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, 600, 160)
  await drawHead(ctx, member, 16, 16, 128)
  ctx.textAlign = 'left'
  ctx.font = 'bold 32px Inter'
  ctx.fillStyle = '#ffffff'
  ctx.fillText(member.name, 168, 70)
  ctx.font = '24px Inter'
  ctx.fillStyle = '#b5bac1'
  ctx.fillText(`Completou sua Quest ${member.quests} [#${rank}]`, 168, 112)
  return canvas.encode('png')
}

const GREEN = '#57f287'
const segments = value => typeof value === 'string' ? [[value, null]] : value

// Pieces of one line in their own colors, the whole line centered or left-aligned at x.
function drawLine (ctx, value, x, y, font, color, center) {
  ctx.font = font
  ctx.textAlign = 'left'
  const parts = segments(value)
  let left = center ? x - parts.reduce((width, [text]) => width + ctx.measureText(text).width, 0) / 2 : x
  for (const [text, own] of parts) {
    ctx.fillStyle = own ?? color
    ctx.fillText(text, left, y)
    left += ctx.measureText(text).width
  }
}

const shown = value => value ?? '?'
const COMPLETION_LAYOUT = {
  title: 'Guild Ranking',
  top: p => [`Completion: ${shown(p.completion)}`, `Crops: ${shown(p.crops)}`],
  columns: [['COMPLETION', 520, p => shown(p.completion)], ['CROPS FARMED', 700, p => shown(p.crops)]]
}

function questLayout (players, footer) {
  const count = p => [[String(shown(p.quests)), null], ...(p.delta ? [[` (+${p.delta})`, GREEN]] : [])]
  return {
    title: 'Guild Quests',
    top: p => [[['Quests: ', null], ...count(p)], `Crops: ${shown(p.crops)}`],
    columns: [['QUESTS', 430, count], ['CROPS FARMED', 590, p => shown(p.crops)], ['LAST 24H', 760, p => shown(p.last24h)]],
    place: (p, i) => questRank(players, p),
    footer
  }
}

// Same layout as CobbleUtils: the top three on a podium, everyone else listed below.
async function podiumImage (players, layout = COMPLETION_LAYOUT) {
  const W = 900
  const BASE = 470
  const ROW = 44
  const rest = Math.max(0, players.length - 3)
  const H = BASE + 30 + (rest ? 34 + rest * ROW : 0) + (layout.footer ? 40 : 0)
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, W, H)
  drawLine(ctx, layout.title, W / 2, 50, 'bold 30px Inter', '#ffffff', true)

  const spots = [[1, 210, 125], [0, 450, 170], [2, 690, 95]] // place, center, block height: 2nd, 1st, 3rd
  for (const [place, cx, block] of spots) {
    const p = players[place]
    if (!p) continue
    const top = BASE - block
    ctx.fillStyle = MEDAL[place]
    ctx.beginPath()
    ctx.roundRect(cx - 100, top, 200, block + 10, 7)
    ctx.fill()
    drawLine(ctx, String(place + 1), cx, top + Math.min(block, 120) / 2 + 24, 'bold 64px Inter', 'rgba(0,0,0,0.35)', true)
    const size = place === 0 ? 120 : 96
    await drawHead(ctx, p, cx - size / 2, top - 88 - size, size)
    ctx.strokeStyle = MEDAL[place]
    ctx.lineWidth = 3
    ctx.strokeRect(cx - size / 2, top - 88 - size, size, size)
    const [first, second] = layout.top(p)
    drawLine(ctx, p.name, cx, top - 60, 'bold 22px Inter', '#ffffff', true)
    drawLine(ctx, first, cx, top - 36, 'bold 20px Inter', '#ffffff', true)
    drawLine(ctx, second, cx, top - 14, '16px Inter', '#b5bac1', true)
  }

  let y = BASE + 40
  if (rest) {
    for (const [label, x] of [['#', 60], ['PLAYER', 150], ...layout.columns]) drawLine(ctx, label, x, y, 'bold 14px Inter', '#80848e')
    for (let i = 3; i < players.length; i++) {
      const p = players[i]
      const rowTop = y + 10 + (i - 3) * ROW
      if (i % 2 === 1) {
        ctx.fillStyle = '#313338'
        ctx.fillRect(40, rowTop, W - 80, ROW)
      }
      await drawHead(ctx, p, 100, rowTop + 6, 32)
      const text = rowTop + 28
      drawLine(ctx, `#${layout.place?.(p, i) ?? i + 1}`, 52, text, 'bold 18px Inter', '#b5bac1')
      drawLine(ctx, p.name, 150, text, 'bold 18px Inter', '#ffffff')
      layout.columns.forEach(([, x, value], column) => drawLine(ctx, value(p), x, text, `${column ? '' : 'bold '}18px Inter`, '#ffffff'))
    }
    y += 10 + rest * ROW
  }
  if (layout.footer) drawLine(ctx, layout.footer, W / 2, y + 40, '18px Inter', '#b5bac1', true)
  return canvas.encode('png')
}

// The reset message: text, so the role ping works and it reads well on a phone.
function questsMessage ({ quests, endsAt }, previous, points, roleId) {
  const icon = name => /farm/i.test(name) ? '⛏' : /mob/i.test(name) ? '⚔' : /play/i.test(name) ? '⏱' : '•'
  const label = name => name.replace(/\s*quest\s*/i, ' ').trim().toLowerCase().replace(/^\w/, c => c.toUpperCase())
  const until = endsAt ? ` (até ${new Date(endsAt - 3 * 3600000).toISOString().slice(11, 16)})` : ''
  const footer = [previous ? `Hora passada: ${previous.quests.filter(q => q.done).length}/${previous.quests.length} feitas` : '', Number.isFinite(points) ? `Guild Points ${points}` : ''].filter(Boolean).join(' · ')
  return {
    content: roleId ? `<@&${roleId}>` : '',
    allowed_mentions: { roles: roleId ? [roleId] : [] },
    embeds: [{
      title: `🆕 Novas quests da guilda${until}`,
      description: quests.map(q => `${icon(q.name)} **${label(q.name)}** — ${q.task} · ${q.points} pts`).join('\n'),
      color: 0x5865f2,
      ...(footer ? { footer: { text: footer } } : {})
    }]
  }
}

// No png: a plain message.
async function postWebhook (url, png, filename, payload = {}) {
  let body = JSON.stringify(payload)
  if (png) {
    body = new FormData()
    body.append('payload_json', JSON.stringify(payload))
    body.append('files[0]', new Blob([png], { type: 'image/png' }), filename)
  }
  const res = await fetch(url, { method: 'POST', body, headers: png ? {} : { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`Discord refused it: HTTP ${res.status}`)
}

// ----- running on a connection -----

// Started when the bot connects. Returns a function that stops it.
// manager: send, closeMenu, liveBot, addChat, save; ready(): in the game, not in a lobby or captcha.
function attachGuild (manager, conn, bot, { ready, plain, lines, toText }) {
  const timing = { ...DEFAULT_TIMING, ...manager.guildTiming }
  const post = manager.postWebhook ?? postWebhook
  const id = conn.server.id
  const settings = () => conn.server.guild ?? {}
  const log = text => manager.addChat(conn, `[guild] ${text}`)
  let readySince = 0
  let lastSnapshot = 0
  let checkPending = false
  let cooldownAt = 0
  let refusedAt = 0
  let stopped = false
  let resetTimer = null
  let resetPending = false
  conn.guildMembers ??= new Map()

  bot.on('message', message => {
    const text = plain(message.toString())
    if (text.includes('wait a moment before using /stats')) cooldownAt = Date.now()
    if (text.includes('view that player') && text.includes('stats')) refusedAt = Date.now()
    if (text.includes('guild quest complete') && settings().track && !checkPending) {
      checkPending = true
      setTimeout(() => checkQuests().catch(err => log(`Quest check failed: ${err.message}`)), timing.questDelay)
    }
    // "GUILDS • New guild quests have become available!" The countdown timer stays as the fallback.
    if (text.includes('new guild quests have become available') && settings().track && !resetPending) {
      resetPending = true
      setTimeout(() => {
        resetPending = false
        readAgain().catch(err => log(`Reading /guild quests failed: ${err.message}`))
      }, timing.questDelay)
    }
  })

  // One menu at a time per account, shared with the group buttons.
  async function exclusive (task) {
    while (conn.running) await wait(500)
    if (stopped) throw new Error('Disconnected')
    conn.running = true
    try {
      return await task()
    } finally {
      conn.running = false
    }
  }

  // gaveUp: an answer in chat that means no menu is coming.
  async function settledWindow (wanted, gaveUp = () => null) {
    const end = Date.now() + MENU_TIMEOUT
    let last = null
    let since = 0
    while (Date.now() < end) {
      const answer = gaveUp()
      if (answer) return answer
      const window = manager.liveBot(id).currentWindow
      const slots = window ? window.slots.slice(0, window.inventoryStart).map(item => item && { id: item.name, lines: lines(item), profile: item.componentMap?.get('profile')?.data }) : null
      const signature = JSON.stringify(slots?.map(slot => slot && slot.lines))
      if (signature !== last) {
        last = signature
        since = Date.now()
      } else if (slots && Date.now() - since >= SETTLE) {
        const found = wanted(window, slots)
        if (found) return found
      }
      await wait(100)
    }
    return null
  }

  async function readGuild () {
    manager.closeMenu(id)
    manager.send(id, '/guild')
    const members = await settledWindow((window, slots) => {
      const found = readMembers(slots)
      return found.length ? found : null
    })
    manager.closeMenu(id)
    if (!members) throw new Error('/guild showed no member heads')
    return members
  }

  function remember (members) {
    conn.guildMembers = new Map(members.map(m => [m.name, m]))
  }

  async function readQuestMenu () {
    manager.closeMenu(id)
    manager.send(id, '/guild quests')
    const found = await settledWindow((window, slots) => readQuests(slots))
    manager.closeMenu(id)
    if (!found?.quests.length) throw new Error('/guild quests showed no quests')
    return found
  }

  // After every /guild quests read: the reset message once per hour, the quest ranking whenever
  // someone did a quest since the last one and the hour is over or all its quests are done.
  async function questsRead (found, members) {
    const previous = conn.guildQuests
    found.readAt = Date.now() // GET /api/quests hands out the freshest read
    conn.guildQuests = found
    const announced = settings().announced ?? 0
    const newHour = found.endsAt && Math.abs(found.endsAt - announced) > SAME_HOUR
    const allDone = found.quests.every(q => q.done)
    if (newHour) {
      conn.server.guild.announced = found.endsAt
      manager.save()
      // previous is only the last hour when it was read before this hour began
      const last = previous?.endsAt && Math.abs(previous.endsAt - found.endsAt) > SAME_HOUR ? previous : null
      await post(settings().trackWebhook, null, null, questsMessage(found, last, found.points, settings().roleId))
      log(`New quests posted: ${found.quests.map(q => q.task).join(', ')}`)
    }
    if (found.endsAt) {
      clearTimeout(resetTimer)
      resetTimer = setTimeout(() => readAgain().catch(err => log(`Reading /guild quests failed: ${err.message}`)), Math.max(0, found.endsAt - Date.now()) + timing.afterReset)
    }
    const baseline = conn.guildRankedAt
    if (!baseline) {
      conn.guildRankedAt = new Map(members.map(m => [m.name, m.quests]))
      return
    }
    if ((newHour || (allDone && conn.guildAllDone !== found.endsAt)) && members.some(m => m.quests > (baseline.get(m.name) ?? m.quests))) {
      if (allDone) conn.guildAllDone = found.endsAt
      const players = members.map(m => ({ ...m, delta: m.quests - (baseline.get(m.name) ?? m.quests) }))
        .sort((a, b) => b.quests - a.quests || b.delta - a.delta)
      const shownHour = allDone && !newHour ? found : previous ?? found
      const footer = `Quests da hora: ${shownHour.quests.filter(q => q.done).length}/${shownHour.quests.length} · Guild Points ${found.points}`
      await post(settings().trackWebhook, await podiumImage(players, questLayout(players, footer)), 'quests.png', {})
      conn.guildRankedAt = new Map(members.map(m => [m.name, m.quests]))
      log('Quest ranking posted')
    }
  }

  // The members are kept even when the quests menu fails.
  async function readAgain () {
    const found = await exclusive(async () => {
      remember(await readGuild())
      return readQuestMenu()
    })
    await questsRead(found, [...conn.guildMembers.values()])
  }

  async function snapshot () {
    await readAgain()
  }

  async function checkQuests () {
    for (const delay of [0, ...timing.questRetries]) {
      await wait(delay)
      if (delay === 0) checkPending = false // later completions get a check of their own
      const before = conn.guildMembers
      const members = await exclusive(readGuild)
      remember(members)
      if (!before.size) return log('Quest completed, but there was nothing to compare with yet')
      const rises = questRises(before, members)
      if (!rises.length) continue
      for (const member of rises) {
        const rank = questRank(members, member)
        await post(settings().trackWebhook, await questImage(member, rank), 'quest.png')
        log(`${member.name} completed quest ${member.quests} [#${rank}], posted`)
      }
      // Was it the hour's last quest?
      await questsRead(await exclusive(readQuestMenu), members)
      return
    }
    log('Quest completed, but nobody went up')
  }

  async function statsOf (name) {
    for (let cooldowns = 0, cooldown = 0; ; cooldowns++) {
      const sentAt = Date.now()
      manager.send(id, `/stats ${name}`)
      const result = await settledWindow(
        (window, slots) => plain(toText(window.title)).trim() === `${name.toLowerCase()}'s stats` && slots,
        () => cooldownAt >= sentAt ? 'cooldown' : refusedAt >= sentAt ? 'refused' : null)
      manager.closeMenu(id)
      if (result !== 'cooldown') return Array.isArray(result) ? result : null
      if (cooldowns >= timing.maxCooldowns) return null
      cooldown = Math.min(cooldown + timing.cooldownStep, timing.cooldownMax)
      await wait(cooldown + Math.random() * 700)
    }
  }

  async function ranking () {
    if (conn.guildRanking) throw new Error('A ranking is already running')
    conn.guildRanking = true
    try {
      const players = await exclusive(async () => {
        const members = await readGuild()
        remember(members)
        const players = []
        for (const member of members) {
          await wait(between(timing.statsGap))
          log(`Ranking: /stats ${member.name} (${players.length + 1}/${members.length})`)
          const slots = await statsOf(member.name) ?? []
          const of = item => slots.filter(slot => slot?.id === item).flatMap(slot => slot.lines)
          const completion = findValue(of('beacon'), 'completion')
          players.push({ ...member, completion, crops: findValue(of('wheat'), 'total') })
        }
        return players
      })
      players.sort((a, b) => numberValue(b.completion) - numberValue(a.completion))
      await post(settings().rankingWebhook, await podiumImage(players), 'ranking.png', {
        embeds: [{ title: 'Guild Ranking', color: 0xe6b422, timestamp: new Date().toISOString(), image: { url: 'attachment://ranking.png' } }]
      })
      const missing = players.filter(p => p.completion === null).length
      log(`Ranking sent: ${players.length} players${missing ? `, ${missing} without Completion` : ''}`)
    } finally {
      conn.guildRanking = false
    }
  }
  conn.runRanking = () => ranking().catch(err => log(`Ranking failed: ${err.message}`))

  const timer = setInterval(() => {
    const { track, ranking: scheduled } = settings()
    if (!(track || scheduled) || conn.bot !== bot || !ready()) {
      readySince = 0
      return
    }
    readySince ||= Date.now()
    if (Date.now() - readySince < timing.ready) return
    if (track && Date.now() - lastSnapshot > timing.snapshot) {
      lastSnapshot = Date.now()
      snapshot().catch(err => log(`Reading /guild failed: ${err.message}`))
    }
    // Missed while offline or in a lobby: runs on arrival, as long as it is still the same 3-hour slot.
    if (scheduled && settings().lastSlot !== rankingSlot() && !conn.guildRanking) {
      conn.server.guild.lastSlot = rankingSlot()
      manager.save()
      conn.runRanking()
    }
  }, 1000)

  return () => {
    stopped = true
    clearInterval(timer)
    clearTimeout(resetTimer)
    conn.runRanking = null
  }
}

// From the page. A webhook is needed before its feature can be switched on.
function guildSettings (current = {}, { track, trackWebhook, roleId, ranking, rankingWebhook }) {
  const hook = (value, label) => {
    const url = String(value ?? '').trim()
    if (url && !WEBHOOK.test(url)) throw new Error(`${label}: paste a Discord webhook URL (https://discord.com/api/webhooks/...)`)
    return url
  }
  const role = String(roleId ?? '').trim()
  if (role && !ROLE_ID.test(role)) throw new Error('Role ID: only the digits from Copy Role ID')
  const next = { ...current, track: !!track, trackWebhook: hook(trackWebhook, 'Rastrear Guilda'), roleId: role, ranking: !!ranking, rankingWebhook: hook(rankingWebhook, 'Ranking') }
  if (next.track && !next.trackWebhook) throw new Error('Rastrear Guilda needs a webhook')
  if (next.ranking && !next.rankingWebhook) throw new Error('Ranking needs a webhook')
  // Switching it on is not a reason to post right away: the next 3-hour slot is the first, or Run now.
  next.lastSlot = next.ranking && !current.ranking ? rankingSlot() : current.lastSlot
  return next
}

module.exports = { attachGuild, guildSettings, readMembers, readQuests, questRank, questRises, findValue, numberValue, rankingSlot, questImage, podiumImage, questLayout, questsMessage, skinUrl }

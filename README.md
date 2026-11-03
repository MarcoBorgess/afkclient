# AFK Client

Keeps Minecraft Java accounts online without running the game, controlled from a website. Several people log in, each with their own accounts, buttons and settings. Connects as Minecraft 1.21.11, so the server must accept that version.

The version that runs on one Windows PC with no login is on the `local-windows` branch.

## Host it on Square Cloud

The app reads these environment variables:

| Variable | Value |
|---|---|
| `TOKEN_KEY` | Random secret that encrypts the saved Microsoft logins. Changing it makes every account sign in again. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `PUBLIC_HOSTS` | The site's address, comma separated, without `https://`. For example `afkparmegio.squareweb.app,afk.parmegio.com` |
| `OFFLINE_WEBHOOK` | Optional Discord webhook. At startup it fills "Aviso de queda" on every server that never had it set, so nobody has to paste it; a field cleared on the page stays off. Kept out of the code because the repo is public. |
| `QUESTS_TOKEN` | Optional, 32+ characters. Turns on `GET /api/quests` (header `Authorization: Bearer <token>`): the freshest /guild quests a bot read, for the CobbleUtils quest box. Unset, the endpoint answers 401. |
| `ADMIN_USER` | Name of the first user, created on the first start |
| `ADMIN_PASSWORD` | That user's password, at least 12 characters. Kept set, it is also the way back in: `ADMIN_USER` + `ADMIN_PASSWORD` always log into that admin account, even after its password was changed on the page (the saved password keeps working too). Remove it to turn that off |
| `ALLOWED_SERVERS` | Optional. Servers people can connect to, comma separated, exact or like `*.example.com`. Defaults to `cobblestone.gg,*.cobblestone.gg,minehut.gg,*.minehut.gg` |

Settings are in `squarecloud.app`. Data is stored in the `data` folder.

## Run it on your computer

Needs [Node.js](https://nodejs.org) 22 or newer.

```
npm install
TOKEN_KEY=any-value-with-at-least-32-characters ADMIN_USER=admin ADMIN_PASSWORD=change-this-now npm start
```

Then open http://127.0.0.1:25599.

## Users

The admin opens **Users** to create people, set how many accounts each can add, reset passwords and remove users. Removing a user deletes their saved logins. A Minecraft account can only belong to one user.

## What it does

- **Accounts:** sign in with Microsoft, then add servers to each account. They reconnect by themselves, and stop if the account logs in elsewhere or is banned.
- **Launch:** chat, scoreboard, server menus, inventory, maps and WASD movement for one account. Maps in item frames are joined into one picture as they hang on the wall, so you can read a map captcha and answer it in chat.
- **Group:** every connected account's scoreboard, grouped by server, with a command box and buttons that run on all of them.
- **Lobby handling**, in a server's `⋮` menu:
  - **Must show address on scoreboard** reconnects an account if the server's address has been missing from the scoreboard for a minute.
  - **Command in the Minehut lobby** is sent while the scoreboard title is `MINEHUT`, for example `/join myserver`.

## Group buttons

Buttons belong to a user and a server. A button is a list of steps, one per line:

| Step | What it does |
|---|---|
| `/command` or a message | Sends it |
| `click 2 chest_minecart` | Clicks slot 2 if it holds that item, otherwise stops |
| `click all diamond` | Clicks each slot holding that item, once |
| `close` | Closes the menu |

Hover over a slot in Launch to see its number and item name.

`{shards}` in a command is replaced by the first number after that word on the scoreboard, and `{purse.2}` by the second. A command with one of these repeats every 6 seconds until the number reaches 0, sending one displayed step below the number shown, because scoreboards round. So this sends a whole balance:

```
/pay {money} MainAccount
```

An account whose name appears in a command skips that button, so it never pays itself.

**Run All** runs every button in order, moving on if one fails. Drag buttons to change the order, or use Ctrl+arrow keys.

## Guild (Cobblestone)

In a connection's ⋮ menu, under **Guilda**, each with its own Discord webhook:

- **Aviso de queda** (per server per account): a webhook that gets "🔴 <account> caiu de <server> há 3 min — <reason>" once the account has been out for 3 minutes straight (disconnected, reconnecting, on a captcha or in the Minehut lobby), then "🟢 voltou (fora por X min)" when it is back. Disconnecting with the button posts nothing. Empty turns it off.
- **Rastrear Guilda** reads /guild and /guild quests when the account gets in the game and every 30 minutes, with the webhook and the role to ping:
  - when the hour's quests reset ("New guild quests have become available!" in chat, else 15s after the QUEST INFO countdown ends) it posts the new quests as one message pinging the role, once per hour even across restarts;
  - that message is then edited, never reposted: after a "Guild quest complete" chat line it reads /guild again (3s later, retried at 10s and 30s), and the quest gets ✅ and the member whose quest count went up;
  - a **quest ranking** (podium by Quests Completed, "+N" since the last one, crops and last 24h) when all the hour's quests are done, or at the reset if anyone did one since the last ranking. One message, edited each time, in the ranking webhook's channel (the quests one while no ranking webhook is set).
- **Ranking a cada 3h** (/stats Completion of every member) is also one message, edited every 3 hours, in the ranking webhook's channel. Delete one on Discord and the next update posts a new one.
- **Ranking a cada 3h** reads /stats of every member 6-8s apart and posts the podium at 00, 03 ... 21h Brasília time, or on arrival later in that slot. **Rodar ranking agora** runs it at once.

Progress and failures show in the account's chat as `[guild]` lines. Fonts for the pictures are in `fonts/` (Inter, SIL Open Font License).

## Captcha

An account in Minehut's captcha world shows **Offline - Captcha**. It is connected, so open Launch, read the map and answer in chat. Group commands, lobby commands and the scoreboard address check leave it alone until it is through.

## When a connection drops

Launch's chat shows the reason, the kick exactly as the server sent it, and the last packets exchanged. The same goes to the app's logs.

## Tests

```
npm test
```

Runs against a local fake server. No Microsoft account or real server needed.

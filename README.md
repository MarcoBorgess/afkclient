# AFK Client

Keeps Minecraft Java accounts online without running the game, controlled from a website. Several people log in, each with their own accounts, buttons and settings. Connects as Minecraft 1.21.11, so the server must accept that version.

The version that runs on one Windows PC with no login is on the `local-windows` branch.

## Host it on Square Cloud

The app reads these environment variables:

| Variable | Value |
|---|---|
| `TOKEN_KEY` | Random secret that encrypts the saved Microsoft logins. Changing it makes every account sign in again. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `PUBLIC_HOSTS` | The site's address, comma separated, without `https://`. For example `afkparmegio.squareweb.app,afk.parmegio.com` |
| `ADMIN_USER` | Name of the first user, created on the first start |
| `ADMIN_PASSWORD` | That user's password, at least 12 characters. Delete this variable after the first login |
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

## Tests

```
npm test
```

Runs against a local fake server. No Microsoft account or real server needed.

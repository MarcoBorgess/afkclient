# AFK Client

Keeps Minecraft Java accounts online without running the game, controlled from a page in your browser. Runs several accounts on several servers at once.

Windows only: saved logins are encrypted with Windows DPAPI. Connects as Minecraft 1.21.11, so the server must accept that version.

## Run it

Needs [Node.js](https://nodejs.org) 22 or newer.

```
npm install
```

Then double-click `start.bat`. The page opens at http://127.0.0.1:25599. Closing the tab keeps the accounts online; use **Quit** on the page to stop.

Logins and settings are stored in `%LOCALAPPDATA%\afkclient`, not in this folder. The page only accepts connections from your own computer.

## What it does

- **Accounts:** sign in with Microsoft, then add servers to each account. They reconnect by themselves, and stop if the account logs in elsewhere or is banned.
- **Launch:** chat, scoreboard, server menus, inventory and WASD movement for one account.
- **Group:** every connected account's scoreboard, grouped by server, with a command box and buttons that run on all of them.
- **Lobby handling**, in a server's `⋮` menu:
  - **Must show address on scoreboard** reconnects an account if the server's address has been missing from the scoreboard for a minute.
  - **Command in the Minehut lobby** is sent while the scoreboard title is `MINEHUT`, for example `/join myserver`.

## Group buttons

Buttons belong to a server. A button is a list of steps, one per line:

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

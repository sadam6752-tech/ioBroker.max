![Logo](admin/max.png)

# ioBroker.max

[![NPM version](https://img.shields.io/npm/v/iobroker.max.svg)](https://www.npmjs.com/package/iobroker.max)
[![Downloads](https://img.shields.io/npm/dm/iobroker.max.svg)](https://www.npmjs.com/package/iobroker.max)
[![License](https://img.shields.io/github/license/sadam6752-tech/ioBroker.max.svg)](LICENSE)

[![NPM](https://nodei.co/npm/iobroker.max.png?downloads=true)](https://nodei.co/npm/iobroker.max/)

![Test and Release](https://github.com/sadam6752-tech/ioBroker.max/workflows/Test%20and%20Release/badge.svg)

**ioBroker adapter for MAX messenger bot integration**

Send and receive messages via [MAX messenger](https://max.ru) bot from ioBroker.  
Analog to ioBroker.telegram — send notifications, receive commands, control devices.

## Features

- Send messages to specific users or all known users
- Receive messages and commands from users
- Dynamic user objects created on first contact
- Access control via allowed user IDs list
- `sendTo()` support for use in scripts

## Installation

Install the adapter through the ioBroker **Admin** interface: open *Adapters*, search for
`max` and install the adapter from the *Latest* or *Stable* repository. No manual npm
installation is required.

## Configuration

1. Create a bot in MAX messenger via **MasterBot** — get your token
2. Open adapter settings in ioBroker Admin
3. Enter the **Bot Token**
4. Optionally set **Allowed User IDs** (comma-separated) to restrict access

The bot token is stored as a **protected** native field (`protectedNative`), so other
adapters cannot read it. It is kept as plain text inside the instance configuration — encryption via
`encryptedNative` is deliberately not used, because the js-controller would "decrypt" already stored
plain text tokens into unusable data (the legacy decryption is a XOR without a format check).

## Usage

### Send via state

Write to `max.0.message.send`:
- `"123456|Hello World"` — send to user 123456 (only a numeric prefix is taken as a user ID)
- `"Hello everyone"` — send to all known users (if `sendToAllUsers` enabled); a text such as
  `"Status|ok"` without a numeric prefix is sent as a broadcast as well

### Send via script

```javascript
sendTo('max.0', 'send', { userId: '123456', text: 'Hello!' });
// or to all:
sendTo('max.0', 'send', 'Hello everyone!');

// with an answer
sendTo('max.0', 'send', { userId: '123456', text: 'Hello!' }, res => {
    if (res.error) {
        log(`MAX: ${res.error}`, 'warn');
    }
});
```

The callback receives `{ result: 'sent' }` for a single user, `{ result: 'sent', sent, failed, skipped }` for a
broadcast, or `{ error: '...' }` when nothing was delivered (no text, bot not running, `sendToAllUsers` disabled,
no known users, delivery failed).

Broadcasts only reach users who contacted the bot before and who are allowed by **Allowed User IDs**.

### Connection state

`max.0.info.connection` is `true` while the adapter receives updates from the MAX API. A lost connection is logged
as a warning and retried automatically; a token that the MAX API rejects is reported as an error and not retried.

### Receive messages

Subscribe to `max.0.message.received` and `max.0.message.userId`.

### Per-user states

Each user gets their own channel under `max.0.users.<userId>`:
- `last_message` — last received message
- `send` — write here to send directly to this user
- `callback_data` — last button callback payload
- `username` — display name
- `started` — `true` once the user pressed "Start" in the bot

Known users are restored from the object tree after an adapter restart, so
broadcasts keep working without waiting for every user to write again.

## Changelog

### 0.1.6 (2026-10-12)
- (sadam6752-tech) Fix: `info.connection` is now set once the token has been verified; before, the adapter waited for
  the long polling loop to end and the connection stayed red/yellow. Lost connections are logged and polling is restarted
  with back-off; a start that failed because of the network is retried every 60 s
- (sadam6752-tech) Fix: `sendTo()` reaches the adapter (`common.messagebox` was missing); the callback reports errors
  instead of always answering `sent`, and calls without text are answered instead of timing out
- (sadam6752-tech) Fix: sending to a user who never wrote to the bot no longer prevents the creation of their objects
- (sadam6752-tech) Broadcasts skip known users that are no longer in the allowed list
- (sadam6752-tech) The bot token is shown as a password field in the admin; unused and untranslated admin texts fixed
- (sadam6752-tech) `message.send`: only a numeric prefix before `|` is taken as user ID; unit tests for `main.js`
- (sadam6752-tech) Update `@maxhub/max-bot-api` to 1.0.2 (drops `getAllChats`, which the adapter does not use; tolerates
  `message_created` updates without a message)

### 0.1.5 (2026-09-21)
- (sadam6752-tech) Update `@maxhub/max-bot-api` to 0.3.x - the library now talks to the MAX API host
  `platform-api2.max.ru` (make sure the root certificate of the Russian Ministry of Digital Development
  is in the trust store), plus comments API, sessions/conversation middleware and retry fixes
- (sadam6752-tech) Move the changelog entries for 0.1.0 and 0.1.1 to CHANGELOG_OLD.md (checker W6020)
- (sadam6752-tech) Update `@alcalzone/release-script-plugin-license` to 5.2.2 (checker S0064)

### 0.1.4 (2026-09-21)
- (sadam6752-tech) **HOTFIX for 0.1.3**: declaring the bot token as `protectedNative` / `encryptedNative`
  made the js-controller transform previously stored plain text tokens into unusable data before the
  adapter started, so the adapter could no longer authenticate against the MAX API. `encryptedNative`
  has been removed again — the token is only declared as `protectedNative`, stored tokens keep working
- (sadam6752-tech) Unusable tokens are detected on startup and reported, so the token can simply be
  entered again; new `lib/secrets.js` plus unit tests for the repair logic

### 0.1.3 (2026-09-20)
- (sadam6752-tech) Store the bot token as protected and encrypted native field (`protectedNative` / `encryptedNative`) so other adapters cannot read it
- (sadam6752-tech) `.releaseconfig.json` migrated to the plugin array format
- (sadam6752-tech) Added `prettier.config.mjs` and complete VSCode JSON schema mappings (io-package, package, jsonConfig/jsonCustom/jsonTab)
- (sadam6752-tech) Removed obsolete devDependencies (mocha, eslint plugins, prettier, typescript-eslint), updated `@alcalzone/release-script` to 5.2.x and `@iobroker/testing` to 6.x
- (sadam6752-tech) CI: added Node.js 26 to the test matrix and resynced `package-lock.json` so `npm ci` succeeds again
- (sadam6752-tech) Added unit tests for the bot manager (`npm run test:js`), `npm test` now runs package and unit tests
- (sadam6752-tech) README: removed direct npm installation instructions, added license and copyright section
- (sadam6752-tech) 0.1.2 was never published to npm — its changes are included in 0.1.3

Older changelog entries can be found in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

MIT License

Copyright (c) 2026 sadam6752-tech sadam6752@gmail.com

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

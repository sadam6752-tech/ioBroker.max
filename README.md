# ioBroker.max

![Logo](admin/max.png)

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
- `"123456|Hello World"` — send to user 123456
- `"Hello everyone"` — send to all known users (if `sendToAllUsers` enabled)

### Send via script

```javascript
sendTo('max.0', 'send', { userId: '123456', text: 'Hello!' });
// or to all:
sendTo('max.0', 'send', 'Hello everyone!');
```

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

### 0.1.2 (2026-09-20)
- (sadam6752-tech) Honor the `sendToAllUsers` setting: broadcasts are only sent when it is enabled
- (sadam6752-tech) Apply the allowed-users filter to all incoming events (`bot_started`, `message_created`, `message_callback`)
- (sadam6752-tech) Reload known users on adapter restart so broadcasts keep working
- (sadam6752-tech) Use `setStateAsync`/`extendObjectAsync`/`subscribeStatesAsync` consistently
- (sadam6752-tech) Add CI workflow, dependabot config, `tsconfig.json` and VSCode JSON schemas

### 0.1.1 (2026-03-30)
- (sadam6752-tech) Add CI/CD workflow, dependabot, release-script
- (sadam6752-tech) Fix async onUnload, null references after cleanup
- (sadam6752-tech) Fix object hierarchy: add parent 'users' channel
- (sadam6752-tech) Fix JSDoc descriptions

### 0.1.0 (2026-03-18)
- Initial release: MAX messenger bot integration for ioBroker

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

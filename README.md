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
- Send images, videos, audio and files (local path or http(s) URL, e.g. a camera snapshot)
- Buttons below a message (menus like in the Telegram adapter)
- Answer commands only to the user (or group chat) that sent them — `communicate.request` / `communicate.response`
  as in the Telegram adapter
- Group chats: send to a group the bot is a member of and receive its messages
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

### Certificate of the MAX API

The MAX API (`platform-api2.max.ru`) uses a certificate issued by the **Russian Trusted Root CA** of the Russian
Ministry of Digital Development. Node.js does not include this root certificate and ignores the trust store of the
operating system, so connections would fail with `fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)`. The adapter
therefore ships this root certificate (`lib/certs/russian-trusted-root-ca.pem`, valid until 2032, SHA-256
`D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`) and trusts it
**only for its own requests to the MAX API**. Nothing has to be installed on the host, and the global trust store of
Node.js as well as all other adapters stay untouched.

## Usage

In all examples `123456` stands for the ID of a MAX user and `-987654321` for the ID of a group chat (group chat IDs
are negative). A user gets an ID as soon as they write to the bot or press
**Start**: it appears as channel `max.0.users.<userId>` and in `max.0.message.userId`.

### Send via state

Write to `max.0.message.send`:
- `"123456|Hello World"` — send to user 123456 (only a numeric prefix is taken as a user ID)
- `"Hello everyone"` — send to all known users (if `sendToAllUsers` enabled); a text such as
  `"Status|ok"` without a numeric prefix is sent as a broadcast as well
- a JSON object, e.g. `{"userId": 123456, "text": "Door", "image": "/opt/iobroker/snapshot.jpg"}` — the same fields
  as for `sendTo()` below; without `userId` it is a broadcast

`max.0.users.<userId>.send` accepts plain text (sent as it is, `|` included) or the same JSON object without `userId`.

Examples of state values:

| State | Value | Effect |
| --- | --- | --- |
| `max.0.message.send` | `123456\|Washing machine is done` | text to user 123456 |
| `max.0.message.send` | `Alarm armed` | text to all known users |
| `max.0.message.send` | `{"userId": 123456, "text": "Front door", "image": "http://192.168.1.20/snapshot.jpg"}` | camera picture with caption to user 123456 |
| `max.0.message.send` | `{"text": "Monthly report", "file": "/opt/iobroker/report.pdf"}` | file to all known users |
| `max.0.users.123456.send` | `Hello` | text to this user |
| `max.0.users.123456.send` | `{"image": ["/tmp/a.jpg", "/tmp/b.jpg"]}` | two pictures to this user |
| `max.0.users.123456.send` | `{"video": "/tmp/clip.mp4", "text": "Motion in the garden"}` | video with caption to this user |

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

### Send images, videos, audio and files

```javascript
// a picture with a caption
sendTo('max.0', 'send', { userId: 123456, text: 'Front door', image: '/opt/iobroker/iobroker-data/snapshot.jpg' });

// straight from a camera in the local network (credentials in the URL are sent as basic auth)
sendTo('max.0', 'send', { userId: 123456, image: 'http://user:password@192.168.1.20/snapshot.jpg' });

// several attachments in one message
sendTo('max.0', 'send', { userId: 123456, image: ['/tmp/a.jpg', '/tmp/b.jpg'], file: '/opt/iobroker/report.pdf' });

// video and audio
sendTo('max.0', 'send', { userId: 123456, video: '/tmp/clip.mp4' });
sendTo('max.0', 'send', { userId: 123456, audio: '/tmp/doorbell.mp3' });
```

- `image`, `video`, `audio`, `file`: a local file path or an `http(s)` URL, a single string or a list; `text` is
  optional when an attachment is given.
- The adapter loads the file itself (also from devices in the local network that MAX cannot reach) and uploads it to
  MAX; files above 100 MB are refused.
- A broadcast uploads every attachment only once and sends it to all users.

The callback receives `{ result: 'sent' }` for a single user, `{ result: 'sent', sent, failed, skipped }` for a
broadcast, or `{ error: '...' }` when nothing was delivered (no text or attachment, bot not running,
`sendToAllUsers` disabled, no known users, attachment not readable or upload failed, delivery failed).

Broadcasts only reach users who contacted the bot before and who are allowed by **Allowed User IDs**.

### Answer commands of a user (like the Telegram adapter)

Every message (and every button press) is published like `telegram.0.communicate.request`:

| State | Content |
| --- | --- |
| `max.0.communicate.request` | `[Name]text` — written **last**, trigger on this state |
| `max.0.communicate.requestUserId` | user ID of the sender |
| `max.0.communicate.requestChatId` | group chat ID, `0` for a private dialog |
| `max.0.communicate.requestMessageId` | MAX message ID |
| `max.0.communicate.response` | write a text or a JSON object here: it goes to the same group chat, or privately to the sender |

The IDs are written before the request, so a script triggered by `communicate.request` reads the matching values. A
script written for the Telegram adapter needs only small changes:

```javascript
on({ id: 'max.0.communicate.request', ack: true, change: 'any' }, obj => {
    const value = String(obj.state.val);
    const user = value.substring(value.indexOf('[') + 1, value.indexOf(']'));
    const command = value.substring(value.indexOf(']') + 1).trim().toLowerCase();

    if (command === '/start' || command === 'menu') {
        setState('max.0.communicate.response', JSON.stringify({
            text: `Hello ${user}, what do you need?`,
            keyboard: [['Pool', 'Temperature'], ['Lights off']],
        }));
    } else if (command === 'pool') {
        const level = getState('0_userdata.0.pool.level').val;
        const volume = getState('0_userdata.0.pool.volume').val;
        setState('max.0.communicate.response', `Pool level: ${level} m, ${volume} m³`);
    }
});
```

The same with `sendTo()` and the per-user state — the answer goes only to the sender:

```javascript
on({ id: /^max\.0\.users\.\d+\.last_message$/, ack: true, change: 'any' }, obj => {
    const userId = obj.id.split('.')[3];
    if (String(obj.state.val).trim().toLowerCase() === 'pool') {
        sendTo('max.0', 'send', { userId, text: `Pool level: ${getState('0_userdata.0.pool.level').val} m` });
    }
});
```

### Buttons (menu)

`keyboard` adds buttons below a message: a list of rows, each row a list of buttons (at most 7 per row, 30 rows,
210 buttons).

| Button | Effect when pressed |
| --- | --- |
| `'Pool'` | sends `Pool` as a message of the user — handled like a typed command |
| `{ text: 'Open gate', callback: 'gate_open' }` | the payload `gate_open` arrives in `communicate.request` (`[Name]gate_open`) and `users.<userId>.callback_data` |
| `{ text: 'Website', url: 'https://…' }` | opens the link |

```javascript
sendTo('max.0', 'send', {
    userId: 123456,
    text: 'Garden',
    keyboard: [
        ['Pool', 'Temperature'],
        [{ text: 'Open gate', callback: 'gate_open' }, { text: 'Camera', url: 'http://192.168.1.20/' }],
    ],
});

// confirm a callback button with a short notification
on({ id: 'max.0.communicate.request', ack: true, change: 'any' }, obj => {
    if (String(obj.state.val).endsWith(']gate_open')) {
        const userId = getState('max.0.communicate.requestUserId').val;
        setState('0_userdata.0.gate', true);
        sendTo('max.0', 'answerCallback', { userId, text: 'Gate opens' });
    }
});
```

The keyboard also works in JSON state values, e.g. `max.0.users.123456.send` =
`{"text": "Menu", "keyboard": [["Pool", "Temperature"]]}`.

### Group chats

Add the bot to a group chat in MAX. The adapter creates the channel `max.0.chats.<chatId>` (named after the chat) when
the bot is added or the first message arrives. Depending on the group settings the bot may need to be an administrator
to receive all messages.

| State | Content |
| --- | --- |
| `max.0.chats.<chatId>.last_message` | last message in the chat |
| `max.0.chats.<chatId>.last_user_id` / `last_username` | sender of the last message |
| `max.0.chats.<chatId>.callback_data` | last button payload pressed in the chat |
| `max.0.chats.<chatId>.send` | text or JSON (attachments, keyboard) to send to the chat |

Messages in a group also set `max.0.message.chatId` and `max.0.communicate.requestChatId`, so
`max.0.communicate.response` answers in the group. Group members do not become entries below `max.0.users` and do not
receive broadcasts.

```javascript
// to a group chat
sendTo('max.0', 'send', { chatId: -987654321, text: 'Washing machine is done' });
sendTo('max.0', 'send', { chatId: -987654321, image: 'http://192.168.1.20/snapshot.jpg', text: 'Doorbell' });
```

Via state: `max.0.message.send` = `-987654321|Washing machine is done` (a negative ID before `|` is always a group
chat, never a broadcast), or `max.0.chats.-987654321.send` = `Washing machine is done`. A negative `userId` in
`sendTo()` is taken as `chatId` as well.

### Connection state

`max.0.info.connection` is `true` while the adapter receives updates from the MAX API. A lost connection is logged
as a warning and retried automatically; a token that the MAX API rejects is reported as an error and not retried.

### Receive messages

Subscribe to `max.0.message.received`; `max.0.message.userId` (sender) and `max.0.message.chatId` (group chat, `0`
for a private dialog) are written before it. To answer the sender, prefer `max.0.communicate.request` or
`max.0.users.<userId>.last_message` (see above).

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

### 0.1.9 (2026-10-12)
- (sadam6752-tech) Requests like the Telegram adapter: `communicate.request` (`[Name]text`, also button presses),
  `communicate.requestUserId`, `communicate.requestChatId`, `communicate.requestMessageId`; `communicate.response`
  answers the sender (or the group chat) of the last request
- (sadam6752-tech) Buttons below a message: `keyboard` in `sendTo()` and in JSON state values (message, callback and
  link buttons); `sendTo('max.0', 'answerCallback', { userId, text })` confirms a button press
- (sadam6752-tech) Group chats: `chatId` in `sendTo()` and JSON, `-chatId|text` in `message.send`, states
  `chats.<chatId>.*` with `send`; group messages set `message.chatId`. Before, `-chatId|text` was sent as a broadcast
  to all users
- (sadam6752-tech) Fix: `message.userId` is written before `message.received`, so a script triggered by the text reads
  the right sender

### 0.1.8 (2026-10-12)
- (sadam6752-tech) Send images, videos, audio and files: `sendTo()` with `image`, `video`, `audio`, `file` (local path
  or http(s) URL, also several per message), and JSON in `message.send` and `users.<id>.send`. The adapter downloads
  URLs itself (basic auth from the URL) and uploads the file to MAX with its own HTTP client, so the root certificate of
  the MAX API applies to uploads as well; a broadcast uploads each attachment once

### 0.1.7 (2026-10-12)
- (sadam6752-tech) Fix: the adapter could not connect to the MAX API (`fetch failed`) because Node.js does not trust
  the Russian Trusted Root CA used by `platform-api2.max.ru`. The adapter now ships this root certificate and trusts it
  for its own MAX API requests only (new dependency `undici`)
- (sadam6752-tech) Connection errors are logged with their cause (e.g. certificate, DNS) instead of only `fetch failed`

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

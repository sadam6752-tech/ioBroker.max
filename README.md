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

Install via ioBroker Admin or:

```bash
npm install iobroker.max
```

## Configuration

1. Create a bot in MAX messenger via **MasterBot** — get your token
2. Open adapter settings in ioBroker Admin
3. Enter the **Bot Token**
4. Optionally set **Allowed User IDs** (comma-separated) to restrict access

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

## Changelog

### 0.1.0 (2026-03-18)
- Initial release: MAX messenger bot integration for ioBroker

## License

MIT License — see [LICENSE](LICENSE)

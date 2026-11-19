'use strict';

/*
 * The answer of the command `help`: what the instance answers, written for AI agents (e.g. ioBroker.pi-agent, or the
 * MCP server with `send_to`) and script authors. Keep it in sync with onMessage() in main.js and the README.
 */

/** The commands onMessage() answers; write = the command has an effect (sends, changes or deletes a message) */
const COMMANDS = [
    { command: 'help', write: false },
    { command: 'send', write: true },
    { command: 'ask', write: true },
    { command: 'editMessage', write: true },
    { command: 'deleteMessage', write: true },
    { command: 'answerCallback', write: true },
    { command: 'sendNotification', write: true },
];

const HELP = `ioBroker.max: sends and receives messages with a bot of the MAX messenger. An agent can send texts,
pictures, videos, audio and files to a MAX user or group chat, ask a question with answer buttons and wait for the
answer, and edit or delete messages it sent.
Recipients: userId = a user who wrote to the bot or pressed Start (positive number), chatId = a group chat the bot
is a member of (negative number). Give one of them, not both; a negative userId is taken as chatId.

Commands (sendTo max.0):
- send {userId? | chatId?, text?, image?, video?, audio?, file?, keyboard?, format?, notify?}: sends a message.
  text may be left out when an attachment is given. image, video, audio, file: a path on the ioBroker host or an
  http(s) URL (http://user:password@host/... for basic auth), one string or a list, each at most 100 MB.
  keyboard: buttons below the message, a list of rows, each a list of buttons (at most 7 a row, 30 rows): "Pool"
  (pressing it sends the text as a message of the user), {text, callback} (the payload arrives in
  communicate.request) or {text, url} (a link). format: "markdown" or "html" (parse_mode "HTML", "Markdown",
  "MarkdownV2" of the Telegram adapter works too); default plain text. notify false (or disable_notification
  true) sends without sound. Without userId and chatId (or a plain string as message) it is a broadcast to every
  known user allowed in the settings; only if "Send to all known users" is enabled.
  Answer {result: "sent", messageId}; a broadcast {result: "sent", sent, failed, skipped, messages: [{userId,
  messageId}], failures: [{userId, error}]}; on failure {error}.
- ask {userId | chatId, text, answers, format?, notify?, timeout?}: sends a question with one button per answer
  (answers: 1 to 30 texts) and waits for the answer of that user or of any member of that group chat; timeout in
  seconds, default 60, at most 3600. The answer comes only after the button press: {data (index of the pressed
  answer as text, "0" = the first), text, userId, chatId (0 = private dialog), messageId}, or {timeout: true,
  messageId} when nobody answered, {error} on failure.
- editMessage {messageId, text?, format?, keyboard?}: changes a message sent by send or ask (messageId from their
  answer); without keyboard the buttons stay, keyboard null removes them. Answer {result: "edited", messageId}.
- deleteMessage {messageId}: deletes a sent message. Answer {result: "deleted", messageId}.
- answerCallback {userId, text}: confirms the last press of a callback button of that user with a short
  notification text. Answer {result: "answered"}.
- sendNotification: for the notification-manager, not for agents.

States (max.0.*): users.<userId> (named after the user, with username) are the known users, chats.<chatId> (named
after the chat) the group chats: take the IDs from there. message.send ("userId|text", "-chatId|text", a plain
text = broadcast, or the JSON of send), users.<userId>.send and chats.<chatId>.send (text or JSON) send as well.
Received messages: communicate.request ("[name]text", also callback payloads), communicate.requestUserId /
requestChatId (0 = private dialog) / requestMessageId, users.<userId>.last_message, chats.<chatId>.last_message;
communicate.response answers in the chat of the last request.

How to talk to the user:
- The recipient comes from the user's request. Sending to other people than the user (another MAX user, a group
  chat, a broadcast to all) needs the user's explicit request. If the recipient is not clear (several users or
  chats), ask which one; name users and chats by their names, not by their IDs.
- deleteMessage only on the user's request.
- Tell the user whether the message was sent; on {error} say why (e.g. the bot is not running, the recipient never
  wrote to the bot).`;

module.exports = { HELP, COMMANDS };

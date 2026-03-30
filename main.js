"use strict";

/*
 * ioBroker.max — MAX Messenger Bot Adapter
 * Sends and receives messages via MAX messenger bot
 */

const utils = require("@iobroker/adapter-core");
const BotManager = require("./lib/bot-manager");

class MaxAdapter extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
   */
  constructor(options = {}) {
    super({
      ...options,
      name: "max",
    });

    this.botManager = null;

    this.onReady = this.onReady.bind(this);
    this.onStateChange = this.onStateChange.bind(this);
    this.onMessage = this.onMessage.bind(this);
    this.onUnload = this.onUnload.bind(this);

    this.on("ready", this.onReady);
    this.on("stateChange", this.onStateChange);
    this.on("message", this.onMessage);
    this.on("unload", this.onUnload);
  }

  async onReady() {
    this.log.debug("onReady executing...");

    await this.setState("info.connection", false, true);

    // Create instance objects
    await this.extendObject("info", {
      type: "channel",
      common: { name: "Information" },
      native: {},
    });
    await this.extendObject("info.connection", {
      type: "state",
      common: {
        name: "Connected to MAX API",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await this.extendObject("message", {
      type: "channel",
      common: { name: "Messages" },
      native: {},
    });
    await this.extendObject("message.send", {
      type: "state",
      common: {
        name: "Send message (format: userId|text or JSON)",
        type: "string",
        role: "text",
        read: false,
        write: true,
        def: "",
      },
      native: {},
    });
    await this.extendObject("message.received", {
      type: "state",
      common: {
        name: "Last received message",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
      },
      native: {},
    });
    await this.extendObject("message.userId", {
      type: "state",
      common: {
        name: "User ID of last message sender",
        type: "number",
        role: "value",
        read: true,
        write: false,
        def: 0,
      },
      native: {},
    });

    this.subscribeStates("message.send");
    this.subscribeStates("users.*.send");

    // Validate token
    if (!this.config.token) {
      this.log.error(
        "No MAX bot token configured! Please set the token in adapter settings.",
      );
      return;
    }

    // Start bot
    this.botManager = new BotManager(this);
    try {
      await this.botManager.start(this.config.token);
      await this.setState("info.connection", true, true);
      this.log.info("MAX adapter ready and connected");
    } catch (e) {
      this.log.error(`Failed to start MAX bot: ${e.message}`);
      await this.setState("info.connection", false, true);
    }
  }

  /**
   * @param {string} id - State ID
   * @param {ioBroker.State | null | undefined} state - New state value
   */
  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }

    // message.send — format: "userId|text" or plain text (send to all)
    if (id === `${this.namespace}.message.send` && state.val) {
      const val = String(state.val);
      const pipeIdx = val.indexOf("|");
      if (pipeIdx > 0) {
        const userId = val.substring(0, pipeIdx).trim();
        const text = val.substring(pipeIdx + 1).trim();
        await this._sendMessage(userId, text);
      } else {
        await this._sendToAll(val);
      }
      await this.setStateAsync("message.send", "", true);
      return;
    }

    // users.<id>.send — direct send to specific user
    const userSendMatch = id.match(/^[^.]+\.[^.]+\.users\.(\d+)\.send$/);
    if (userSendMatch && state.val) {
      const userId = userSendMatch[1];
      await this._sendMessage(userId, String(state.val));
      await this.setStateAsync(`users.${userId}.send`, "", true);
    }
  }

  /**
   * @param {ioBroker.Message} obj - Message object
   */
  async onMessage(obj) {
    if (!obj || obj.command !== "send") {
      return;
    }

    const data = obj.message;
    if (!data) {
      return;
    }

    const text = typeof data === "string" ? data : data.text;
    const userId = typeof data === "object" ? data.userId : null;

    if (userId) {
      await this._sendMessage(String(userId), text);
    } else {
      await this._sendToAll(text);
    }

    if (obj.callback) {
      this.sendTo(obj.from, obj.command, { result: "sent" }, obj.callback);
    }
  }

  /**
   * @param {() => void} callback - Unload callback
   */
  async onUnload(callback) {
    try {
      if (this.botManager) {
        await this.botManager.stop();
        this.botManager = null;
      }
      await this.setStateAsync("info.connection", false, true);
    } catch {
      // ignore
    } finally {
      callback();
    }
  }

  /**
   * Send message to a specific user
   *
   * @param {string} userId - User ID to send message to
   * @param {string} text - Message text
   */
  async _sendMessage(userId, text) {
    if (!this.botManager) {
      this.log.warn("Bot not initialized, cannot send message");
      return;
    }
    try {
      await this.botManager.sendMessage(userId, text);
      this.log.debug(`Message sent to user ${userId}`);
    } catch (e) {
      this.log.error(`Failed to send message to ${userId}: ${e.message}`);
    }
  }

  /**
   * Send message to all known users
   *
   * @param {string} text - Message text to send to all users
   */
  async _sendToAll(text) {
    if (!this.botManager) {
      this.log.warn("Bot not initialized, cannot send message");
      return;
    }
    try {
      await this.botManager.sendToAll(text);
      this.log.debug("Message sent to all users");
    } catch (e) {
      this.log.error(`Failed to send to all: ${e.message}`);
    }
  }

  /**
   * Create or update user states dynamically
   *
   * @param {string|number} userId - User ID
   * @param {string} username - Username or display name
   */
  async ensureUserObjects(userId, username) {
    const uid = String(userId);
    // Ensure parent 'users' channel exists
    await this.extendObject("users", {
      type: "channel",
      common: { name: "Users" },
      native: {},
    });
    await this.extendObject(`users.${uid}`, {
      type: "channel",
      common: { name: username || `User ${uid}` },
      native: {},
    });
    await this.extendObject(`users.${uid}.last_message`, {
      type: "state",
      common: {
        name: "Last message",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
      },
      native: {},
    });
    await this.extendObject(`users.${uid}.send`, {
      type: "state",
      common: {
        name: "Send message",
        type: "string",
        role: "text",
        read: false,
        write: true,
        def: "",
      },
      native: {},
    });
    await this.extendObject(`users.${uid}.callback_data`, {
      type: "state",
      common: {
        name: "Callback data",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
      },
      native: {},
    });
    await this.extendObject(`users.${uid}.username`, {
      type: "state",
      common: {
        name: "Username",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
      },
      native: {},
    });
    this.subscribeStates(`users.${uid}.send`);
  }
}

if (require.main !== module) {
  /**
   * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
   */
  module.exports = (options) => new MaxAdapter(options);
} else {
  new MaxAdapter();
}

// Import packages
const dgram = require('dgram');
const net = require('net');
const {EventEmitter} = require('events');
const pTimeout = require('p-timeout');
const pRetry = require('p-retry');
const debug = require('debug')('TuyAPI');

// Helpers
const {isValidString} = require('./lib/utils');
const {MessageParser, CommandType} = require('./lib/message-parser');

/**
 * Represents a Tuya device.
 */
class TuyaDevice extends EventEmitter {
  /**
   * Represents a Tuya device.
   *
   * You *must* pass either an IP or an ID. If
   * you're experiencing problems when only passing
   * one, try passing both if possible.
   *
   * @param {Object} options
   * @param {String=} [options.ip] IP of device
   * @param {Number} [options.port=6668] port of device
   * @param {String=} [options.id] ID of device (also called `devId`)
   * @param {String=} [options.gwID=''] gateway ID (not needed for most devices),
   * if omitted assumed to be the same as `options.id`
   * @param {String=} options.key encryption key of device (also called `localKey`)
   * @param {String=} [options.productKey] product key of device (currently unused)
   * @param {Number} [options.version=3.1] protocol version
   * @example
   * const tuya = new TuyaDevice({id: 'xxxxxxxxxxxxxxxxxxxx',
   *                              key: 'xxxxxxxxxxxxxxxx'})
   */
  constructor({ip, port = 6668, id, gwID = id, key, productKey, version = 3.1} = {}) {
    super();

    // Check arguments
    if (!(isValidString(id) ||
          isValidString(ip))) {
      throw new TypeError('ID and IP are missing from device.');
    }

    // Check key
    if (!isValidString(key) || key.length !== 16) {
      throw new TypeError('Key is missing or incorrect.');
    }

    // Set device to user-passed options
    this.device = {ip, port, id, gwID, key, productKey, version,

      // Handles encoding/decoding, encrypting/decrypting messages
                   parser: new MessageParser({
                     key,
                     version})};

    // Contains array of found devices when calling .find()
    /** @type {{ id: string; ip: string; }[]} */
    this.foundDevices = [];

    // Private instance variables

    // Socket connected state
    this._connected = false;

    this._responseTimeout = 5; // Seconds
    this._connectTimeout = 5; // Seconds
    this._pingPongPeriod = 10; // Seconds

    this._currentSequenceN = 0;
    this._resolvers = {};

    this._waitingForSetToResolve = false;

    // Help typescript know that pingpongTimeout and _sendTimeout exist,
    // even though they are not being set to anything yet
    this.pingpongTimeout = null;
    /** @type {NodeJS.Timeout|undefined}
     * this is never assign in the project - maybe a bug?
     */
    this._sendTimeout = undefined;
  }

  /**
   * Gets a device's current status.
   * Defaults to returning only the value of the first DPS index.
   * @param {Object} [options]
   * @param {Boolean} [options.schema]
   * true to return entire list of properties from device
   * @param {Number} [options.dps=1]
   * DPS index to return
   * @example
   * // get first, default property from device
   * tuya.get().then(status => console.log(status))
   * @example
   * // get second property from device
   * tuya.get({dps: 2}).then(status => console.log(status))
   * @example
   * // get all available data from device
   * tuya.get({schema: true}).then(data => console.log(data))
   * @returns {Promise<Boolean|Object>}
   * returns boolean if single property is requested, otherwise returns object of results
   */
  get(options = {}) {
    const payload = {
      gwId: this.device.gwID,
      devId: this.device.id
    };

    debug('GET Payload:');
    debug(payload);

    // Create byte buffer
    const buffer = this.device.parser.encode({
      data: payload,
      commandByte: CommandType.DP_QUERY,
      sequenceN: ++this._currentSequenceN
    });

    // Send request and parse response
    return new Promise((resolve, reject) => {
      try {
        // Send request
        this._send(buffer).then(data => {
          if (typeof data !== 'object' || options.schema === true) {
            // Return whole response
            resolve(data);
          } else if (options.dps) {
            // Return specific property
            resolve(data.dps[options.dps]);
          } else {
            // Return first property by default
            resolve(data.dps['1']);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Sets a property on a device.
   * @param {Object} options
   * @param {Number} [options.dps=1] DPS index to set
   * @param {*} [options.set] value to set
   * @param {Boolean} [options.multiple=false]
   * Whether or not multiple properties should be set with options.data
   * @param {Object} [options.data={}] Multiple properties to set at once. See above.
   * @param {string=} [options.devId]
   * An optional device id to override the device id set in the constructor
   * @example
   * // set default property
   * tuya.set({set: true}).then(() => console.log('device was turned on'))
   * @example
   * // set custom property
   * tuya.set({dps: 2, set: false}).then(() => console.log('device was turned off'))
   * @example
   * // set multiple properties
   * tuya.set({
   *           multiple: true,
   *           data: {
   *             '1': true,
   *             '2': 'white'
   *          }}).then(() => console.log('device was changed'))
   * @example
   * // set custom property for a specific (virtual) deviceId
   * tuya.set({
   *           dps: 2,
   *           set: false,
   *           devId: '04314116cc50e346566e'
   *          }).then(() => console.log('device was turned off'))
   * @returns {Promise<Object>} - returns response from device
   */
  set(options) {
    // Check arguments
    if (options === undefined || Object.entries(options).length === 0) {
      throw new TypeError('No arguments were passed.');
    }

    // Defaults
    let dps = {};

    if (options.multiple === true) {
      dps = options.data;
    } else if (options.dps === undefined) {
      dps = {
        1: options.set
      };
    } else {
      dps = {
        [options.dps.toString()]: options.set
      };
    }

    // Get time
    const timeStamp = Math.floor(Number(new Date()) / 1000);

    // Construct payload
    const payload = {
      devId: options.devId || this.device.id,
      gwId: this.device.gwID,
      uid: '',
      t: timeStamp,
      dps
    };

    debug('SET Payload:');
    debug(payload);

    // Encode into packet
    const buffer = this.device.parser.encode({
      data: payload,
      encrypted: true, // Set commands must be encrypted
      commandByte: CommandType.CONTROL,
      sequenceN: ++this._currentSequenceN
    });

    // Send request and wait for response
    this._waitingForSetToResolve = true;
    return new Promise((resolve, reject) => {
      try {
        // Send request
        this._send(buffer);

        this._setResolver = resolve;
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Sends a query to a device. Helper function
   * that connects to a device if necessary and
   * wraps the entire operation in a retry.
   * @private
   * @param {Buffer} buffer buffer of data
   * @returns {Promise<any>} returned data for request
   */
  _send(buffer) {
    // Make sure we're connected
    if (!this.isConnected()) {
      throw new Error('No connection has been made to the device.');
    }

    // Retry up to 5 times
    return pRetry(() => {
      return new Promise((resolve, reject) => {
        try {
          // Send data
          // @ts-ignore the try catch will handle this if client is undefined
          this.client.write(buffer);

          // Add resolver function
          // @ts-ignore
          this._resolvers[this._currentSequenceN] = data => resolve(data);
        } catch (error) {
          reject(error);
        }
      });
    }, {retries: 5});
  }

  /**
   * Sends a heartbeat ping to the device
   * @private
   */
  async _sendPing() {
    debug(`Pinging ${this.device.ip}`);

    // Create byte buffer
    const buffer = this.device.parser.encode({
      data: Buffer.allocUnsafe(0),
      commandByte: CommandType.HEART_BEAT,
      sequenceN: ++this._currentSequenceN
    });

    // Send ping
    // @ts-ignore
    await this.client.write(buffer);
  }

  /**
   * Connects to the device. Can be called even
   * if device is already connected.
   * @returns {Promise<Boolean>} `true` if connect succeeds
   * @emits TuyaDevice#connected
   * @emits TuyaDevice#disconnected
   * @emits TuyaDevice#data
   * @emits TuyaDevice#error
   */
  connect() {
    if (!this.isConnected()) {
      return new Promise((resolve, reject) => {
        this.client = new net.Socket();

        // Attempt to connect
        debug(`Connecting to ${this.device.ip}...`);
        // @ts-ignore
        this.client.connect(this.device.port, this.device.ip);

        // Default connect timeout is ~1 minute,
        // 5 seconds is a more reasonable default
        // since `retry` is used.
        this.client.setTimeout(this._connectTimeout * 1000, () => {
          /**
           * Emitted on socket error, usually a
           * result of a connection timeout.
           * Also emitted on parsing errors.
           * @event TuyaDevice#error
           * @property {Error} error error event
           */
          // this.emit('error', new Error('connection timed out'));
          // @ts-ignore
          this.client.destroy();
          reject(new Error('connection timed out'));
        });

        // Add event listeners to socket

        // Parse response data
        this.client.on('data', data => {
          debug(`Received data: ${data.toString('hex')}`);

          let packets;

          try {
            packets = this.device.parser.parse(data);
          } catch (error) {
            debug(error);
            this.emit('error', error);
            return;
          }

          packets.forEach(packet => {
            debug('Parsed:');
            debug(packet);

            this._packetHandler.bind(this)(packet);
          });
        });

        // Handle errors
        this.client.on('error', err => {
          debug('Error event from socket.', this.device.ip, err);

          this.emit('error', new Error('Error from socket'));

          // @ts-ignore
          this.client.destroy();
        });

        // Handle socket closure
        this.client.on('close', () => {
          debug(`Socket closed: ${this.device.ip}`);

          this._connected = false;

          /**
           * Emitted when a socket is disconnected
           * from device. Not an exclusive event:
           * `error` and `disconnected` may be emitted
           * at the same time if, for example, the device
           * goes off the network.
           * @event TuyaDevice#disconnected
           */
          this.emit('disconnected');
          // @ts-ignore
          this.client.destroy();

          if (this.pingpongTimeout) {
            clearTimeout(this.pingpongTimeout);
            this.pingpongTimeout = null;
          }
        });

        this.client.on('connect', async () => {
          debug('Socket connected.');

          this._connected = true;

          // Remove connect timeout
          // @ts-ignore
          this.client.setTimeout(0);

          /**
          * Emitted when socket is connected
          * to device. This event may be emitted
          * multiple times within the same script,
          * so don't use this as a trigger for your
          * initialization code.
          * @event TuyaDevice#connected
          */
          this.emit('connected');

          // Periodically send heartbeat ping
          this.pingpongTimeout = setInterval(async () => {
            await this._sendPing();
          }, this._pingPongPeriod * 1000);

          // Automatically ask for current state so we
          // can emit a `data` event as soon as possible
          await this.get();

          // Return
          resolve(true);
        });
      });
    }

    // Return if already connected
    return Promise.resolve(true);
  }

  /** Handle incoming packets
   * @param {import("./lib/message-parser").Packet} packet
   */
  _packetHandler(packet) {
    // Response was received, so stop waiting
    if (this._sendTimeout) {
      // Ensures that _sendTimeout is never undefined,
      // because nodejs does not allow undefined parameters
      // here
      clearTimeout(this._sendTimeout);
    }

    if (packet.commandByte === CommandType.HEART_BEAT) {
      debug(`Pong from ${this.device.ip}`);
      /**
       * Emitted when a heartbeat ping is returned.
       * @event TuyaDevice#heartbeat
       */
      this.emit('heartbeat');
      return;
    }

    if (packet.commandByte === CommandType.CONTROL && packet.payload === false) {
      debug('Got SET ack.');
      return;
    }

    /**
     * Emitted when data is returned from device.
     * @event TuyaDevice#data
     * @property {Object} data received data
     * @property {Number} commandByte
     * commandByte of result
     * (e.g. 7=requested response, 8=proactive update from device)
     * @property {Number} sequenceN the packet sequence number
     */
    this.emit('data', packet.payload, packet.commandByte, packet.sequenceN);

    // Status response to SET command
    if (packet.sequenceN === 0 &&
        packet.commandByte === CommandType.STATUS &&
        this._waitingForSetToResolve &&
        typeof this._setResolver === 'function') {
      this._setResolver(packet.payload);

      // Remove resolver
      this._setResolver = undefined;
      return;
    }

    // Call data resolver for sequence number
    if (packet.sequenceN in this._resolvers) {
      // @ts-ignore
      this._resolvers[packet.sequenceN](packet.payload);

      // Remove resolver
      // @ts-ignore
      delete this._resolvers[packet.sequenceN];
    }
  }

  /**
   * Disconnects from the device, use to
   * close the socket and exit gracefully.
   */
  disconnect() {
    debug('Disconnect');

    this._connected = false;

    // Clear timeouts
    if (this._sendTimeout) {
    // Ensures that _sendTimeout is never undefined,
    // because nodejs does not allow undefined parameters
    // here
      clearTimeout(this._sendTimeout);
    }

    clearTimeout(this._connectTimeout);
    clearTimeout(this._responseTimeout);
    if (this.pingpongTimeout) {
    // Ensure that pingpongTimeout is never undefined,
    // because nodejs does not allow undefined parameters
    // here
      clearTimeout(this.pingpongTimeout);
    }

    if (!this.client) {
      return;
    }

    this.client.destroy();
  }

  /**
   * Returns current connection status to device.
   * @returns {Boolean}
   * (`true` if connected, `false` otherwise.)
   */
  isConnected() {
    return this._connected;
  }

  /**
   * @deprecated since v3.0.0. Will be removed in v4.0.0. Use find() instead.
   * @param {Object} [options]
   * @param {Boolean} [options.all]
   * true to return array of all found devices
   * @param {Number} [options.timeout=10]
   * how long, in seconds, to wait for device
   * to be resolved before timeout error is thrown
   * @example
   * tuya.find().then(() => console.log('ready!'))
   * @returns {ReturnType<boolean|Array.<{ id: string; ip: string; }>>}
   */
  resolveId(options) {
    // eslint-disable-next-line max-len
    console.warn('resolveId() is deprecated since v4.0.0. Will be removed in v5.0.0. Use find() instead.');
    return this.find(options);
  }

  /**
   * Finds an ID or IP, depending on what's missing.
   * If you didn't pass an ID or IP to the constructor,
   * you must call this before anything else.
   * @param {Object} [options]
   * @param {Boolean} [options.all]
   * true to return array of all found devices
   * @param {Number} [options.timeout=10]
   * how long, in seconds, to wait for device
   * to be resolved before timeout error is thrown
   * @example
   * tuya.find().then(() => console.log('ready!'))
   * @returns {Promise<Boolean|Array.<{ id: string; ip: string; }>>}
   * true if ID/IP was found and device is ready to be used
   */
  // @ts-ignore
  find({timeout = 10, all = false} = {}) {
    if (isValidString(this.device.id) &&
        isValidString(this.device.ip)) {
      // Don't need to do anything
      debug('IP and ID are already both resolved.');
      return Promise.resolve(true);
    }

    // Create new listeners
    const listener = dgram.createSocket({type: 'udp4', reuseAddr: true});
    listener.bind(6666);

    const listenerEncrypted = dgram.createSocket({type: 'udp4', reuseAddr: true});
    listenerEncrypted.bind(6667);

    /**
     * @param {{ (value?: boolean | undefined): void; }} resolve
     * @param {{ (reason?: any): void; }} reject
     * @returns { (message: Buffer) => void }
     */
    const broadcastHandler = (resolve, reject) => message => {
      debug('Received UDP message.');

      /** @type {import('./lib/message-parser').Packet} */
      let dataRes;
      try {
        dataRes = this.device.parser.parse(message)[0];
      } catch (error) {
        debug(error);
        reject(error);

        // If packet parsing failed, then we have to bail out -
        // there's nothing more we can do here
        return;
      }

      debug('UDP data:');
      debug(dataRes);

      // @ts-ignore
      const thisID = dataRes.payload.gwId;
      // @ts-ignore
      const thisIP = dataRes.payload.ip;

      // Add to array if it doesn't exist
      if (!this.foundDevices.some(e => (e.id === thisID && e.ip === thisIP))) {
        this.foundDevices.push({id: thisID, ip: thisIP});
      }

      if (!all &&
          (this.device.id === thisID || this.device.ip === thisIP) &&
          dataRes.payload) {
        // Add IP
        // @ts-ignore
        this.device.ip = dataRes.payload.ip;

        // Add ID and gwID
        // @ts-ignore
        this.device.id = dataRes.payload.gwId;
        // @ts-ignore
        this.device.gwID = dataRes.payload.gwId;

        // Change product key if necessary
        // @ts-ignore
        this.device.productKey = dataRes.payload.productKey;

        // Change protocol version if necessary
        // @ts-ignore
        if (this.device.version !== dataRes.payload.version) {
          // @ts-ignore
          this.device.version = dataRes.payload.version;

          // Update the parser
          this.device.parser = new MessageParser({
            key: this.device.key,
            version: this.device.version});
        }

        // Cleanup
        listener.close();
        listener.removeAllListeners();
        listenerEncrypted.close();
        listenerEncrypted.removeAllListeners();
        resolve(true);
      }
    };

    debug(`Finding missing IP ${this.device.ip} or ID ${this.device.id}`);

    // Find IP for device
    return pTimeout(new Promise((resolve, reject) => { // Timeout
      listener.on('message', broadcastHandler(resolve, reject));

      listener.on('error', err => {
        reject(err);
      });

      listenerEncrypted.on('message', broadcastHandler(resolve, reject));

      listenerEncrypted.on('error', err => {
        reject(err);
      });
    }), timeout * 1000, () => {
      // Have to do this so we exit cleanly
      listener.close();
      listener.removeAllListeners();
      listenerEncrypted.close();
      listenerEncrypted.removeAllListeners();

      // Return all devices
      if (all) {
        return this.foundDevices;
      }

      // Otherwise throw error
      // eslint-disable-next-line max-len
      throw new Error('find() timed out. Is the device powered on and the ID or IP correct?');
    });
  }

  /**
   * Toggles a boolean property.
   * @param {Number|String} [property='1'] property to toggle
   * @returns {Promise<Boolean>} the resulting state
   */
  async toggle(property = '1') {
    property = property.toString();

    // Get status
    // @ts-ignore
    const status = await this.get({dps: property});

    // Set to opposite
    // @ts-ignore
    await this.set({set: !status, dps: property});

    // Return new status
    // @ts-ignore
    return this.get({dps: property});
  }
}

module.exports = TuyaDevice;

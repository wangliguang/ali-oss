/*!
 * ali-oss - lib/cluster.js
 * Copyright(c) ali-sdk and other contributors.
 * Author: dead_horse <dead_horse@qq.com>
 */

'use strict';

/**
 * Module dependencies.
 */

const Base = require('sdk-base');
const util = require('util');

const RR = 'roundRobin';
const MS = 'masterSlave';

module.exports = function (oss) {
  const Client = function (options) {
    if (!(this instanceof Client)) {
      return new Client(options);
    }

    if (!options || !Array.isArray(options.cluster)) {
      throw new Error('require options.cluster to be an array');
    }
    this.clients = options.cluster.map(function (opt) {
      opt.timeout = opt.timeout || options.timeout;
      return oss(opt);
    });

    this.schedule = options.schedule || RR;
    this.index = 0;

    Base.call(this);
  };

  util.inherits(Client, Base);
  let proto = Client.prototype;

  proto._choose = function (index) {
    if (this.schedule === MS) {
      return this.clients[index];
    }

    let chosen = this.clients[this.index++];
    if (this.index >= this.clients.length) {
      this.index = 0;
    }
    return chosen;
  };

  proto.onerror = function (err) {
    if (err.status && err.status > 200 && err.status < 500) {
      throw err;
    }
    this.emit('error', err);
  };

  const GET_METHODS = [
    'head',
    'get',
    'getStream',
    'list',
  ];

  const PUT_METHODS = [
    'put',
    'putStream',
    'delete',
    'deleteMulti',
    'copy',
    'putMeta',
  ];

  GET_METHODS.forEach(function (method) {
    proto[method] = function* () {
      let index = 0;
      let max = this.clients.length;
      let res;
      let client;

      while (index < max) {
        client = this._choose(index++);
        try {
          res = yield client[method].apply(client, arguments);
        } catch (err) {
          this.onerror(err);
          continue;
        }
        return res;
      }
      let err = new Error('all clients are down');
      err.name = 'AllServerDownError';
      throw err;
    };
  });

  PUT_METHODS.forEach(function (method) {
    proto[method] = function* () {
      let args = Array.prototype.slice.call(arguments);
      let res = yield this.clients.map(function (client) {
        return client[method].apply(client, args);
      });
      return res[0];
    };
  });

  proto.signatureUrl = function* (name) {
    let index = 0;
    let max = this.clients.length;
    let client;

    while (index < max - 1) {
      client = this._choose(index++);
      try {
        yield client.head(name);
      } catch (err) {
        if (!err.status || err.status > 500 || err.status < 200) {
          this.emit('error', err);
          continue;
        }
      }
      return client.signatureUrl.apply(client, arguments);
    }

    // don't check last one
    return this._choose(index).signatureUrl.apply(client, arguments);
  };

  return Client;
};
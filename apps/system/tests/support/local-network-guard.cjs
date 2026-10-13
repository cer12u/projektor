// @module verification
// @role local-network-guard
// Verification-only preload. This is a cooperative Node test guard, not an OS
// sandbox: native workerd outbound is separately closed by fixture outboundService.
'use strict';
const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');
const {syncBuiltinESMExports} = require('node:module');
let blocked = false;
const loopback = host => typeof host === 'string' && (host === 'localhost' || host === '::1' ||
  (net.isIP(host) === 4 && host.startsWith('127.')) ||
  (/^::ffff:127\.(?:\d{1,3}\.){2}\d{1,3}$/i.test(host) && net.isIP(host) === 6));
function deny() {
  blocked = true;
  const error = new Error('Local verification blocked a non-loopback network operation');
  error.code = 'ERR_LOCAL_TEST_NETWORK';
  throw error;
}
// Libraries may catch a failed telemetry/update fetch. Such attempts still fail CI.
process.on('exit', () => { if (blocked) process.exitCode = 86; });
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  if (first && typeof first === 'object') {
    if (typeof first.path !== 'string' && !loopback(first.host ?? first.hostname ?? 'localhost')) deny();
  } else if (!(typeof first === 'string' && !/^\d+$/.test(first)) && !loopback(typeof values[1] === 'string' ? values[1] : 'localhost')) deny();
  return connect.apply(this, args);
};
function localLookup(host, options) {
  if (!loopback(host)) deny();
  const family = typeof options === 'number' ? options : options?.family;
  const address = host === 'localhost' ? (family === 6 ? '::1' : '127.0.0.1') : host;
  const result = {address, family: net.isIP(address)};
  return options?.all ? [result] : result;
}
dns.lookup = function (host, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  const result = localLookup(host, options);
  process.nextTick(() => Array.isArray(result) ? callback(null, result) : callback(null, result.address, result.family));
};
dns.promises.lookup = async (host, options) => localLookup(host, options);
// No local fixture needs DNS protocol queries; do not let these escape via UDP.
for (const key of Object.keys(dns)) if (/^(resolve|reverse)/.test(key) && typeof dns[key] === 'function') dns[key] = deny;
for (const key of Object.keys(dns.promises)) if (/^(resolve|reverse)/.test(key) && typeof dns.promises[key] === 'function') dns.promises[key] = async () => deny();
for (const proto of [dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const key of Object.getOwnPropertyNames(proto)) if (/^(resolve|reverse)/.test(key) && typeof proto[key] === 'function') proto[key] = deny;
}
const udpConnect = dgram.Socket.prototype.connect, udpSend = dgram.Socket.prototype.send;
const connected = new WeakSet();
dgram.Socket.prototype.connect = function (port, address, ...rest) {
  if (!loopback(address ?? 'localhost')) deny();
  connected.add(this);
  return udpConnect.call(this, port, address, ...rest);
};
dgram.Socket.prototype.send = function (...args) {
  if (!connected.has(this)) {
    // send(buffer, port, address[, cb]) or send(buffer, offset, length, port, address[, cb]).
    const address = typeof args[2] === 'number' ? args[4] : args[2];
    if (!loopback(typeof address === 'string' ? address : 'localhost')) deny();
  }
  return udpSend.apply(this, args);
};
syncBuiltinESMExports();

/*
 * Simple WHIP server
 *
 * Author:  Lorenzo Miniero <lorenzo@meetecho.com>
 * License: GPLv3
 *
 * Janus API stack (WebSocket)
 *
 */

/*
 * Usage:
 *
 * var WhipJanus = require("./whip-janus.js");
 * var wj = new WhipJanus(config);
 *
 */

var noop = function(){};

// Connectivity
var WebSocketClient = require('websocket').client;

// Debugging
var debug = require('debug');
var whip = {
	vdebug: debug('janus:vdebug'),
	debug: debug('janus:debug'),
	err: debug('janus:error'),
	warn: debug('janus:warn'),
	info: debug('janus:info')
};

var whipJanus = function(janusConfig) {

	var that = this;

	// We use this method to register callbacks
	this.callbacks = {};
	this.on = function(event, callback) {
		that.callbacks[event] = callback;
	}

	// Configuration is static for now: we'll make this dynamic
	this.config = {
		janus: {
			ws: janusConfig.address,
			apiSecret: janusConfig.apiSecret
		}
	};
	whip.debug("Janus:", that.config);
	// Enrich the configuration with the additional info we need
	that.config.janus.session = 0;
	that.config.janus.session.timer = null;
	that.config.janus.state = "disconnected";
	that.config.janus.transactions = {};
	// Tables
	var sessions = {};		// Not to be confused with Janus sessions
	var handles = {};		// All Janus handles (map to local sessions here)

	// Public method to check when the class object is ready
	this.isReady = function() { return that.config.janus.session !== 0; };
	this.getState = function() { return that.config.janus.state; };

	// Connect to Janus via WebSockets
	this.connect = function(callback) {
		whip.info("Connecting to " + that.config.janus.ws);
		// Callbacks
		callback = (typeof callback == "function") ? callback : noop;
		var disconnectedCB = (typeof that.callbacks["disconnected"] == "function") ? that.callbacks["disconnected"] : noop;
		// Connect to Janus via WebSockets
		if(that.config.janus.state !== "disconnected" || that.config.ws) {
			whip.warn("Already connected/connecting");
			callback({ error: "Already connected/connecting" });
			return;
		}
		that.config.ws = new WebSocketClient();
		that.config.ws.on('connectFailed', function(error) {
			whip.err('Janus WebSocket Connect Error: ' + error.toString());
			cleanup();
			callback({ error: error.toString() });
			disconnectedCB();
		});
		that.config.ws.on('connect', function(connection) {
			whip.info('Janus WebSocket Client Connected');
			that.config.ws.connection = connection;
			// Register events
			connection.on('error', function(error) {
				whip.err("Janus WebSocket Connection Error: " + error.toString());
				cleanup();
				callback({ error: error.toString() });
				disconnectedCB();
			});
			connection.on('close', function() {
				whip.info('Janus WebSocket Connection Closed');
				cleanup();
				disconnectedCB();
			});
			connection.on('message', function(message) {
				if(message.type === 'utf8') {
					var json = JSON.parse(message.utf8Data);
					whip.vdebug("Received message:", json);
					var event = json["janus"];
					var transaction = json["transaction"];
					if(transaction) {
						var reportResult = that.config.janus.transactions[transaction];
						if(reportResult) {
							reportResult(json);
						}
						return;
					}
				}
			});
			// Create the session now
			janusSend({janus: "create"}, function(response) {
				whip.debug("Session created:", response);
				if(response["janus"] === "error") {
					whip.err("Error creating session:", response["error"]["reason"]);
					disconnect();
					return;
				}
				// Unsubscribe from this transaction as well
				delete that.config.janus.transactions[response["transaction"]];
				that.config.janus.session = response["data"]["id"];
				whip.info("Janus session ID is " + that.config.janus.session);
				// We need to send keep-alives on a regular basis
				that.config.janus.session.timer = setInterval(function() {
					// Send keep-alive
					janusSend({janus: "keepalive", session_id: that.config.janus.session}, function(response) {
						// Unsubscribe from this keep-alive transaction
						delete that.config.janus.transactions[response["transaction"]];
					});
					// FIXME We should monitor it getting back or not
				}, 15000);
				// We're done
				that.config.janus.state = "connected";
				callback();
			});
		});
		that.config.ws.connect(that.config.janus.ws, 'janus-protocol');
	};

	// Public methods for managing sessions
	this.addSession = function(details) {
		whip.debug("Adding session:", details);
		sessions[details.uuid] = {
			uuid: details.uuid
		};
	};
	this.removeSession = function(details) {
		whip.debug("Removing user:", details);
		var uuid = details.uuid;
		this.hangup({ uuid: uuid });
		var session = sessions[uuid];
		delete sessions[uuid];
	};

	// Public method for publishing in the VideoRoom
	this.publish = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whip.debug("Publishing:", details);
		if(!details.jsep || !details.room || !details.uuid) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		var jsep = details.jsep;
		var room = details.room;
		var uuid = details.uuid;
		var session = sessions[uuid];
		if(!session) {
			callback({ error: "No such session" });
			return;
		}
		if(session.handle) {
			callback({ error: "WebRTC " + uuid + " already published" });
			return;
		}
		// Create a handle to attach to specified plugin
		whip.debug("Creating handle for session " + uuid);
		var attach = {
			janus: "attach",
			session_id: that.config.janus.session,
			plugin: "janus.plugin.videoroom"
		};
		janusSend(attach, function(response) {
			whip.debug("Attach response:", response);
			// Unsubscribe from the transaction
			delete that.config.janus.transactions[response["transaction"]];
			var event = response["janus"];
			if(event === "error") {
				whip.err("Got an error attaching to the plugin:", response["error"].reason);
				callback({ error: response["error"].reason });
				return;
			}
			// Take note of the handle ID
			var handle = response["data"]["id"];
			whip.debug("Plugin handle for session " + session + " is " + handle);
			session.handle = handle;
			handles[handle] = { uuid: uuid, room: room };
			// Do we have pending trickles?
			if(session.candidates && session.candidates.length > 0) {
				// Send a trickle candidates bunch request
				var candidates = {
					janus: "trickle",
					session_id: that.config.janus.session,
					handle_id: handle,
					candidates: session.candidates
				}
				janusSend(candidates, function(response) {
					// Unsubscribe from the transaction right away
					delete that.config.janus.transactions[response["transaction"]];
				});
				session.candidates = [];
			}
			// Send a request to the plugin to publish (and record)
			var publish = {
				janus: "message",
				session_id: that.config.janus.session,
				handle_id: handle,
				body: {
					request: "joinandconfigure",
					room: room,
					ptype: "publisher",
					display: uuid,
					audio: true,
					video: true
				},
				jsep: jsep
			};
			janusSend(publish, function(response) {
				var event = response["janus"];
				if(event === "error") {
					delete that.config.janus.transactions[response["transaction"]];
					whip.err("Got an error publishing:", response["error"].reason);
					callback({ error: response["error"].reason });
					return;
				}
				if(event === "ack") {
					whip.debug("Got an ack to the setup for session " + uuid + ", waiting for result...");
					return;
				}
				// Get the plugin data: is this a success or an error?
				var data = response.plugindata.data;
				if(data.error) {
					// Unsubscribe from the transaction
					delete that.config.janus.transactions[response["transaction"]];
					whip.err("Got an error publishing:", data.error);
					callback({ error: data.error });
					return;
				}
				whip.debug("Got an answer to the setup for session " + uuid + ":", data);
				if(data["reason"]) {
					// Unsubscribe from the transaction
					delete that.config.janus.transactions[response["transaction"]];
					// Notify the error
					callback({ error: data["reason"] });
				} else {
					// Unsubscribe from the transaction
					delete that.config.janus.transactions[response["transaction"]];
					handles[handle].publisher = data["id"];
					// Notify the response
					var jsep = response["jsep"];
					callback(null, { jsep: jsep });
				}
			});
		});
	};
	this.trickle = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whip.debug("Trickling:", details);
		if(!details.candidate || !details.uuid) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		var candidate = details.candidate;
		var uuid = details.uuid;
		var session = sessions[uuid];
		if(!session) {
			callback({ error: "No such session" });
			return;
		}
		if(!session.handle) {
			// We don't have a handle yet, enqueue the trickle
			if(!session.candidates)
				session.candidates = [];
			session.candidates.push(candidate);
			return;
		}
		// Send a trickle request
		var trickle = {
			janus: "trickle",
			session_id: that.config.janus.session,
			handle_id: session.handle,
			candidate: candidate
		}
		janusSend(trickle, function(response) {
			// Unsubscribe from the transaction right away
			delete that.config.janus.transactions[response["transaction"]];
		});
	};
	this.hangup = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whip.debug("Stopping WebRTC session:", details);
		if(!details.uuid) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		var uuid = details.uuid;
		var session = sessions[uuid];
		if(!session) {
			callback({ error: "No such session" });
			return;
		}
		if(!session.handle) {
			callback({ error: "WebRTC session not established for " + uuid });
			return;
		}
		// Get rid of the handle now
		var handle = session.handle;
		delete handles[handle];
		session.handle = 0;
		// We hangup sending a detach request
		var hangup = {
			janus: "detach",
			session_id: that.config.janus.session,
			handle_id: handle
		}
		janusSend(hangup, function(response) {
			// Unsubscribe from the transaction
			delete that.config.janus.transactions[response["transaction"]];
			whip.debug("Handle detached for session " + uuid);
			callback();
		});
	};
	this.destroy = function() {
		disconnect();
	};

	// Private method to disconnect from Janus and cleanup resources
	function disconnect() {
		if(that.config.ws && that.config.ws.connection) {
			try {
				that.config.ws.connection.close();
				that.config.ws.connection = null;
			} catch(e) {};
		}
		that.config.ws = null;
	};
	function cleanup() {
		if(that.config.janus.session.timer)
			clearInterval(that.config.janus.session.timer);
		that.config.janus.session.timer = null;
		that.config.janus.session = 0;
		that.config.janus.transactions = {};
		sessions = {};
		disconnect();
		that.config.janus.state = "disconnected";
	};

	// Private method to send requests to Janus
	function janusSend(message, responseCallback) {
		if(that.config.ws && that.config.ws.connection) {
			var transaction = randomString(16);
			if(responseCallback)
				that.config.janus.transactions[transaction] = responseCallback;
			message["transaction"] = transaction;
			if(that.config.janus.apiSecret !== null && that.config.janus.apiSecret !== null)
				message["apisecret"] = that.config.janus.apiSecret;
			whip.vdebug("Sending message:", message);
			that.config.ws.connection.sendUTF(JSON.stringify(message));
		}
	}

	// Private method to create random identifiers (e.g., transaction)
	function randomString(len) {
		charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		var randomString = '';
		for (var i = 0; i < len; i++) {
			var randomPoz = Math.floor(Math.random() * charSet.length);
			randomString += charSet.substring(randomPoz,randomPoz+1);
		}
		return randomString;
	}

};

module.exports = whipJanus;

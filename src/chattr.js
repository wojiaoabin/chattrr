/*jslint white: true, onevar: true, undef: true, newcap: true, nomen: false, regexp: true, plusplus: true, bitwise: true, maxerr: 5, maxlen: 80, indent: 2 */
/*global require */

(function () {
  var http = require('http'), 
      io = require('../../socket.io-node'),
      fs = require('fs'),
      util = require('util'),
      redis = require("redis"),
      hash = require("hashlib"),
      _ = require("../../underscore/underscore"),
      express = require("express"),
      db, server, socket, clients,
      f = {};

  db = redis.createClient();
  server = express.createServer();
  server.configure(function () {
    server.use(express.staticProvider("client"));
  });
  server.get("/", function (req, res) {
    var url = req.url;
    if (url === "/") {
      url += "client.htm";
      res.redirect("/client.htm?userToken=" + 
        hash.md5(Math.random().toString()));
    }
    fs.readFile('client' + url, "binary", function (err, file) {
      if (!err) {
        var content = 'text/html';
        if (url.substring(url.lastIndexOf('.')) === ".css") {
          content = "text/css";
        }
        res.writeHead(200, {'Content-Type': content});
        res.write(file, 'binary');
      }
      else {
        res.writeHead(500, {'Content-Type': 'text/html'});
        res.write(err);
      }
      res.end();
    });
  });

  server.listen(8000);
  socket = io.listen(server);

  clients = {};
  f.createConnection = function (client) {
    var address = client.connection.address(), 
      name = client.connection.address();
    clients[client.sessionId] = client;
    name = address.address + ":" + address.port;
    f.setName(client, name);
    util.log(name + ' connected');
    client.on('message', f.handleMessage(client));
    client.on('disconnect', f.handleDisconnect(client)); 
  };
  f.handleMessage = function (client) {
    return function (rawMessage) { 
      util.log('message: ' + rawMessage); 
      var message = JSON.parse(rawMessage);
      f.handleUserToken(client, message);
    };
  };
  f.handleUserToken = function (client, message) {
    var userToken = message.userToken, 
      clientUserTokenVar = f.createClientUserTokenVar(client);
    if (userToken) {
      db.set(clientUserTokenVar, userToken);
      f.handleUrl(client, userToken, message);
    }
    else {
      db.get(clientUserTokenVar, function (err, userToken) {
        f.handleUrl(client, userToken, message);
      });
    }
  };
  f.handleUrl = function (client, userToken, message) {
    var clientUrlKey = f.getClientUrlKey(client), urlHash;
    if (message.url) {
      urlHash = hash.md5(message.url);
      db.get("url:" + urlHash, function (err, urlId) {
        if (!urlId) {
          db.incr("nextUrlId", function (err, urlId) {
            db.set("url:" + urlHash, urlId);
            db.set("url:" + urlId + ":url", message.url);
            f.handleNewUrl(client, userToken, message, clientUrlKey, urlId);
          });
        }
        f.handleNewUrl(client, userToken, message, clientUrlKey, urlId);
      });
    }
    else {
      db.get(clientUrlKey, function (err, urlId) {
        f.handleMessageContents(client, userToken, message, urlId);
      });
    }
  };
  f.handleNewUrl = function (client, userToken, message, clientUrlKey, urlId) {
    db.sadd(f.getMembersKey(urlId), client.sessionId);
    db.set(clientUrlKey, urlId);
    f.sendInitialHistory(client, userToken, urlId);
    db.get("url:" + urlId + ":url", function (err, url) {
      f.sendMessage("Welcome to chattr! You are talking on " + url, 
        client, userToken, urlId);
    });
    f.handleMessageContents(client, userToken, message, urlId);
  };
  f.handleMessageContents = function (client, userToken, message, urlId) {
    if (message.name) {
      f.setName(client, message.name, function (oldName) {
        var toSend = "\"" + oldName + "\" is now called \"" + 
          message.name + "\"";
        f.sendMessage(toSend, client, userToken, urlId);
      });
    }
    if (message.historyCount) {
      db.set(f.getHistoryDepthVar(userToken), message.historyCount, 
        function () {
          f.sendInitialHistory(client, userToken, urlId);
        }
      );
    }
    else if (message.msg) {
      if (message.msg.match(/^help$/)) {
        f.sendMessage("Available commands:", client, userToken, urlId);
        f.sendMessage("  1. 'set name: <name>'", client, userToken, urlId);
        f.sendMessage("  2. 'set history depth: <numberOfLines>'", client, 
          userToken, urlId);
      }
      else {
        f.saveMessage(message.msg, userToken, urlId);
        f.sendMessage(message.msg, client, userToken, urlId, true);
      }
    }
  };
  f.sendInitialHistory = function (client, userToken, urlId) {
    var send = function (message) {
      client.send(message);
    };
    db.get(f.getHistoryDepthVar(userToken), function (err, res) {
      var historyDepth = 5;
      if (res) {
        historyDepth = parseInt(res, 10);
      }
      db.lrange(f.getMessagesName(urlId), -historyDepth, -1, 
        function (err, res) {
          res.forEach(function (msgJson) {
            var message = JSON.parse(msgJson);
            f.formatMessage(
              message.userToken, 
              new Date(message.time), 
              message.msg, 
              function (toSend) {
                client.send(toSend);
              }
            );
          });
        }
      );
    });
  };
  f.getHistoryDepthVar = function (userToken) {
    return "user:" + userToken + ":historyDepth";
  };
  f.setName = function (client, name, cb) {
    db.get(f.createClientUserTokenVar(client), function (err, userToken) {
      var oldName, nameVar, multi;
      nameVar = f.createNameVar(userToken);
      multi = db.multi();
      if (cb) {
        multi.get(nameVar, function (err, res) {
          oldName = res;
        });
      }
      multi.set(nameVar, name, function (err, res) {
        if (cb) {
          cb(oldName); 
        }
      });
      multi.exec();
    });
  }; 
  f.createClientUserTokenVar = function (client) {
    return "client: " + client.sessionId + ":userToken";
  };
  f.createNameVar = function (userToken) {
    return "user:" + userToken + ":name";
  };
  f.saveMessage = function (message, userToken, urlId) {
    db.rpush(f.getMessagesName(urlId), 
      JSON.stringify({
        userToken: userToken, 
        msg: message,
        time: new Date()
      })
    );
  };
  f.getMessagesName = function (urlId) {
    return "messages:" + urlId;
  };
  f.sendMessage = function (toSend, client, userToken, urlId, broadcast) {
    f.formatMessage(userToken, new Date(), toSend, function (message) {
      if (broadcast) {
        var membersKey = f.getMembersKey(urlId);
        db.smembers(membersKey, function (err, clientSessionIds) {
          clientSessionIds.forEach(function (sessionId) {
            if (clients.hasOwnProperty(sessionId)) {
              clients[sessionId].send(message);
            }
            else {
              //Don't know "sessionId" anymore
              db.srem(membersKey, sessionId);
            }
          });
        });
      }
      else {
        client.send(message);
      } 
    });
  };
  f.formatMessage = function (userToken, time, message, cb) {
    db.get(f.createNameVar(userToken), function (err, name) {
      cb(JSON.stringify({name: name, time: time, msg: message}));
    });
  };
  f.handleDisconnect = function (client) {
    return function () { 
      util.log('disconnected'); 
      f.removeClient(client);
      delete clients[client.sessionId];
    };
  };
  f.removeClient = function (client) {
    var clientUrlKey = f.getClientUrlKey(client),
        multi = db.multi();
    multi.get(clientUrlKey, function (err, urlId) {
      db.srem(f.getMembersKey(urlId), client.sessionId);
    });
    multi.del(clientUrlKey);
    multi.del("client:" + client.sessionId + ":user");
    multi.exec();
  };
  f.getMembersKey = function (urlId) {
    return "board:" + urlId + ":clients";
  };
  f.getClientUrlKey = function (client) {
    return "client:" + client.sessionId + ":url";
  };
  socket.on('connection', f.createConnection);
}());

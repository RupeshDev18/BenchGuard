/**
 * src/utils/broadcaster.js
 * 
 * Central WebSocket Event Broadcaster:
 * Allows any route or service to stream pipeline execution logs,
 * lifecycle events, and tenant-scoped notifications.
 */

const EventEmitter = require('events');

class Broadcaster extends EventEmitter {
    constructor() {
        super();
        this.wss = null;
    }

    setWebSocketServer(wss) {
        this.wss = wss;
    }

    broadcast(type, data) {
        const payload = {
            type,
            data,
            timestamp: new Date().toISOString()
        };
        const msg = JSON.stringify(payload);

        if (this.wss && this.wss.clients) {
            this.wss.clients.forEach((client) => {
                // WebSocket.OPEN === 1
                if (client.readyState === 1) {
                    client.send(msg);
                }
            });
        }
        this.emit(type, data);
    }
}

module.exports = new Broadcaster();

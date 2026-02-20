const net = require('net');
const readline = require('readline');

const PORT = 12345;
const HOST = '0.0.0.0';

// Protocol V2.1.8: "0xFFFF, in HEX format, must be added before the command header when the server sends commands"
const SERVER_CMD_PREFIX = Buffer.from([0xff, 0xff]);

/** Send a server->lock command. Prepends 0xFFFF per protocol; command must end with #\\n */
function writeServerCommand(socket, commandString) {
    const buf = Buffer.concat([SERVER_CMD_PREFIX, Buffer.from(commandString, 'utf8')]);
    socket.write(buf);
    if (DEBUG) debug('writeServerCommand() – bytes:', buf.length, 'hex prefix:', buf.slice(0, 2).toString('hex'));
}

// Set to false to disable [DEBUG] logs (e.g. in production)
const DEBUG = true;
function debug(...args) {
    console.log('[DEBUG]', ...args);
}

const clients = new Map(); // IMEI -> { socket, key, battery, status, lastSeen, gsmSignal, alarm, autolock }
// Pending response waiters for getDeviceStatus: key = "imei:command", value = { resolve, timeoutId }
const pendingResponseWaiters = new Map();

// Connection check: use socket.destroyed only. Do NOT use socket.writable – writable can be
// false when the write buffer is full (TCP backpressure) but the connection is still alive and
// we are still receiving data. Client is removed only on socket 'end' / 'error' / 'close'.
function removeClientBySocket(closedSocket) {
    debug('removeClientBySocket() – checking', clients.size, 'clients');
    for (const [imei, client] of clients.entries()) {
        if (client.socket === closedSocket) {
            clients.delete(imei);
            console.log(`📴 Lock ${imei} disconnected (removed from list). Reconnect to send commands.`);
            debug('removeClientBySocket() – removed IMEI', imei, '; remaining clients:', clients.size);
            return;
        }
    }
    debug('removeClientBySocket() – no matching socket found');
}

// Create TCP Server
function createTCP() {
    debug('createTCP() – creating server', HOST, PORT);
    const server = net.createServer((socket) => {
        const remote = `${socket.remoteAddress}:${socket.remotePort}`;
        console.log('🔗 New connection established.');
        debug('createTCP() – new socket from', remote);

        socket.on('data', (data) => incomingData(socket, data));
        socket.on('end', () => {
            debug('createTCP() – socket end event from', remote);
            removeClientBySocket(socket);
        });
        socket.on('error', (err) => {
            console.log(`⚠ Socket error: ${err.message}`);
            debug('createTCP() – socket error from', remote, err.message);
            removeClientBySocket(socket);
        });
        socket.on('close', () => {
            debug('createTCP() – socket close event from', remote);
            removeClientBySocket(socket);
        });
    });

    server.listen(PORT, HOST, () => {
        console.log(`🚀 TCP Server running on ${HOST}:${PORT}`);
        debug('createTCP() – listening on', HOST, PORT);
    });
}

// Per-socket buffer for TCP stream (messages can be concatenated or split across packets)
const BGCR_REGEX = /\*BGCR,OM,(\d{15}),(Q0|H0|R0|L0|L1|S5|W0|S1|S8),(.+)$/;
const BGCK_REGEX = /BGCK,ON,(\d{15}),([^,]*),(.+)$/;

function processOneMessage(socket, message) {
    const trimmed = message.trim();
    if (!trimmed) return;

    // **Handle Manual Commands (unlock, lock, restart)**
    if (trimmed.startsWith("unlock ") || trimmed.startsWith("lock ") || trimmed.startsWith("restart ")) {
        debug('processOneMessage() – manual command:', trimmed.substring(0, 30) + '...');
        echoCommands(trimmed);
        return;
    }

    // **Handle Lock Protocol Messages** (expected: *BGCR,OM,IMEI,COMMAND,params#)
    let match = trimmed.match(BGCR_REGEX);
    let imei, command, params;

    if (match) {
        imei = match[1];
        command = match[2];
        params = match[3].replace(/\s+/g, '').split(','); // remove any remaining whitespace before split
        debug('processOneMessage() – parsed BGCR: imei=', imei, 'command=', command, 'params=', params.join(','));
    } else {
        const bgckMatch = trimmed.match(BGCK_REGEX);
        if (bgckMatch) {
            imei = bgckMatch[1];
            const keyOrNo = (bgckMatch[2] || '').trim();
            const rest = (bgckMatch[3] || '').split(',');
            debug('processOneMessage() – parsed BGCK: imei=', imei, 'keyOrNo=', keyOrNo);
            if (!clients.has(imei)) {
                clients.set(imei, { socket, key: null, lastSeen: Date.now() });
                console.log(`✅ Lock ${imei} connected (BGCK format).`);
            }
            clients.get(imei).lastSeen = Date.now();
            if (keyOrNo && keyOrNo !== 'no' && keyOrNo.length > 0) {
                clients.get(imei).key = keyOrNo;
                console.log(`🔑 Stored key for lock ${imei} (from BGCK): ${keyOrNo}`);
            }
            if (rest.length >= 2) {
                clients.get(imei).battery = rest[1];
                clients.get(imei).gsmSignal = rest[2];
            }
            return;
        }
        console.log("⚠ Received unknown data:", trimmed.substring(0, 80));
        debug('processOneMessage() – no BGCR/BGCK match');
        return;
    }

    if (!clients.has(imei)) {
        clients.set(imei, { socket, key: null, lastSeen: Date.now() });
        console.log(`✅ Lock ${imei} connected.`);
        debug('processOneMessage() – new client added for', imei, '; total clients:', clients.size);
    }

    clients.get(imei).lastSeen = Date.now();
    // If getDeviceStatus is waiting for this exact command, resolve it with this message
    const waiterKey = `${imei}:${command}`;
    const waiter = pendingResponseWaiters.get(waiterKey);
    if (waiter) {
        clearTimeout(waiter.timeoutId);
        pendingResponseWaiters.delete(waiterKey);
        const fullMessage = (trimmed.startsWith('*') ? trimmed : `*BGCR,OM,${imei},${command},${params.join(',')}`) + '#';
        waiter.resolve({ message: fullMessage, params, command, imei });
    }
    debug('processOneMessage() – calling processData(', imei, command, params.length, 'params)');
    processData(imei, command, params);
}

// Handle Incoming Data – split by # so every message is processed (L1/L0 not dropped after H0)
function incomingData(socket, data) {
    if (!socket._inBuffer) socket._inBuffer = '';
    socket._inBuffer += data.toString();

    let idx;
    while ((idx = socket._inBuffer.indexOf('#')) >= 0) {
        const message = socket._inBuffer.substring(0, idx);
        socket._inBuffer = socket._inBuffer.substring(idx + 1);
        console.log(`📩 Data received: ${message.trim()}#`);
        debug('incomingData() – processing one message, length:', message.length);
        processOneMessage(socket, message);
    }
    // Keep max buffer size to avoid memory growth on bad data (no #)
    if (socket._inBuffer.length > 2048) {
        debug('incomingData() – buffer overflow, discarding', socket._inBuffer.length, 'bytes');
        socket._inBuffer = '';
    }
}


// Process Incoming Data
function processData(imei, command, params) {
    debug('processData() – imei=', imei, 'command=', command, 'params=', params.join(','));
    const client = clients.get(imei);
    if (!client) {
        debug('processData() – no client for', imei, 'skipping');
        return;
    }
    switch (command) {
        case 'Q0': // Sign-in
            client.battery = params[0];
            client.status = params[2];
            console.log(`🔑 Lock ${imei} signed in. Battery: ${client.battery}mV, Status: ${client.status}`);
            debug('processData() Q0 – stored battery, status');
            break;
        case 'H0': // Heartbeat
            client.battery = params[1];
            client.gsmSignal = params[2];
            console.log(`💓 Heartbeat from ${imei}. Battery: ${client.battery}mV, GSM: ${client.gsmSignal}`);
            debug('processData() H0 – updated battery, gsmSignal');
            break;
        case 'R0': // Operation Key Request
            client.key = params[1];
            console.log(`🔑 Stored key for lock ${imei}: ${client.key}`);
            debug('processData() R0 – stored key =', client.key);
            break;
        case 'L0': // Unlock Response
        case 'L1': // Lock Response
            if (!client.key && params[1]) {
                client.key = params[1];
                console.log(`🔑 Stored key for lock ${imei} (from ${command} response): ${client.key}`);
                debug('processData()', command, '– stored key from params[1] =', client.key);
            }
            debug('processData()', command, '– calling handleLockResponse status=', params[0]);
            handleLockResponse(imei, command, params[0], params);
            break;
        case 'S5': // Device Info
            console.log(`ℹ️ Device Info for ${imei}: Battery ${params[0]}mV, GSM: ${params[2]}, Status: ${params[3]}`);
            debug('processData() S5 – device info');
            break;
        case 'W0': // Alarm Triggered – protocol 2.8: server must respond with Re,W0
            debug('processData() W0 – alarm status=', params[0]);
            handleAlarm(imei, params[0]);
            sendAck(imei, 'W0');
            break;
        case 'S1': // Restart Lock
            debug('processData() S1 – delegating to restartLock');
            restartLock(imei);
            break;
        case 'S8': // Find Lock (Alarm Sound)
            debug('processData() S8 – find lock');
            handleFindLock(imei);
            break;
        default:
            debug('processData() – unhandled command', command);
    }
}

// Manual Command Handler
function echoCommands(input) {
    debug('echoCommands() – input:', typeof input === 'string' ? input.substring(0, 50) : input);
    if (!input || typeof input !== "string") {
        console.log("⚠ Error: Received invalid command input.");
        return;
    }

    const [command, imei] = input.split(/[ ,]+/); // Supports both spaces and commas
    debug('echoCommands() – parsed command=', command, 'imei=', imei);

    if (!imei) {
        console.log("⚠ Error: IMEI missing in command.");
        return;
    }

    if (command === "unlock") {
        debug('echoCommands() – calling sendUnlockCommand(', imei, ')');
        sendUnlockCommand(imei);
    } else if (command === "lock") {
        debug('echoCommands() – calling sendLockCommand(', imei, ')');
        sendLockCommand(imei);
    } else if (command === "restart") {
        debug('echoCommands() – calling restartLock(', imei, ')');
        restartLock(imei);
    } else {
        console.log("⚠ Invalid command! Use 'unlock IMEI', 'lock IMEI', or 'restart IMEI'");
    }
}



// Unlock Command
function sendUnlockCommand(imei) {
    debug('sendUnlockCommand() – imei=', imei, 'clients.has(imei)=', clients.has(imei));
    if (!clients.has(imei)) {
        console.log(`❌ Lock ${imei} is not connected.`);
        return;
    }
    
    const client = clients.get(imei);
    debug('sendUnlockCommand() – client.key=', client.key, 'socket.destroyed=', client.socket.destroyed);

    // Check if key is available
    if (!client.key) {
        console.log(`🔄 Key not available for ${imei}, requesting a new key...`);
        debug('sendUnlockCommand() – no key, calling requestNewKey and starting key poll');
        requestNewKey(imei);

        let attempts = 0;
        const keyCheckInterval = setInterval(() => {
            if (client.key) {
                clearInterval(keyCheckInterval);
                console.log(`🔑 New key obtained for ${imei}: ${client.key}`);
                debug('sendUnlockCommand() – key received, retrying unlock');
                sendUnlockCommand(imei);
            } else if (attempts++ >= 10) {
                clearInterval(keyCheckInterval);
                console.log(`❌ Error in obtaining key for ${imei}`);
                debug('sendUnlockCommand() – key timeout after 10 attempts');
            }
        }, 500);
        return;
    }

    if (client.socket.destroyed) {
        console.log(`❌ Lock ${imei} socket is destroyed (disconnected). Removed from list.`);
        removeClientBySocket(client.socket);
        return;
    }

    const ts = Math.floor(Date.now() / 1000);
    const unlockCommand = `*BGCS,OM,${imei},L0,${client.key},20,${ts}#\n`;
    debug('sendUnlockCommand() – SENDING (TCP with 0xFFFF):', unlockCommand.trim());
    writeServerCommand(client.socket, unlockCommand);
    console.log(`✅ Sent UNLOCK to ${imei}`);
}

// Lock Command
function sendLockCommand(imei) {
    debug('sendLockCommand() – imei=', imei, 'clients.has(imei)=', clients.has(imei));
    if (!clients.has(imei)) {
        console.log(`❌ Lock ${imei} is not connected.`);
        return;
    }
    
    const client = clients.get(imei);
    debug('sendLockCommand() – client.key=', client.key, 'socket.destroyed=', client.socket.destroyed);

    if (!client.key) {
        console.log(`🔄 Key not available for ${imei}, requesting a new key...`);
        debug('sendLockCommand() – no key, calling requestNewKey and starting key poll');
        requestNewKey(imei);

        let attempts = 0;
        const keyCheckInterval = setInterval(() => {
            if (client.key) {
                clearInterval(keyCheckInterval);
                console.log(`🔑 New key obtained for ${imei}: ${client.key}`);
                debug('sendLockCommand() – key received, retrying lock');
                sendLockCommand(imei);
            } else if (attempts++ >= 10) {
                clearInterval(keyCheckInterval);
                console.log(`❌ Error in obtaining key for ${imei}`);
                debug('sendLockCommand() – key timeout after 10 attempts');
            }
        }, 500);
        return;
    }

    if (client.socket.destroyed) {
        console.log(`❌ Lock ${imei} socket is destroyed (disconnected). Removed from list.`);
        removeClientBySocket(client.socket);
        return;
    }

    const lockCommand = `*BGCS,OM,${imei},L1,${client.key}#\n`;
    debug('sendLockCommand() – SENDING (TCP with 0xFFFF):', lockCommand.trim());
    writeServerCommand(client.socket, lockCommand);
    console.log(`✅ Sent LOCK to ${imei}`);
}

// Request New Key (server asks lock to send key; lock should reply with *BGCR,OM,imei,R0,key,...#)
function requestNewKey(imei) {
    debug('requestNewKey() – imei=', imei);
    if (!clients.has(imei)) {
        debug('requestNewKey() – no client, return');
        return;
    }
    const ts = Math.floor(Date.now() / 1000);
    const msg = `*BGCS,OM,${imei},R0,0,300,20,${ts}#\n`;
    debug('requestNewKey() – SENDING (TCP with 0xFFFF):', msg.trim());
    writeServerCommand(clients.get(imei).socket, msg);
    console.log(`🔄 Requested new key for ${imei} (watch for device reply with R0,key in *BGCR,OM,...)`);
}

// Handle Lock Responses (Protocol V2.1.8: L0/L1 status 0=success, 1=failed, 2=KEY incorrect or invalid)
// Server must always send Re,L0# or Re,L1# after lock response.
function handleLockResponse(imei, command, status, params) {
    debug('handleLockResponse() – imei=', imei, 'command=', command, 'status=', status, 'params=', params && params.join(','));
    if (status === "0") {
        debug('handleLockResponse() – status 0 (success), sending ACK');
        sendAck(imei, command);
    } else if (status === "1") {
        debug('handleLockResponse() – status 1 (failed), sending ACK');
        console.log(`⚠️ ${command} failed for ${imei} (status 1 – operation failed)`);
        sendAck(imei, command);
    } else if (status === "2") {
        // Protocol V2.1.8: status 2 = "The KEY is incorrect or invalid" – send ACK then request new key
        debug('handleLockResponse() – status 2 (KEY incorrect or invalid), sending ACK and requesting new key');
        console.log(`⚠️ ${command} for ${imei} – status 2 (KEY incorrect or invalid), ACK sent, requesting new key`);
        sendAck(imei, command);
        requestNewKey(imei);
    } else if (status === "3") {
        debug('handleLockResponse() – status 3 (key expired), sending ACK and requesting new key');
        sendAck(imei, command);
        requestNewKey(imei);
    } else {
        console.log(`❌ ${command} failed for ${imei} (status ${status})`);
        debug('handleLockResponse() – unhandled status', status);
        sendAck(imei, command); // still ACK per protocol so device gets server response
    }
}

// Send Acknowledgment
function sendAck(imei, command) {
    debug('sendAck() – imei=', imei, 'command=', command);
    if (!clients.has(imei)) {
        debug('sendAck() – no client, return');
        return;
    }
    const client = clients.get(imei);
    if (client.socket.destroyed) {
        debug('sendAck() – socket destroyed, skip');
        return;
    }
    const ackMsg = `*BGCS,OM,${imei},Re,${command}#\n`;
    debug('sendAck() – SENDING (TCP with 0xFFFF):', ackMsg.trim());
    writeServerCommand(client.socket, ackMsg);
    console.log(`✅ Sent ACK for ${command} to ${imei}`);
}

// Handle Alarm Trigger
function handleAlarm(imei, status) {
    console.log(`🚨 Alarm triggered on ${imei}. Status: ${status}`);
    debug('handleAlarm() – imei=', imei, 'status=', status);
}

// Handle Find Lock (Alarm Sound)
function handleFindLock(imei) {
    console.log(`🔊 Lock ${imei} is sounding an alarm!`);
    debug('handleFindLock() – imei=', imei);
}

// Restart Lock
function restartLock(imei) {
    debug('restartLock() – imei=', imei, 'clients.has(imei)=', clients.has(imei));
    if (!clients.has(imei)) return;
    const msg = `*BGCS,OM,${imei},S1#\n`;
    debug('restartLock() – SENDING (TCP with 0xFFFF):', msg.trim());
    writeServerCommand(clients.get(imei).socket, msg);
    console.log(`🔄 Restarted lock ${imei}`);
}

async function getDeviceStatus(imei) {
    debug('getDeviceStatus() – imei=', imei);
    if (!clients.has(imei)) {
        console.log(`❌ Lock ${imei} is not connected.`);
        debug('getDeviceStatus() – no client, return null');
        return null;
    }

    const client = clients.get(imei);
    debug('getDeviceStatus() – starting command sequence');
    let deviceInfo = {
        imei: imei,
        battery: null,
        batteryPercentage: null,
        macAddress: null,
        signalStrength: null,
        gsmSignal: null,
        simICCID: null,
        lockStatus: null,
        lockCalibrated: null,
        lockPosition: null,
        carDetected: null,
        autoLock: null,
        blockStatus: null,
        operationKey: null,
        unlockStatus: null,
        lockStatusResponse: null,
        unlockTimeout: null,
        operationKeyExpired: null,
        firmware: null,
        firmwareUpdate: null,
        alarmStatus: null,
        alarmTriggered: null,
        restartConfirmed: null,
        beepResponse: null,
        serverIP: null,
        serverPort: null,
        lastSeen: null
    };

    // Per protocol V2.1.8: Q0/H0 are Lock->Server only (no server request). L0/L1 need key+params.
    // So we only request R0 (key), S5 (full device info), W0 (alarm status) to get reliable responses.
    const commands = ['R0', 'S5', 'W0'];

    for (const command of commands) {
        debug('getDeviceStatus() – sending command', command);
        await sendCommandAndProcessResponse(client, imei, command, deviceInfo);
    }

    console.log("📊 Device Information Collected:", deviceInfo);
    debug('getDeviceStatus() – done, returning deviceInfo');
    return deviceInfo;
}

// ** Send Command & Wait for Response (only resolves when message command matches) **
// Per protocol V2.1.8: R0 requires params (operation, validTime, userID, timestamp); S5 and W0 use CMD# only.
function sendCommandAndProcessResponse(client, imei, command, deviceInfo) {
    return new Promise((resolve) => {
        let commandString;
        if (command === 'R0') {
            const ts = Math.floor(Date.now() / 1000);
            commandString = `*BGCS,OM,${imei},R0,0,300,20,${ts}#\n`;
        } else {
            commandString = `*BGCS,OM,${imei},${command}#\n`;
        }
        console.log(`🚀 Sending command: ${command} to ${imei}`);
        debug('sendCommandAndProcessResponse() – SENDING (TCP with 0xFFFF):', commandString.trim());
        writeServerCommand(client.socket, commandString);

        const timeoutId = setTimeout(() => {
            if (pendingResponseWaiters.get(`${imei}:${command}`)) {
                pendingResponseWaiters.delete(`${imei}:${command}`);
                console.log(`⚠ Timeout waiting for response to ${command} from ${imei}`);
                debug('sendCommandAndProcessResponse() – timeout for', command, imei);
            }
            resolve();
        }, 5000);

        pendingResponseWaiters.set(`${imei}:${command}`, {
            timeoutId,
            resolve: (result) => {
                if (result && result.message) {
                    console.log(`📩 Received response: ${result.message}`);
                    debug('sendCommandAndProcessResponse() – matched response for', command);
                    processDeviceResponse(imei, result.command, result.message, deviceInfo);
                }
                resolve();
            }
        });
    });
}

// ** Process Device Response & Store in `deviceInfo` **
function processDeviceResponse(imei, commandFromMessage, message, deviceInfo) {
    debug('processDeviceResponse() – imei=', imei, 'command=', commandFromMessage, 'message length=', message.length);
    const normalizedMsg = message.replace(/\s+/g, ' ').trim();
    const match = normalizedMsg.match(/\*BGCR,OM,(\d{15}),(Q0|H0|R0|L0|L1|S5|W0|S1|S8),([\s\S]+)#/);
    if (!match) {
        console.log(`⚠ Unexpected response format from ${imei}: ${message.substring(0, 100)}`);
        debug('processDeviceResponse() – no regex match');
        return;
    }

    const responseCommand = match[2];
    const params = match[3].replace(/\s+/g, '').split(',');
    debug('processDeviceResponse() – matched', responseCommand, 'params count=', params.length);

    switch (responseCommand) {
        case 'Q0':
            deviceInfo.battery = params[0] || null;
            deviceInfo.macAddress = params[1] || null;
            deviceInfo.lockCalibrated = params[2] === "1";
            deviceInfo.lockPosition = params[3] || null;
            break;
        case 'H0':
            deviceInfo.signalStrength = params[0] || null;
            deviceInfo.battery = params[1] || deviceInfo.battery;
            deviceInfo.gsmSignal = params[2] || null;
            deviceInfo.carDetected = params[3] === "1";
            deviceInfo.autoLock = params[4] === "1";
            break;
        case 'R0':
            deviceInfo.operationKey = params[1] || null;
            break;
        case 'L0':
            deviceInfo.unlockStatus = params[0] === "0" ? "Success" : (params[0] === "2" ? "KeyInvalid" : "Failed");
            if (params[0] === "2" || params[0] === "3") deviceInfo.operationKeyExpired = true;
            break;
        case 'L1':
            deviceInfo.lockStatusResponse = params[0] === "0" ? "Success" : (params[0] === "2" ? "KeyInvalid" : "Failed");
            if (params[0] === "2" || params[0] === "3") deviceInfo.operationKeyExpired = true;
            break;
        case 'S5':
            // Protocol 2.3: voltage, percentage, signal, lockStatus, carDetected, leverPosition, ICCID, APN, MAC, autoLock
            deviceInfo.batteryVoltage = params[0] || null;
            deviceInfo.batteryPercentage = params[1] || null;
            deviceInfo.gsmSignal = params[2] || null;
            deviceInfo.lockStatus = params[3] || null;   // 1:lock, 0:unlock
            deviceInfo.carDetected = params[4] === "1";
            deviceInfo.lockLeverPosition = params[5] || null; // 1:horizontal, 2:upright, 3:other
            deviceInfo.simICCID = params[6] || null;
            deviceInfo.simAPN = params[7] || null;
            deviceInfo.macAddress = params[8] || null;   // Bluetooth MAC
            deviceInfo.autoLock = params[9] === "1";
            deviceInfo.lastSeen = new Date().toISOString();
            break;
        case 'W0':
            deviceInfo.alarmStatus = params[0] || null;
            break;
        case 'S1':
            deviceInfo.restartConfirmed = "Confirmed";
            break;
        case 'S8':
            deviceInfo.beepResponse = "Received";
            break;
    }

    deviceInfo.lastSeen = new Date();
}

// Start the Server and Echo Commands when run directly (CLI)
if (require.main === module) {
    createTCP();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => echoCommands(line));
}

// Export for `api.js` (TCP + API in one process)
module.exports = { sendUnlockCommand, sendLockCommand, createTCP, getDeviceStatus };

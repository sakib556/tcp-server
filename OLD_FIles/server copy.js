const net = require('net');
const readline = require('readline');

const PORT = 12345;
const HOST = '0.0.0.0';

const clients = new Map(); // IMEI -> { socket, key, battery, status, lastSeen, gsmSignal, alarm, autolock }

// Create TCP Server
function createTCP() {
    const server = net.createServer((socket) => {
        console.log('🔗 New connection established.');

        socket.on('data', (data) => incomingData(socket, data));
        socket.on('end', () => console.log('❌ Client disconnected.'));
        socket.on('error', (err) => console.log(`⚠ Error: ${err.message}`));
    });

    server.listen(PORT, HOST, () => console.log(`🚀 TCP Server running on ${HOST}:${PORT}`));
}

// Handle Incoming Data
function incomingData(socket, data) {
    const message = data.toString().trim();
    console.log(`📩 Data received: ${message}`);

    // **Handle Manual Commands (unlock, lock, restart)**
    if (message.startsWith("unlock ") || message.startsWith("lock ") || message.startsWith("restart ")) {
    echoCommands(message);
    return; // Stop further processing
    }

    // **Handle Lock Protocol Messages**
    const match = message.match(/\*BGCR,OM,(\d{15}),(Q0|H0|R0|L0|L1|S5|W0|S1|S8),(.+)#/);
    if (!match) {
        console.log("⚠ Received unknown data:", message);
        return;
    }

    const imei = match[1];
    const command = match[2];
    const params = match[3].split(',');

    if (!clients.has(imei)) {
        clients.set(imei, { socket, key: null, battery: null, status: null, lastSeen: null, gsmSignal: null, alarm: null, autolock: null });
        console.log(`✅ Lock ${imei} connected.`);
    }
    clients.get(imei).lastSeen = Date.now();
    processData(imei, command, params);
}


// Process Incoming Data
function processData(imei, command, params) {
    const client = clients.get(imei);
    switch (command) {
        case 'Q0': // Sign-in
            client.battery = params[0];
            client.status = params[2];
            console.log(`🔑 Lock ${imei} signed in. Battery: ${client.battery}mV, Status: ${client.status}`);
            break;
        case 'H0': // Heartbeat
            client.battery = params[1];
            client.gsmSignal = params[2];
            console.log(`💓 Heartbeat from ${imei}. Battery: ${client.battery}mV, GSM: ${client.gsmSignal}`);
            break;
        case 'R0': // Operation Key Request
            client.key = params[1];
            console.log(`🔑 Stored key for lock ${imei}: ${client.key}`);
            break;
        case 'L0': // Unlock Response
        case 'L1': // Lock Response
            handleLockResponse(imei, command, params[0]);
            break;
        case 'S5': // Device Info
            console.log(`ℹ️ Device Info for ${imei}: Battery ${params[0]}mV, GSM: ${params[2]}, Status: ${params[3]}`);
            break;
        case 'W0': // Alarm Triggered
            handleAlarm(imei, params[0]);
            break;
        case 'S1': // Restart Lock
            restartLock(imei);
            break;
        case 'S8': // Find Lock (Alarm Sound)
            handleFindLock(imei);
            break;
    }
}

// Manual Command Handler
function echoCommands(input) {
    if (!input || typeof input !== "string") {
        console.log("⚠ Error: Received invalid command input.");
        return;
    }

    const [command, imei] = input.split(/[ ,]+/); // Supports both spaces and commas

    if (!imei) {
        console.log("⚠ Error: IMEI missing in command.");
        return;
    }

    if (command === "unlock") sendUnlockCommand(imei);
    else if (command === "lock") sendLockCommand(imei);
    else if (command === "restart") restartLock(imei);
    else console.log("⚠ Invalid command! Use 'unlock IMEI', 'lock IMEI', or 'restart IMEI'");
}



// Unlock Command
function sendUnlockCommand(imei) {
    if (!clients.has(imei)) {
        console.log(`❌ Lock ${imei} is not connected.`);
        return;
    }
    
    const client = clients.get(imei);

    // Check if key is available
    if (!client.key) {
        console.log(`🔄 Key not available for ${imei}, requesting a new key...`);
        requestNewKey(imei);

        // Wait for key update (Polling every 500ms, timeout after 5 seconds)
        let attempts = 0;
        const keyCheckInterval = setInterval(() => {
            if (client.key) {
                clearInterval(keyCheckInterval);
                console.log(`🔑 New key obtained for ${imei}: ${client.key}`);
                sendUnlockCommand(imei); // Retry unlock after key retrieval
            } else if (attempts++ >= 10) {
                clearInterval(keyCheckInterval);
                console.log(`❌ Error in obtaining key for ${imei}`);
            }
        }, 500);
        return;
    }

    if (!client.socket.writable) {
        console.log(`❌ Connection to lock ${imei} is closed.`);
        return;
    }

    const unlockCommand = `*BGCS,OM,${imei},L0,${client.key},20,${Math.floor(Date.now() / 1000)}#\n`;
    client.socket.write(unlockCommand);
    console.log(`✅ Sent UNLOCK to ${imei}`);
}

// Lock Command
function sendLockCommand(imei) {
    if (!clients.has(imei)) {
        console.log(`❌ Lock ${imei} is not connected.`);
        return;
    }
    
    const client = clients.get(imei);

    // Check if key is available
    if (!client.key) {
        console.log(`🔄 Key not available for ${imei}, requesting a new key...`);
        requestNewKey(imei);

        // Wait for key update (Polling every 500ms, timeout after 5 seconds)
        let attempts = 0;
        const keyCheckInterval = setInterval(() => {
            if (client.key) {
                clearInterval(keyCheckInterval);
                console.log(`🔑 New key obtained for ${imei}: ${client.key}`);
                sendLockCommand(imei); // Retry lock after key retrieval
            } else if (attempts++ >= 10) {
                clearInterval(keyCheckInterval);
                console.log(`❌ Error in obtaining key for ${imei}`);
            }
        }, 500);
        return;
    }

    if (!client.socket.writable) {
        console.log(`❌ Connection to lock ${imei} is closed.`);
        return;
    }

    const lockCommand = `*BGCS,OM,${imei},L1,${client.key}#\n`;
    client.socket.write(lockCommand);
    console.log(`✅ Sent LOCK to ${imei}`);
}


// Request New Key
function requestNewKey(imei) {
    if (!clients.has(imei)) return;
    clients.get(imei).socket.write(`*BGCS,OM,${imei},R0,0,300,20,${Math.floor(Date.now() / 1000)}#\n`);
    console.log(`🔄 Requested new key for ${imei}`);
}

// Handle Lock Responses
function handleLockResponse(imei, command, status) {
    if (status === "0") sendAck(imei, command);
    else if (status === "3") requestNewKey(imei);
    else console.log(`❌ ${command} failed for ${imei}`);
}

// Send Acknowledgment
function sendAck(imei, command) {
    if (!clients.has(imei)) return;
    clients.get(imei).socket.write(`*BGCS,OM,${imei},Re,${command}#\n`);
    console.log(`✅ Sent ACK for ${command} to ${imei}`);
}

// Handle Alarm Trigger
function handleAlarm(imei, status) {
    console.log(`🚨 Alarm triggered on ${imei}. Status: ${status}`);
}

// Handle Find Lock (Alarm Sound)
function handleFindLock(imei) {
    console.log(`🔊 Lock ${imei} is sounding an alarm!`);
}

// Restart Lock
function restartLock(imei) {
    if (!clients.has(imei)) return;
    clients.get(imei).socket.write(`*BGCS,OM,${imei},S1#\n`);
    console.log(`🔄 Restarted lock ${imei}`);
}

// Start the Server and Echo Commands 
// Start TCP Server only if executed directly
if (require.main === module) {
    createTCP();
    echoCommands();
}

// Export functions for `api.js`
module.exports = { sendUnlockCommand, sendLockCommand };
createTCP();
echoCommands();

// Export functions for `api.js`
module.exports = { sendUnlockCommand, sendLockCommand };

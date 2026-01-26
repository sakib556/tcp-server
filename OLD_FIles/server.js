const net = require('net');
const readline = require('readline');

const PORT = 12345;
const HOST = '0.0.0.0';

const clients = new Map(); // IMEI -> { socket, key, battery, status, lastSeen }

const server = net.createServer((socket) => {
    console.log('🔗 New connection established.');

    socket.on('data', (data) => {
        const message = data.toString().trim();
        console.log(`📩 Data received: ${message}`);

        // Handle Manual Commands via Netcat (nc)
        if (message.startsWith("unlock ")) {
            const imei = message.split(" ")[1];
            sendUnlockCommand(imei);
            return;
        } else if (message.startsWith("lock ")) {
            const imei = message.split(" ")[1];
            sendLockCommand(imei);
            return;
        }

        // Extract IMEI and Command
        const match = message.match(/^\*BGCR,OM,(\d{15}),(Q0|H0|R0|L0|L1),(.+)#/);
        if (!match) {
            console.log("⚠ Received unknown data:", message);
            return;
        }

        const imei = match[1];
        const command = match[2];
        const params = match[3].split(',');

        // Store Client Information
        if (!clients.has(imei)) {
            clients.set(imei, { socket, key: null, battery: null, status: null, lastSeen: null });
            console.log(`✅ Lock ${imei} connected.`);
        }
        const client = clients.get(imei);
        client.lastSeen = Date.now();

        // Process Commands
        switch (command) {
            case 'Q0': // Sign-in
                client.battery = params[0];
                client.status = params[2];
                console.log(`🔑 Lock ${imei} signed in. Battery: ${client.battery}mV, Status: ${client.status}`);
                break;
            case 'H0': // Heartbeat
                client.battery = params[1];
                client.status = params[3];
                console.log(`💓 Heartbeat from ${imei}. Battery: ${client.battery}mV, Status: ${client.status}`);
                break;
            case 'R0': // Key Response
                client.key = params[1];
                console.log(`🔑 Stored key for lock ${imei}: ${client.key}`);
                break;
            case 'L0': // Unlock Response
            case 'L1': // Lock Response
                handleLockResponse(imei, command, params[0]);
                break;
        }
    });

    socket.on('end', () => console.log('❌ Client disconnected.'));
    socket.on('error', (err) => console.log(`⚠ Error: ${err.message}`));
});

server.listen(PORT, HOST, () => console.log(`🚀 TCP Server running on ${HOST}:${PORT}`));

// ** Readline Interface for Manual Commands (via SSH Terminal) **
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (input) => {
    const [command, imei] = input.split(' ');

    if (command === 'unlock' && imei) {
        sendUnlockCommand(imei);
    } else if (command === 'lock' && imei) {
        sendLockCommand(imei);
    } else {
        console.log("⚠ Invalid command! Use 'unlock IMEI' or 'lock IMEI'");
    }
});

// ** Unlock Command **
function sendUnlockCommand(imei) {
    if (!clients.has(imei)) {
        console.log(`❌ Lock ${imei} is not connected.`);
        return;
    }
    const client = clients.get(imei);

    if (!client.key) {
        console.log(`🔄 No key received for lock ${imei}. Requesting new key...`);
        requestNewKey(imei);
        return;
    }

    if (!client.socket.writable) {
        console.log(`❌ Connection to lock ${imei} is closed.`);
        return;
    }

    const unlockCommand = `*BGCS,OM,${imei},L0,${client.key},20,${Math.floor(Date.now() / 1000)}#\n`;
    client.socket.write(unlockCommand);
    console.log(`✅ Sent UNLOCK command to lock ${imei} with key ${client.key}`);
}

// ** Lock Command **
function sendLockCommand(imei) {
    if (!clients.has(imei)) {
        console.log(`❌ Lock ${imei} is not connected.`);
        return;
    }
    const client = clients.get(imei);

    if (!client.key) {
        console.log(`🔄 No key received for lock ${imei}. Requesting new key...`);
        requestNewKey(imei);
        return;
    }

    if (!client.socket.writable) {
        console.log(`❌ Connection to lock ${imei} is closed.`);
        return;
    }

    const lockCommand = `*BGCS,OM,${imei},L1,${client.key}#\n`;
    client.socket.write(lockCommand);
    console.log(`✅ Sent LOCK command to lock ${imei} with key ${client.key}`);
}

// ** Request New Key if Expired **
function requestNewKey(imei) {
    if (!clients.has(imei)) {
        console.log(`❌ Lock ${imei} is not connected.`);
        return;
    }

    const client = clients.get(imei);
    const keyRequestCommand = `*BGCS,OM,${imei},R0,0,300,20,${Math.floor(Date.now() / 1000)}#\n`;
    client.socket.write(keyRequestCommand);
    console.log(`🔄 Requested new operation key for lock ${imei}`);
}

// ** Handle Lock/Unlock Responses **
function handleLockResponse(imei, command, status) {
    if (status === "0") {
        console.log(`✅ ${command} operation successful for lock ${imei}.`);
        sendAck(imei, command);
    } else if (status === "3") {
        console.log(`⚠ Operation key expired for lock ${imei}. Requesting a new one...`);
        requestNewKey(imei);
    } else {
        console.log(`❌ ${command} operation failed for lock ${imei}.`);
    }
}

// ** Send Acknowledgment **
function sendAck(imei, command) {
    if (!clients.has(imei)) return;
    const client = clients.get(imei);

    if (client.socket.writable) {
        const ackCommand = `*BGCS,OM,${imei},Re,${command}#\n`;
        client.socket.write(ackCommand);
        console.log(`✅ Sent ACK for ${command} to lock ${imei}`);
    }
}

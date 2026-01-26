const net = require('net');
const { Pool } = require('pg');
const { handleUnlock, handleLock } = require('./functions');

const PORT = 12345;
const HOST = '0.0.0.0';

// PostgreSQL Database Connection
const pool = new Pool({
    user: 'vpsadmin',
    host: 'localhost',
    database: 'lock_system',
    password: 'JahidHasan@147',
    port: 5432,
});

const clients = new Map(); // IMEI -> { socket, lastSeen }

const server = net.createServer((socket) => {
    console.log('🔗 New connection established.');

    socket.on('data', async (data) => {
        const message = data.toString().trim();
        console.log(`📩 Data received: ${message}`);

        // Extract IMEI and Command
        const match = message.match(/^\*BGCR,OM,(\d{15}),(Q0|H0|R0|L0|L1),(.+)#/);
        if (!match) {
            console.log("⚠ Received unknown data:", message);
            return;
        }

        const imei = match[1];
        const command = match[2];
        const params = match[3].split(',');

        // Store client socket
        if (!clients.has(imei)) {
            clients.set(imei, { socket, lastSeen: Date.now() });
            console.log(`✅ Lock ${imei} connected.`);
        }
        clients.get(imei).lastSeen = Date.now();

        // Process Commands
        switch (command) {
            case 'Q0': // Sign-in
            case 'H0': // Heartbeat
                await updateDeviceStatus(imei, params);
                break;
            case 'R0': // Key Response
                await storeLockKey(imei, params[1]); // Store operation key in DB
                break;
            case 'L0': // Unlock Response
            case 'L1': // Lock Response
                await handleLockResponse(imei, command, params[0]);
                break;
        }
    });

    socket.on('end', () => console.log('❌ Client disconnected.'));
    socket.on('error', (err) => console.log(`⚠ Error: ${err.message}`));
});

server.listen(PORT, HOST, () => console.log(`🚀 TCP Server running on ${HOST}:${PORT}`));

// ** Update Device Info in Database **
async function updateDeviceStatus(imei, params) {
    const battery = params[0] ? parseInt(params[0]) : 0000;
    const macAddress = params[1] || "MISSING DATA";  // MAC Address of the lock
    const signal = params[2] ? parseInt(params[2]) : 0000;
    const carDetected = params[3] === "1";
    const lockPosition = params[4] ? parseInt(params[4]) : 0000;  // Lock position
    const unlockCalibrated = params[5] === "1";
    const lockCalibrated = params[6] === "1";
    const autoLock = params[7] === "1";
    const firmware = params[8] || "MISSING DATA";  // Firmware version

    try {
        await pool.query(
            `INSERT INTO devices (imei, mac_address, firmware, battery, signal_strength, car_detected, auto_lock, unlock_calibrated, lock_calibrated, lock_position, last_seen)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
             ON CONFLICT (imei) 
             DO UPDATE SET mac_address = $2, firmware = $3, battery = $4, signal_strength = $5, car_detected = $6, auto_lock = $7, unlock_calibrated = $8, lock_calibrated = $9, lock_position = $10, last_seen = NOW()`,
            [imei, macAddress, firmware, battery, signal, carDetected, autoLock, unlockCalibrated, lockCalibrated, lockPosition]
        );
        console.log(`📌 Device ${imei} status updated in database.`);
    } catch (err) {
        console.error(`❌ Database Error (updateDeviceStatus):`, err.message);
    }
}



// ** Store Operation Key in Database **
async function storeLockKey(imei, key) {
    try {
        await pool.query(
            `UPDATE devices SET operation_key = $1 WHERE imei = $2`,
            [key, imei]
        );
        console.log(`🔑 Stored key for lock ${imei}: ${key}`);
    } catch (err) {
        console.error(`❌ Database Error (storeLockKey):`, err.message);
    }
}

// ** Handle Lock/Unlock Response **
async function handleLockResponse(imei, command, status) {
    if (status === "0") {
        console.log(`✅ ${command} operation successful for lock ${imei}.`);
    } else if (status === "3") {
        console.log(`⚠ Operation key expired for lock ${imei}. Requesting a new one...`);
        await requestNewKey(imei);
    } else {
        console.log(`❌ ${command} operation failed for lock ${imei}.`);
    }
}

// ** Request New Key if Expired **
async function requestNewKey(imei) {
    const client = clients.get(imei);
    if (!client) {
        console.log(`❌ Lock ${imei} is not connected.`);
        return;
    }

    const keyRequestCommand = `*BGCS,OM,${imei},R0,0,300,20,${Math.floor(Date.now() / 1000)}#\n`;
    client.socket.write(keyRequestCommand);
    console.log(`🔄 Requested new operation key for lock ${imei}`);
}

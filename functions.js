const { Pool } = require('pg');

const pool = new Pool({
    user: 'vpsadmin',
    host: 'localhost',
    database: 'lock_system',
    password: 'JahidHasan@147',
    port: 5432,
});

// ** Unlock Function **
async function unlock(imei) {
    const client = await getLockClient(imei);
    if (!client) return;

    // Retrieve the operation key
    const operationKey = await getOperationKey(imei);
    if (!operationKey) {
        console.log(`❌ No valid key for lock ${imei}, requesting new key...`);
        await requestNewKey(imei);
        return;
    }

    const unlockCommand = `*BGCS,OM,${imei},L0,${operationKey},20,${Math.floor(Date.now() / 1000)}#\n`;
    client.socket.write(unlockCommand);
    console.log(`✅ Sent UNLOCK command to lock ${imei}`);

    await logCommand(imei, "unlock", "pending");
}

// ** Lock Function **
async function lock(imei) {
    const client = await getLockClient(imei);
    if (!client) return;

    const operationKey = await getOperationKey(imei);
    if (!operationKey) {
        console.log(`❌ No valid key for lock ${imei}, requesting new key...`);
        await requestNewKey(imei);
        return;
    }

    const lockCommand = `*BGCS,OM,${imei},L1,${operationKey}#\n`;
    client.socket.write(lockCommand);
    console.log(`✅ Sent LOCK command to lock ${imei}`);

    await logCommand(imei, "lock", "pending");
}

// ** Get Lock Status from Database **
async function getStatus(imei) {
    try {
        const result = await pool.query("SELECT * FROM devices WHERE imei = $1", [imei]);
        if (result.rows.length === 0) {
            console.log(`❌ Lock ${imei} not found in database.`);
            return null;
        }
        return result.rows[0];
    } catch (err) {
        console.error("❌ Database Error (getStatus):", err.message);
        return null;
    }
}

// ** Beep Once to Locate Lock (S8 Command) **
async function beepOnce(imei) {
    const client = await getLockClient(imei);
    if (!client) return;

    const beepCommand = `*BGCS,OM,${imei},S8#\n`;
    client.socket.write(beepCommand);
    console.log(`🔊 Sent BEEP command to lock ${imei}`);

    await logCommand(imei, "beep", "pending");
}

// ** Restart Lock (S1 Command) **
async function restart(imei) {
    const client = await getLockClient(imei);
    if (!client) return;

    const restartCommand = `*BGCS,OM,${imei},S1#\n`;
    client.socket.write(restartCommand);
    console.log(`🔄 Sent RESTART command to lock ${imei}`);

    await logCommand(imei, "restart", "pending");
}

// ** Retrieve Lock Client from Connected Clients Map **
async function getLockClient(imei) {
    const { clients } = require('./server'); // Import the clients map from server.js
    if (!clients.has(imei)) {
        console.log(`❌ Lock ${imei} is not connected.`);
        return null;
    }
    return clients.get(imei);
}

// ** Retrieve Operation Key from Database **
async function getOperationKey(imei) {
    try {
        const result = await pool.query("SELECT operation_key FROM devices WHERE imei = $1", [imei]);
        return result.rows.length > 0 ? result.rows[0].operation_key : null;
    } catch (err) {
        console.error("❌ Database Error (getOperationKey):", err.message);
        return null;
    }
}

// ** Request New Operation Key if Expired **
async function requestNewKey(imei) {
    const client = await getLockClient(imei);
    if (!client) return;

    const keyRequestCommand = `*BGCS,OM,${imei},R0,0,300,20,${Math.floor(Date.now() / 1000)}#\n`;
    client.socket.write(keyRequestCommand);
    console.log(`🔄 Requested new operation key for lock ${imei}`);
}

// ** Log Commands in Database **
async function logCommand(imei, command, status) {
    try {
        await pool.query(
            "INSERT INTO commands (imei, command, status, timestamp) VALUES ($1, $2, $3, NOW())",
            [imei, command, status]
        );
    } catch (err) {
        console.error("❌ Database Error (logCommand):", err.message);
    }
}

// ** Export Functions **
module.exports = {
    unlock,
    lock,
    getStatus,
    beepOnce,
    restart
};

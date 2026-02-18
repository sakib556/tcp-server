const express = require('express');
const cors = require('cors');
const { sendUnlockCommand, sendLockCommand, createTCP, getDeviceStatus } = require('./server');

// Start TCP server (port 12345) so API and TCP share the same connected clients
createTCP();

const app = express();
const PORT = 5000;

// Middleware
app.use(express.json());
app.use(cors());

// Map server deviceInfo to app DeviceStatusData format
function toDeviceStatusData(deviceInfo) {
    if (!deviceInfo) return null;
    const lockStatusMap = { '0': 'unlocked', '1': 'locked' };
    const leverMap = { '1': 'horizontal', '2': 'upright', '3': 'other' };
    return {
        battery: String(deviceInfo.batteryVoltage ?? deviceInfo.battery ?? ''),
        signal: String(deviceInfo.gsmSignal ?? deviceInfo.signalStrength ?? ''),
        lockStatus: lockStatusMap[deviceInfo.lockStatus] ?? String(deviceInfo.lockStatus ?? ''),
        carDetected: Boolean(deviceInfo.carDetected),
        lockLeverPosition: leverMap[deviceInfo.lockLeverPosition] ?? String(deviceInfo.lockLeverPosition ?? ''),
        simICCID: String(deviceInfo.simICCID ?? ''),
        simAPN: String(deviceInfo.simAPN ?? ''),
        bluetoothMAC: String(deviceInfo.macAddress ?? ''),
        autoLock: Boolean(deviceInfo.autoLock),
    };
}

// ✅ API Route: Device status (for app getDeviceStatus) – GET or POST with imei
app.get('/request-status', (req, res) => {
    const imei = req.query.imei;
    console.log('[DEBUG] API GET /request-status – imei=', imei);
    if (!imei) {
        return res.status(400).json({ success: false, error: 'IMEI is required', deviceData: null });
    }
    getDeviceStatus(imei).then((deviceInfo) => {
        if (!deviceInfo) {
            return res.json({ success: false, error: 'Lock not connected', deviceData: null });
        }
        res.json({ success: true, deviceData: toDeviceStatusData(deviceInfo) });
    }).catch((err) => {
        console.error('[DEBUG] API /request-status error:', err);
        res.status(500).json({ success: false, error: String(err.message), deviceData: null });
    });
});

app.post('/request-status', (req, res) => {
    const imei = req.body.imei || req.query.imei;
    console.log('[DEBUG] API POST /request-status – imei=', imei);
    if (!imei) {
        return res.status(400).json({ success: false, error: 'IMEI is required', deviceData: null });
    }
    getDeviceStatus(imei).then((deviceInfo) => {
        if (!deviceInfo) {
            return res.json({ success: false, error: 'Lock not connected', deviceData: null });
        }
        res.json({ success: true, deviceData: toDeviceStatusData(deviceInfo) });
    }).catch((err) => {
        console.error('[DEBUG] API /request-status error:', err);
        res.status(500).json({ success: false, error: String(err.message), deviceData: null });
    });
});

// ✅ API Route to Unlock a Lock
app.post('/unlock', (req, res) => {
    const { imei } = req.body;
    console.log('[DEBUG] API POST /unlock – body:', JSON.stringify(req.body), 'imei=', imei);
    if (!imei) {
        console.log('[DEBUG] API /unlock – missing imei, 400');
        return res.status(400).json({ success: false, error: "IMEI is required" });
    }
    const response = sendUnlockCommand(imei);
    console.log('[DEBUG] API /unlock – response from sendUnlockCommand:', response);
    res.json({ success: true, message: response });
});

// ✅ API Route to Lock a Lock
app.post('/lock', (req, res) => {
    const { imei } = req.body;
    console.log('[DEBUG] API POST /lock – body:', JSON.stringify(req.body), 'imei=', imei);
    if (!imei) {
        console.log('[DEBUG] API /lock – missing imei, 400');
        return res.status(400).json({ success: false, error: "IMEI is required" });
    }
    const response = sendLockCommand(imei);
    console.log('[DEBUG] API /lock – response from sendLockCommand:', response);
    res.json({ success: true, message: response });
});

// Start the HTTP API (port 5000) – same process as TCP server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API Server running on http://0.0.0.0:${PORT}`);
});

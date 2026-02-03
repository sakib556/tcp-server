const express = require('express');
const cors = require('cors');
const { sendUnlockCommand, sendLockCommand, createTCP } = require('./server');

// Start TCP server (port 12345) so API and TCP share the same connected clients
createTCP();

const app = express();
const PORT = 5000;

// Middleware
app.use(express.json());
app.use(cors());

// ✅ API Route to Unlock a Lock
app.post('/unlock', (req, res) => {
    const { imei } = req.body;
    if (!imei) {
        return res.status(400).json({ success: false, error: "IMEI is required" });
    }
    const response = sendUnlockCommand(imei);
    res.json({ success: true, message: response });
});

// ✅ API Route to Lock a Lock
app.post('/lock', (req, res) => {
    const { imei } = req.body;
    if (!imei) {
        return res.status(400).json({ success: false, error: "IMEI is required" });
    }
    const response = sendLockCommand(imei);
    res.json({ success: true, message: response });
});

// Start the HTTP API (port 5000) – same process as TCP server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API Server running on http://0.0.0.0:${PORT}`);
});

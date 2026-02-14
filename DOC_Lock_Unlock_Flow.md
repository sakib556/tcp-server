# Lock / Unlock – How Data Flows (Simple)

This doc explains **what happens when you hit the Lock or Unlock API**: what the code does, and what is **sent** and **received** over TCP.

---

## 1. Two Parts of the System

| Part | Port | Who uses it | Role |
|------|------|-------------|------|
| **TCP server** | 12345 | The **lock device** (connects and stays connected) | Lock talks to server here. All lock commands go over this connection. |
| **HTTP API** | 5000 | **You / Postman / app** (POST /unlock or /lock) | You send IMEI; server turns that into a command and sends it to the lock over TCP. |

So: **You → HTTP (5000) → Server → TCP (12345) → Lock.**  
The lock never talks HTTP; it only talks TCP.

---

## 2. When the Lock First Connects (Before Any API Call)

**What the lock does**

- Connects to the server at **IP:port 12345** (e.g. your VPS IP and 12345).
- Sends a **sign-in** message so the server knows which lock it is and can store a **key**.

**What the lock sends (examples)**

- Sign-in:  
  `*BGCR,OM,862771078225219,Q0,3335,8C:59:DD:01:F5:D4,0,0,3#`
- Later, heartbeats:  
  `*BGCR,OM,862771078225219,H0,1,3330,16,0,3,0,0,1#`
- When the server asks for a key, the lock sends:  
  `*BGCR,OM,862771078225219,R0,0,9,20,1771050864#`  
  Here **9** is the key; the server saves it.

**What the code does**

- Listens for TCP data in `incomingData(socket, data)`.
- Parses messages that look like `*BGCR,OM,IMEI,COMMAND,params#`.
- If the IMEI is new, it **adds the lock to the list** (`clients` map) with that socket and `key: null`.
- For **Q0** (sign-in): saves battery, status.
- For **H0** (heartbeat): updates battery, GSM.
- For **R0**: saves **key** in `client.key` (e.g. `9`).  
This key is **required** for every unlock/lock command later.

So before unlock/lock can work: **lock must be connected and the server must have received and stored the key** (from R0 or BGCK).

---

## 3. When You Hit “Unlock” (POST /unlock)

**Step 1 – You (Postman / app)**

- Send:  
  `POST http://your-server:5000/unlock`  
  Body: `{ "imei": "862771078225219" }`

**Step 2 – API (api.js)**

- Receives the request, reads `imei`.
- Calls `sendUnlockCommand(imei)` from `server.js`.

**Step 3 – Server (server.js) – sendUnlockCommand(imei)**

- Checks: is this IMEI in the list of connected locks?  
  - **No** → returns; you see “Lock … is not connected.”
- Checks: do we have a **key** for this lock?  
  - **No** → sends a **key request** over TCP (see “Key request” below), waits up to ~5 s for R0, then retries unlock when key arrives.  
  - **Yes** → continues.
- Checks: is the TCP socket destroyed?  
  - **Yes** → removes lock from list, returns.
- **Sends over TCP** (to the lock):  
  `*BGCS,OM,862771078225219,L0,9,20,1771050864#`  
  (IMEI, **L0** = unlock, **key**, 20, Unix timestamp)
- Logs: “✅ Sent UNLOCK to …”

**Step 4 – Lock (device)**

- Receives the L0 command.
- Unlocks the machine.
- **Sends back over TCP**:  
  `*BGCR,OM,862771078225219,L0,0,0,1770222153#`  
  (L0 = unlock response, **0** = success)

**Step 5 – Server – incomingData**

- Receives that string from the lock.
- Parses it: command = **L0**, status = **0** (success).
- Calls `handleLockResponse(imei, 'L0', '0')` → then **sendAck**.

**Step 6 – Server – sendAck**

- **Sends over TCP** (to the lock):  
  `*BGCS,OM,862771078225219,Re,L0#`  
  (Re = acknowledgment for L0)
- Logs: “✅ Sent ACK for L0 to …”

**Step 7 – API response to you**

- Returns JSON like:  
  `{ "success": true, "message": ... }`

So for unlock: **You send IMEI via HTTP → server sends L0 + key over TCP → lock unlocks and sends L0,0 → server sends ACK over TCP.**

---

## 4. When You Hit “Lock” (POST /lock)

Same idea as unlock, but:

- API calls `sendLockCommand(imei)`.
- Server checks: connected? key? socket ok?
- **Sends over TCP**:  
  `*BGCS,OM,862771078225219,L1,9#`  
  (**L1** = lock, **key**)
- Lock locks and **sends back**:  
  `*BGCR,OM,862771078225219,L1,0,...#`  
  (0 = success)
- Server sends ACK:  
  `*BGCS,OM,862771078225219,Re,L1#`

So for lock: **You send IMEI via HTTP → server sends L1 + key over TCP → lock locks and sends L1,0 → server sends ACK over TCP.**

---

## 5. When the Server Needs a Key (No Key Yet)

If you hit unlock/lock and the server does not have a key for that IMEI:

1. **Server sends over TCP** (key request):  
   `*BGCS,OM,862771078225219,R0,0,300,20,1771050864#`
2. **Lock replies over TCP**:  
   `*BGCR,OM,862771078225219,R0,0,9,20,1771050864#`  
   Server takes **9** and stores it in `client.key`.
3. Then the server sends the unlock (or lock) command as in sections 3 or 4.

So the key is **received from the lock over TCP** (R0 message); the server only **requests** it (R0 command) and then **uses** it in every L0/L1 command.

---

## 6. Quick Reference – Who Sends What Over TCP

| Who | Direction | Example message | Meaning |
|-----|-----------|------------------|---------|
| Lock | → Server | `*BGCR,OM,IMEI,Q0,...#` | Sign-in |
| Lock | → Server | `*BGCR,OM,IMEI,H0,...#` | Heartbeat (battery, GSM) |
| Lock | → Server | `*BGCR,OM,IMEI,R0,0,key,...#` | Key (key = number server stores) |
| Lock | → Server | `*BGCR,OM,IMEI,L0,0,...#` | Unlock success (0) or fail |
| Lock | → Server | `*BGCR,OM,IMEI,L1,0,...#` | Lock success (0) or fail |
| Server | → Lock | `*BGCS,OM,IMEI,R0,0,300,20,timestamp#` | Please send your key |
| Server | → Lock | `*BGCS,OM,IMEI,L0,key,20,timestamp#` | Unlock |
| Server | → Lock | `*BGCS,OM,IMEI,L1,key#` | Lock |
| Server | → Lock | `*BGCS,OM,IMEI,Re,L0#` or `Re,L1#` | ACK for unlock/lock |

- **BGCR** = from device (lock).  
- **BGCS** = from server (commands / ACK).

---

## 7. Where in the Code Things Happen

| What | File | Function / place |
|------|------|-------------------|
| Start TCP server (port 12345) | server.js | `createTCP()` |
| Start HTTP API (port 5000) | api.js | `app.listen(5000)` |
| Lock connects, data received | server.js | `incomingData()` → `processData()` |
| Save key from lock | server.js | `processData()` → case **R0**: `client.key = params[1]` |
| You call unlock API | api.js | `POST /unlock` → `sendUnlockCommand(imei)` |
| Send unlock on TCP | server.js | `sendUnlockCommand()` → `socket.write(*BGCS,...,L0,key,...#)` |
| Request key from lock | server.js | `requestNewKey()` → `socket.write(*BGCS,...,R0,...#)` |
| Lock sends L0/L1 response | server.js | `incomingData()` → `processData()` → `handleLockResponse()` |
| Send ACK to lock | server.js | `sendAck()` → `socket.write(*BGCS,...,Re,L0#)` |
| You call lock API | api.js | `POST /lock` → `sendLockCommand(imei)` |
| Send lock on TCP | server.js | `sendLockCommand()` → `socket.write(*BGCS,...,L1,key#)` |

---

## 8. One-Line Summary

- **Unlock:** You send IMEI over HTTP → server sends **L0 + key** over TCP → lock unlocks and replies **L0,0** → server sends **ACK** over TCP.  
- **Lock:** Same, but **L1** instead of L0.  
- The **key** is always received from the lock (R0) over TCP and stored; the server then sends it with every L0/L1 command.

You can save this file as a .md or copy it into a Word doc if you need a “doc file” on your side.

# Working System Example – Lock / Unlock (Verified)

This document describes the **verified working** lock/unlock flow with real examples from the system. Use it as a reference for how the TCP server, device, and API interact.

---

## 1. Overview

| Component | Role |
|-----------|------|
| **Lock device** (IMEI e.g. 862771078243493) | Connects to server over TCP:12345, sends Q0 sign-in, H0 heartbeats, R0 key, L0/L1 responses. |
| **TCP server** (server.js) | Listens on 0.0.0.0:12345, parses `*BGCR,OM,IMEI,CMD,params#`, sends commands with **0xFFFF** prefix. |
| **HTTP API** (api.js) | POST /lock and POST /unlock with `{ "imei": "862771078243493" }`; server forwards to lock over TCP. |

**Flow:** App/Postman → `POST /unlock` or `POST /lock` → API → `sendUnlockCommand(imei)` / `sendLockCommand(imei)` → TCP to lock → Lock replies L0/L1 → Server sends **ACK** (`Re,L0#` / `Re,L1#`) → Lock completes the action.

---

## 2. Why It Works – Main Behaviours

1. **Every server command** is sent with **0xFFFF** (2 bytes HEX) before the text, then `*BGCS,OM,IMEI,CMD,...#\n`.
2. **Incoming TCP** is split by `#` so each message (e.g. H0 then L1 in one chunk) is processed separately; L0/L1 are never dropped.
3. **L0/L1 responses** are handled by **status**: 0 = success, 1 = failed, 2 = KEY invalid. For **any** status the server sends **ACK** (protocol requires it). For status 2 the server also requests a new key (R0) and stores it for the next lock/unlock.
4. **Key** is stored from R0 or from L0/L1 response params; it is sent with every L0 (unlock) and L1 (lock). If the key is wrong (status 2), the server requests a new key and the next command uses the new key.

---

## 3. Successful Unlock (L0) – Example from Logs

**API:** `POST /unlock` with `{ "imei": "862771078243493" }`.

**Server has key** (e.g. `8`). It sends:

```
0xFFFF *BGCS,OM,862771078243493,L0,8,20,1771594232#
```

- **L0** = unlock  
- **8** = operation key  
- **20** = User ID  
- **1771594232** = Unix timestamp (seconds)

**Lock replies:**

```
*BGCR,OM,862771078243493,L0,0,20,1771594232#
```

- **0** = status (success)  
- Then User ID and timestamp echo.

**Server:**

1. Parses L0, status 0.  
2. Sends ACK: `0xFFFF *BGCS,OM,862771078243493,Re,L0#`  
3. Logs: `✅ Sent ACK for L0 to 862771078243493`

Result: unlock succeeds on the machine.

---

## 4. Successful Lock (L1) – Example from Logs

**API:** `POST /lock` with `{ "imei": "862771078243493" }`.

**Server sends:**

```
0xFFFF *BGCS,OM,862771078243493,L1,8#
```

- **L1** = lock  
- **8** = operation key  

**Lock may send heartbeat first**, then L1 response (both in same TCP chunk; both are processed because we split by `#`):

```
*BGCR,OM,862771078243493,H0,0,5093,11,0,3,0,0,1#
*BGCR,OM,862771078243493,L1,0,20,1771594232,1#
```

- **L1,0** = lock success; **1** = duration (minutes).

**Server:**

1. Processes H0 (heartbeat), then L1.  
2. For L1 status 0: sends ACK `0xFFFF *BGCS,OM,862771078243493,Re,L1#`.  
3. Logs: `✅ Sent ACK for L1 to 862771078243493`

Result: lock succeeds on the machine.

---

## 5. Key Invalid (Status 2) – Auto Key Refresh

**Example:** Unlock is sent with an old or wrong key. Lock replies:

```
*BGCR,OM,862771078243493,L0,2,20,1771594332#
```

- **2** = KEY incorrect or invalid (Protocol V2.1.8).

**Server:**

1. Sends ACK: `Re,L0#` (required by protocol).  
2. Requests new key: `0xFFFF *BGCS,OM,862771078243493,R0,0,300,20,1771594333#`  
3. Logs: `⚠️ L0 for 862771078243493 – status 2 (KEY incorrect or invalid), ACK sent, requesting new key`  
4. Lock replies with new key: `*BGCR,OM,862771078243493,R0,0,134,20,1771594333#`  
5. Server stores **key = 134**.  
6. Next unlock/lock uses **134** and succeeds (e.g. L0,0 or L1,0).

So status 2 is handled automatically: ACK + R0 → new key stored → next command works.

---

## 6. Message Format Summary (Protocol V2.1.8)

| Direction | Format | Example |
|-----------|--------|---------|
| Server → Lock | `0xFFFF` + `*BGCS,OM,IMEI,CMD,params#` + `\n` | Unlock: `*BGCS,OM,862771078243493,L0,134,20,1771594407#` |
| Lock → Server | `*BGCR,OM,IMEI,CMD,params#` | Response: `*BGCR,OM,862771078243493,L0,0,20,1771594407#` |
| ACK (Server → Lock) | `0xFFFF` + `*BGCS,OM,IMEI,Re,CMD#` + `\n` | `*BGCS,OM,862771078243493,Re,L0#` |

**L0 (unlock)**  
- Server: `L0,key,userID,timestamp` (e.g. userID 20).  
- Lock: `L0,status,userID,timestamp` — status 0 success, 1 failed, 2 KEY invalid.

**L1 (lock)**  
- Server: `L1,key`.  
- Lock: `L1,status,userID,timestamp,duration` — status 0 success, 1 failed, 2 KEY invalid.

**R0 (key request)**  
- Server: `R0,0,300,20,timestamp`.  
- Lock: `R0,0,key,20,timestamp` — server stores `key`.

---

## 7. Code Locations (server.js)

| What | Function / place |
|------|-------------------|
| TCP listen, 0xFFFF prefix | `createTCP()`, `writeServerCommand()` |
| Incoming data split by `#`, each message processed | `incomingData()`, `processOneMessage()` |
| BGCR parsing (IMEI, command, params) | `BGCR_REGEX`, `processOneMessage()` |
| L0/L1 handling, ACK, status 2 → R0 | `processData()` L0/L1 case, `handleLockResponse()` |
| Send ACK | `sendAck()` |
| Send unlock | `sendUnlockCommand()` → `*BGCS,OM,imei,L0,key,20,ts#` |
| Send lock | `sendLockCommand()` → `*BGCS,OM,imei,L1,key#` |
| Request new key on status 2/3 | `requestNewKey()` → `*BGCS,OM,imei,R0,0,300,20,ts#` |
| Store key from R0 or L0/L1 params | `processData()` R0 case, L0/L1 case (`client.key = params[1]`) |

---

## 8. One-Line Summary

**Unlock:** API sends IMEI → server sends **L0 + key + 20 + timestamp** with 0xFFFF → lock replies **L0,status** → server sends **Re,L0** (ACK) → on status 0 machine unlocks; on status 2 server sends ACK, requests R0, stores new key, next unlock works.

**Lock:** API sends IMEI → server sends **L1 + key** with 0xFFFF → lock replies **L1,status** → server sends **Re,L1** (ACK) → on status 0 machine locks.

**Key:** Stored from R0 or L0/L1 response; sent with every L0/L1; if device returns status 2, server gets a new key via R0 and retries with the new key.

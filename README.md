# Quarshie Apex Switch — Signaling Server

## What this is
A small Node.js server that helps the switcher and cameras find each other
before establishing a direct WebRTC video connection.

## How to run it (Phase 2 — local network)

1. Open a terminal in the `server` folder
2. Install dependencies (first time only):
   ```
   npm install
   ```
3. Start the server:
   ```
   npm run dev
   ```
4. You should see the startup banner with the server address.

## Testing it works
Visit this URL in your browser:
```
http://localhost:3001/health
```
You should see a JSON response like:
```json
{ "status": "ok", "sessions": 0, "uptime": "5s" }
```

## Connecting a phone on the same WiFi
Find your laptop's local IP address:
- Windows: open a terminal and type `ipconfig` — look for "IPv4 Address"
- It will look like `192.168.x.x`

Then on your phone browser, visit:
```
http://192.168.x.x:5173
```
(replace with your actual IP)

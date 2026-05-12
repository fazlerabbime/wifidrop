# WiFiDrop

WiFiDrop is a lightweight local-network file transfer app. One device creates a room, another joins by code or QR scan, and files move directly over WebRTC.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` on the host device. Other devices on the same network can open the host machine address, for example `http://192.168.1.20:3000`.

## Run with LAN HTTPS

Camera QR scanning on phones requires a secure browser context. Use HTTPS for the best LAN setup.

Create a local certificate with a tool such as `mkcert`, then start WiFiDrop with:

```bash
HTTPS=1 \
SSL_KEY_PATH=/path/to/key.pem \
SSL_CERT_PATH=/path/to/cert.pem \
PORT=3000 \
npm start
```

Open `https://<your-lan-ip>:3000` on both devices. If you use a self-signed certificate, each device must trust that certificate before the camera and WebRTC flows will work reliably.

## Features

- Local QR generation, with no external QR image service.
- Camera QR scanner for joining rooms.
- WebSocket heartbeat and room cleanup.
- WebRTC data-channel status indicators.
- Streamed file sending with backpressure instead of whole-file loading.
- Transfer progress with speed and ETA.
- Memory safer receiving through browser storage when supported, with Blob fallback.

## Environment variables

- `PORT`: HTTP or HTTPS port. Defaults to `3000`.
- `HTTPS=1`: Enables HTTPS mode.
- `SSL_KEY_PATH`: Path to the HTTPS private key. Required when `HTTPS=1`.
- `SSL_CERT_PATH`: Path to the HTTPS certificate. Required when `HTTPS=1`.

# MeshTalk

A group chat that works like **Bitchat**, built for the web: there's no
central chat server holding your messages. A tiny signaling server just
introduces people in the same room to each other; after that, every
message travels **directly between browsers** over WebRTC data channels
(a full mesh — everyone connects to everyone).

The sidebar's live node graph shows the real connection state, not a
decorative chat list — solid green lines are open peer-to-peer links,
dashed amber lines are still negotiating.

## How it's like Bitchat, and how it differs

| | Bitchat | MeshTalk |
|---|---|---|
| Transport | Bluetooth LE mesh | WebRTC over the internet (or LAN) |
| Server involvement | None | Only to exchange initial connection info, then gets out of the way |
| Range | Physical proximity | Anyone with the link, anywhere |
| Message storage | Never touches a server | Never touches a server |

Browsers can't do Bluetooth mesh networking the way Bitchat's native app
does (Web Bluetooth doesn't support the mesh/relay behavior), so this
uses WebRTC as the "no middleman for messages" equivalent.

## Run it locally

Requires Node.js 18+. Rooms hold up to 20 people.

```bash
npm install
npm start
```

Open **http://localhost:8787** in a browser tab, pick a name, and either
type a room code or click **New** to generate one. Open a second tab (or
send the room link to a friend on the same network) and join the same
room — you'll see the mesh graph connect live.

## Deploy it (free) so anyone can join

MeshTalk needs a host that supports **WebSockets**, so GitHub Pages and
Netlify/Vercel static hosting will NOT work for it. Render works well:

1. Push this folder to a GitHub repo (see below).
2. On https://render.com choose **New > Web Service** and pick the repo.
3. Runtime: **Node**. Build command: `npm install`. Start command: `npm start`.
4. Instance type: **Free**. Click **Deploy**.
5. Open the `https://your-app.onrender.com` URL, join a room, and share the
   invite link.

Notes: the free plan sleeps after ~15 minutes idle, so the first visit can
take 30-50 seconds to wake up. Health check path: `/healthz`.

### Optional: TURN relay (for people on mobile data / strict Wi-Fi)

If some friends can't connect, add these environment variables on your host
and redeploy (get TURN credentials from a TURN provider):

- `TURN_URL` e.g. `turn:your-turn-host:3478` (comma-separate several)
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

The server hands them to browsers via `/ice-config`.

## Notes on limitations

- **NAT traversal**: this uses a public STUN server (Google's) to help
  peers find each other through routers. On restrictive networks
  (some corporate/school Wi-Fi with symmetric NAT), a direct connection
  can fail — a production version would add a TURN server as a relay
  fallback.
- **Mesh size**: every peer connects to every other peer directly, so
  connections grow as *n²*. This is fine for small-to-medium rooms
  (a handful to a couple dozen people); very large rooms would want a
  different topology.
- **No persistence**: like Bitchat, nothing is stored. Refreshing the
  page clears your chat log and drops your connections.

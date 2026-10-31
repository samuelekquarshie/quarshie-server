/**
 * Quarshie Apex Switch — Signaling Server
 *
 * What this server does (in plain language):
 * ------------------------------------------
 * WebRTC lets two browsers send video directly to each other, BUT before
 * that can happen they need to exchange some technical "handshake" messages.
 * This server is the middleman that passes those messages back and forth.
 * Once the two devices are connected, video flows directly between them and
 * this server is no longer involved in the video stream.
 *
 * The process (called "signaling") works like this:
 *  1. Director creates a session → server stores the session code
 *  2. Camera joins with the same code → server links them together
 *  3. Server passes "offer", "answer", and "ICE candidate" messages between them
 *  4. Devices connect directly via WebRTC — server steps aside
 */

const express    = require('express')
const http       = require('http')
const { Server } = require('socket.io')
const cors       = require('cors')

// ── Configuration ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001

// In production (Phase 3) this will be set to your deployed frontend URL.
// For Phase 2 (local), we allow all origins so laptop + phone on same WiFi works.
const ALLOWED_ORIGINS = process.env.CLIENT_URL
  ? [process.env.CLIENT_URL]
  : '*'

// ── Express app + HTTP server ──────────────────────────────────────────────
const app    = express()
const server = http.createServer(app)

app.use(cors({ origin: ALLOWED_ORIGINS }))
app.use(express.json())

// Health check endpoint — visit http://localhost:3001/health to confirm running
app.get('/health', (_req, res) => {
  res.json({
    status:   'ok',
    app:      'Quarshie Apex Switch Signaling Server',
    sessions: sessions.size,
    uptime:   Math.floor(process.uptime()) + 's',
  })
})

// ── Socket.io ──────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
})

/**
 * Session store — kept in memory (resets when server restarts).
 *
 * Shape of each session:
 * {
 *   code:      string,          // 6-char code e.g. "APX42K"
 *   director:  socketId | null, // the switcher/director socket
 *   cameras:   Map<number, socketId>  // cameraNumber → socketId
 * }
 */
const sessions = new Map()

// Helper: find which session a socket belongs to
function findSessionBySocket(socketId) {
  for (const [code, session] of sessions) {
    if (session.director === socketId) return { code, session }
    for (const [, camSocketId] of session.cameras) {
      if (camSocketId === socketId) return { code, session }
    }
  }
  return null
}

// Helper: get a safe summary of a session to send to clients
function sessionSummary(session) {
  const cameras = []
  for (const [num, socketId] of session.cameras) {
    cameras.push({ cameraNumber: num, socketId })
  }
  return {
    code:            session.code,
    directorOnline:  session.director !== null,
    cameras,
  }
}

// ── Socket event handlers ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`)

  // ── 1. Director creates a session ────────────────────────────────────────
  socket.on('create-session', ({ code }) => {
    if (!code || typeof code !== 'string' || code.length !== 6) {
      socket.emit('error-message', 'Invalid session code.')
      return
    }

    const upperCode = code.toUpperCase()

    if (sessions.has(upperCode)) {
      // Session already exists — take it over as director (handles reconnects)
      const session = sessions.get(upperCode)
      session.director = socket.id
      socket.join(upperCode)
      socket.emit('session-joined', sessionSummary(session))
      console.log(`[S] Director rejoined session ${upperCode}`)
    } else {
      // Brand new session
      const session = { code: upperCode, director: socket.id, cameras: new Map() }
      sessions.set(upperCode, session)
      socket.join(upperCode)
      socket.emit('session-joined', sessionSummary(session))
      console.log(`[S] Session created: ${upperCode}`)
    }
  })

  // ── 2. Camera joins a session ─────────────────────────────────────────────
  socket.on('join-session', ({ code, cameraNumber }) => {
    const upperCode = code?.toUpperCase()

    if (!sessions.has(upperCode)) {
      socket.emit('error-message', `Session "${upperCode}" not found. Ask the director for the correct code.`)
      return
    }

    if (typeof cameraNumber !== 'number' || cameraNumber < 1 || cameraNumber > 8) {
      socket.emit('error-message', 'Camera number must be between 1 and 8.')
      return
    }

    const session = sessions.get(upperCode)

    // Check if slot already taken by a different socket
    if (session.cameras.has(cameraNumber)) {
      const existingId = session.cameras.get(cameraNumber)
      if (existingId !== socket.id) {
        socket.emit('error-message', `Camera ${cameraNumber} is already taken in this session.`)
        return
      }
    }

    session.cameras.set(cameraNumber, socket.id)
    socket.join(upperCode)
    socket.emit('session-joined', sessionSummary(session))

    // Tell the director a new camera has connected
    if (session.director) {
      io.to(session.director).emit('camera-connected', {
        cameraNumber,
        socketId: socket.id,
      })
    }

    console.log(`[C] Camera ${cameraNumber} joined session ${upperCode}`)
  })

  // ── 3. Camera signals it is ready to stream ──────────────────────────────
  // Camera calls this after getUserMedia succeeds and stream is active.
  // Director then initiates the WebRTC offer.
  socket.on('camera-ready', ({ code, cameraNumber, ratio }) => {
    const upperCode = code?.toUpperCase()
    const session = sessions.get(upperCode)
    if (!session) return
    if (session.director) {
      io.to(session.director).emit('camera-ready', { cameraNumber, socketId: socket.id, ratio })
      console.log(`[C] Camera ${cameraNumber} ready in session ${upperCode} (${ratio || 'unknown ratio'})`)
    }
  })

  // ── 4. WebRTC signaling messages ──────────────────────────────────────────
  // These are just passed through — the server doesn't look inside them.
  // "offer" and "answer" are SDP descriptions of what video formats the
  // device supports. "ice-candidate" is network path information.

  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc-offer', {
      fromSocketId: socket.id,
      offer,
    })
  })

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc-answer', {
      fromSocketId: socket.id,
      answer,
    })
  })

  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc-ice-candidate', {
      fromSocketId: socket.id,
      candidate,
    })
  })

  // ── 4. Disconnect handling ────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`)

    const result = findSessionBySocket(socket.id)
    if (!result) return

    const { code, session } = result

    if (session.director === socket.id) {
      // Director left
      session.director = null
      io.to(code).emit('director-disconnected')
      console.log(`[S] Director left session ${code}`)
    } else {
      // A camera left — find which number it was
      for (const [num, id] of session.cameras) {
        if (id === socket.id) {
          session.cameras.delete(num)
          // Tell the director
          if (session.director) {
            io.to(session.director).emit('camera-disconnected', { cameraNumber: num })
          }
          console.log(`[C] Camera ${num} left session ${code}`)
          break
        }
      }
    }

    // Clean up empty sessions (no director and no cameras)
    if (!session.director && session.cameras.size === 0) {
      sessions.delete(code)
      console.log(`[S] Session ${code} removed (empty)`)
    }
  })
})

// ── Start server ───────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('')
  console.log('╔═══════════════════════════════════════════════════╗')
  console.log('║     Quarshie Apex Switch — Signaling Server       ║')
  console.log('╠═══════════════════════════════════════════════════╣')
  console.log(`║  Local:    http://localhost:${PORT}                  ║`)
  console.log(`║  Health:   http://localhost:${PORT}/health            ║`)
  console.log('║  Phase 2 — local network testing                  ║')
  console.log('╚═══════════════════════════════════════════════════╝')
  console.log('')
  console.log('  To connect a phone on the same WiFi, find your')
  console.log('  laptop IP address and use:')
  console.log(`  http://<your-laptop-ip>:${PORT}`)
  console.log('')
})

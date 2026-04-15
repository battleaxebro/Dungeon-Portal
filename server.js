const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/jpeg|jpg|png|gif|webp|svg/.test(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  }
});

// ─── In-memory state ──────────────────────────────────────────────────────────
// sessions: { [code]: Session }
const sessions = {};
// adminSockets: { [socketId]: code }
const adminSockets = {};

function genCode() {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); }
  while (sessions[code]);
  return code;
}

function newSession(adminSocketId) {
  const code = genCode();
  sessions[code] = {
    code,
    adminSocketId,
    adminToken: uuidv4(),
    rooms: [],
    currentRoomIndex: -1,
    infoCards: [],
    mouthVolume: 0,
    players: []
  };
  return sessions[code];
}

function publicSession(s) {
  return {
    code: s.code,
    rooms: s.rooms,
    currentRoomIndex: s.currentRoomIndex,
    currentRoom: s.currentRoomIndex >= 0 ? s.rooms[s.currentRoomIndex] : null,
    infoCards: s.infoCards.filter(c => c.visible),
    mouthVolume: s.mouthVolume || 0
  };
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadsDir));

// ─── Helpers ──────────────────────────────────────────────────────────────────
const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|svg)$/i;

function toTitleCase(str) {
  return str.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function scanAssetDir(subDir) {
  const dir = path.join(publicDir, 'assets', subDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && IMAGE_EXTS.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => ({
      id:   path.basename(e.name, path.extname(e.name)),
      name: toTitleCase(path.basename(e.name, path.extname(e.name))),
      url:  `/assets/${subDir}/${e.name}`
    }));
}

const EXPRESSIONS = ['angry', 'happy', 'sad', 'suspicious'];

// Scan sprites directory — returns flat sprites AND folder-based sprite sets.
// A sprite set is a subfolder whose default file shares the folder name:
//   sprites/knight/knight.png          → defaultUrl
//   sprites/knight/knight_angry.png    → expressions.angry
//   sprites/knight/knight_happy.png    → expressions.happy  (etc.)
function scanSpritesDir() {
  const dir = path.join(publicDir, 'assets', 'sprites');
  if (!fs.existsSync(dir)) return { sprites: [], spriteSets: [] };

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const sprites    = [];
  const spriteSets = [];

  entries.forEach(entry => {
    if (entry.isDirectory()) {
      const folderName = entry.name;
      const folderDir  = path.join(dir, folderName);
      const files = fs.readdirSync(folderDir).filter(f => IMAGE_EXTS.test(f));

      // Find the default file — same basename as the folder (case-insensitive)
      const defaultFile = files.find(f =>
        path.basename(f, path.extname(f)).toLowerCase() === folderName.toLowerCase()
      );
      if (!defaultFile) return; // folder must have a matching default file

      const set = {
        id:         folderName.toLowerCase(),
        name:       toTitleCase(folderName),
        defaultUrl: `/assets/sprites/${folderName}/${defaultFile}`,
        expressions: {}
      };

      // Find expression variants: foldername_angry.ext, etc.
      EXPRESSIONS.forEach(expr => {
        const exprFile = files.find(f =>
          path.basename(f, path.extname(f)).toLowerCase() === `${folderName.toLowerCase()}_${expr}`
        );
        if (exprFile) {
          set.expressions[expr] = `/assets/sprites/${folderName}/${exprFile}`;
        }
      });

      spriteSets.push(set);

    } else if (entry.isFile() && IMAGE_EXTS.test(entry.name)) {
      // Flat file in root sprites/ — kept for backward compatibility
      const id = path.basename(entry.name, path.extname(entry.name));
      sprites.push({ id, name: toTitleCase(id), url: `/assets/sprites/${entry.name}` });
    }
  });

  sprites.sort((a, b) => a.name.localeCompare(b.name));
  spriteSets.sort((a, b) => a.name.localeCompare(b.name));
  return { sprites, spriteSets };
}

const TIER_LABELS = ['Resting (1–10)', 'Talking (11–40)', 'Medium (41–60)', 'Loud (61+)'];

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// Auto-discover assets from disk — no manifest editing needed
app.get('/api/assets', (req, res) => {
  const { sprites, spriteSets } = scanSpritesDir();
  const backgrounds = scanAssetDir('backgrounds');

  // Group mouth files into sets by naming convention: setname_1.ext … setname_4.ext
  const mouthFiles = scanAssetDir('mouths');
  const setMap = {};
  mouthFiles.forEach(m => {
    const match = m.id.match(/^(.+)_([1-4])$/);
    if (!match) return; // skip files that don't follow the convention
    const [, prefix, tierStr] = match;
    const tier = parseInt(tierStr);
    const key = prefix.toLowerCase(); // case-insensitive grouping
    if (!setMap[key]) {
      setMap[key] = { id: key, name: toTitleCase(prefix), description: '', mouths: [] };
    }
    setMap[key].mouths.push({ tier, label: TIER_LABELS[tier - 1] || `Tier ${tier}`, url: m.url });
  });
  const mouthSets = Object.values(setMap)
    .filter(s => s.mouths.length > 0)
    .map(s => ({ ...s, mouths: s.mouths.sort((a, b) => a.tier - b.tier) }));

  res.json({ sprites, spriteSets, backgrounds, mouthSets });
});

app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
app.get('/player', (req, res) => res.sendFile(path.join(publicDir, 'player.html')));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Admin: create session ──────────────────────────────────────────────────
  socket.on('create-session', (_, cb) => {
    const session = newSession(socket.id);
    adminSockets[socket.id] = session.code;
    socket.join(session.code);
    socket.join(`admin:${session.code}`);
    console.log(`[+] Session ${session.code} created`);
    cb({ success: true, code: session.code, adminToken: session.adminToken, session });
  });

  // ── Admin: rejoin existing session ────────────────────────────────────────
  socket.on('rejoin-admin', ({ code, adminToken }, cb) => {
    const session = sessions[code];
    if (!session) return cb({ error: 'Session not found' });
    if (session.adminToken !== adminToken) return cb({ error: 'Invalid token' });
    session.adminSocketId = socket.id;
    adminSockets[socket.id] = code;
    socket.join(code);
    socket.join(`admin:${code}`);
    cb({ success: true, code, session });
  });

  // ── Admin: generate new session code ─────────────────────────────────────
  socket.on('generate-code', (cb) => {
    const oldCode = adminSockets[socket.id];
    if (!oldCode || !sessions[oldCode]) return cb({ error: 'Not authorized' });
    const session = sessions[oldCode];
    const newCode = genCode();

    // Move session to new key
    sessions[newCode] = { ...session, code: newCode };
    delete sessions[oldCode];
    adminSockets[socket.id] = newCode;

    // Move admin to new socket rooms
    socket.leave(oldCode);
    socket.leave(`admin:${oldCode}`);
    socket.join(newCode);
    socket.join(`admin:${newCode}`);

    // Tell any connected players the code changed (they must rejoin)
    io.to(oldCode).emit('session-code-changed', { newCode });

    console.log(`[~] Session code changed ${oldCode} → ${newCode}`);
    cb({ success: true, code: newCode });
  });

  // ── Player: join session ──────────────────────────────────────────────────
  socket.on('join-session', ({ code, playerName }, cb) => {
    const session = sessions[code];
    if (!session) return cb({ error: 'Room code not found' });
    session.players.push({ id: socket.id, name: playerName });
    socket.join(code);
    io.to(`admin:${code}`).emit('player-joined', { id: socket.id, name: playerName });
    cb({ success: true, session: publicSession(session) });
  });

  // ── Admin: add room ───────────────────────────────────────────────────────
  socket.on('add-room', ({ data }, cb) => {
    const code = adminSockets[socket.id];
    if (!code) return cb({ error: 'Not authorized' });
    const session = sessions[code];
    const room = {
      id: uuidv4(),
      name: data.name || `Room ${session.rooms.length + 1}`,
      backgroundUrl: data.backgroundUrl || null,
      bgFit: data.bgFit || 'cover',
      spriteUrl: data.spriteUrl || null,
      spriteAngryUrl: data.spriteAngryUrl || null,
      spriteHappyUrl: data.spriteHappyUrl || null,
      spriteSadUrl: data.spriteSadUrl || null,
      spriteSuspiciousUrl: data.spriteSuspiciousUrl || null,
      charName: data.charName || '',
      charTitle: data.charTitle || '',
      charAffiliation: data.charAffiliation || '',
      currentExpression: 'default',
      mouthUrl1: data.mouthUrl1 || null,
      mouthUrl2: data.mouthUrl2 || null,
      mouthUrl3: data.mouthUrl3 || null,
      mouthUrl4: data.mouthUrl4 || null,
      mouthPosition: data.mouthPosition || { x: 35, y: 55, w: 30, h: 15 },
      spritePosition: data.spritePosition || { x: 75, y: 80, w: 280 }
    };
    session.rooms.push(room);
    if (session.currentRoomIndex === -1) session.currentRoomIndex = 0;
    cb({ success: true, room, rooms: session.rooms });
    io.to(code).emit('rooms-updated', { rooms: session.rooms });
  });

  // ── Admin: update room ────────────────────────────────────────────────────
  socket.on('update-room', ({ roomId, data }, cb) => {
    const code = adminSockets[socket.id];
    if (!code) return cb({ error: 'Not authorized' });
    const session = sessions[code];
    const idx = session.rooms.findIndex(r => r.id === roomId);
    if (idx === -1) return cb({ error: 'Room not found' });
    session.rooms[idx] = { ...session.rooms[idx], ...data };
    cb({ success: true, room: session.rooms[idx] });
    io.to(code).emit('rooms-updated', { rooms: session.rooms });
    if (session.currentRoomIndex === idx) {
      io.to(code).emit('room-switched', { roomIndex: idx, room: session.rooms[idx] });
    }
  });

  // ── Admin: delete room ────────────────────────────────────────────────────
  socket.on('delete-room', ({ roomId }, cb) => {
    const code = adminSockets[socket.id];
    if (!code) return cb({ error: 'Not authorized' });
    const session = sessions[code];
    const idx = session.rooms.findIndex(r => r.id === roomId);
    if (idx === -1) return cb({ error: 'Room not found' });
    session.rooms.splice(idx, 1);
    if (session.currentRoomIndex >= session.rooms.length) {
      session.currentRoomIndex = session.rooms.length - 1;
    }
    cb({ success: true });
    io.to(code).emit('rooms-updated', { rooms: session.rooms });
    if (session.rooms.length > 0) {
      io.to(code).emit('room-switched', {
        roomIndex: session.currentRoomIndex,
        room: session.rooms[session.currentRoomIndex]
      });
    } else {
      io.to(code).emit('room-cleared');
    }
  });

  // ── Admin: switch room ────────────────────────────────────────────────────
  socket.on('switch-room', ({ roomIndex }, cb) => {
    const code = adminSockets[socket.id];
    if (!code) return cb({ error: 'Not authorized' });
    const session = sessions[code];
    if (roomIndex < 0 || roomIndex >= session.rooms.length) return cb({ error: 'Invalid index' });
    session.currentRoomIndex = roomIndex;
    const room = session.rooms[roomIndex];
    cb({ success: true });
    io.to(code).emit('room-switched', { roomIndex, room });
  });

  // ── Admin: add info card ──────────────────────────────────────────────────
  socket.on('add-info-card', ({ data }, cb) => {
    const code = adminSockets[socket.id];
    if (!code) return cb({ error: 'Not authorized' });
    const session = sessions[code];
    const card = {
      id: uuidv4(),
      title: data.title || 'Info',
      content: data.content || '',
      visible: false,
      position: data.position || { x: 5, y: 5 },
      style: data.style || 'parchment',
      fontSize: data.fontSize || '1rem'
    };
    session.infoCards.push(card);
    cb({ success: true, card });
    socket.emit('info-cards-updated', { cards: session.infoCards });
  });

  // ── Admin: update info card ───────────────────────────────────────────────
  socket.on('update-info-card', ({ cardId, data }, cb) => {
    const code = adminSockets[socket.id];
    if (!code) return cb({ error: 'Not authorized' });
    const session = sessions[code];
    const idx = session.infoCards.findIndex(c => c.id === cardId);
    if (idx === -1) return cb({ error: 'Card not found' });
    session.infoCards[idx] = { ...session.infoCards[idx], ...data };
    cb({ success: true, card: session.infoCards[idx] });
    socket.emit('info-cards-updated', { cards: session.infoCards });
    if (session.infoCards[idx].visible) {
      io.to(code).emit('info-card-update', { card: session.infoCards[idx] });
    }
  });

  // ── Admin: delete info card ───────────────────────────────────────────────
  socket.on('delete-info-card', ({ cardId }, cb) => {
    const code = adminSockets[socket.id];
    if (!code) return cb({ error: 'Not authorized' });
    const session = sessions[code];
    const idx = session.infoCards.findIndex(c => c.id === cardId);
    if (idx === -1) return cb({ error: 'Card not found' });
    const wasVisible = session.infoCards[idx].visible;
    session.infoCards.splice(idx, 1);
    cb({ success: true });
    socket.emit('info-cards-updated', { cards: session.infoCards });
    if (wasVisible) io.to(code).emit('info-card-removed', { cardId });
  });

  // ── Admin: toggle info card ───────────────────────────────────────────────
  socket.on('toggle-info-card', ({ cardId, visible }, cb) => {
    const code = adminSockets[socket.id];
    if (!code) return cb({ error: 'Not authorized' });
    const session = sessions[code];
    const card = session.infoCards.find(c => c.id === cardId);
    if (!card) return cb({ error: 'Card not found' });
    card.visible = visible !== undefined ? visible : !card.visible;
    cb({ success: true, card });
    socket.emit('info-cards-updated', { cards: session.infoCards });
    if (card.visible) {
      io.to(code).emit('info-card-update', { card });
    } else {
      io.to(code).emit('info-card-removed', { cardId });
    }
  });

  // ── Admin: set character expression ──────────────────────────────────────
  socket.on('set-expression', ({ expression }, cb) => {
    const code = adminSockets[socket.id];
    if (!code || !sessions[code]) return cb && cb({ error: 'Not authorized' });
    const session = sessions[code];
    const idx = session.currentRoomIndex;
    if (idx >= 0 && session.rooms[idx]) {
      session.rooms[idx].currentExpression = expression;
    }
    socket.to(code).emit('expression-changed', { expression });
    if (cb) cb({ success: true });
  });

  // ── Admin: mouth sync (raw volume integer) ────────────────────────────────
  socket.on('mouth-sync', ({ volume }) => {
    const code = adminSockets[socket.id];
    if (!code || !sessions[code]) return;
    sessions[code].mouthVolume = volume;
    socket.to(code).emit('mouth-sync', { volume });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = adminSockets[socket.id];
    if (code) {
      console.log(`[-] Admin disconnected from session ${code}`);
      delete adminSockets[socket.id];
      io.to(code).emit('admin-disconnected');
    } else {
      for (const [code, session] of Object.entries(sessions)) {
        const idx = session.players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
          const player = session.players[idx];
          session.players.splice(idx, 1);
          io.to(`admin:${code}`).emit('player-left', { id: socket.id, name: player.name });
          break;
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🎲 Dungeon Portal running at http://localhost:${PORT}`);
  console.log(`   Admin page:  http://localhost:${PORT}/admin`);
  console.log(`   Player page: http://localhost:${PORT}/player\n`);
});

import http from "http";
import { WebSocketServer } from "ws";
import url from "url";
import crypto from "crypto";

const PORT = process.env.PORT || 10000;
const RELAY_PASSWORD = process.env.RELAY_PASSWORD || ""; // optional global password

// HTTP ping (so Render health checks succeed)
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("MIDImyFACE relay running\n");
});

// session registry
// sessionId → { clients:Set<ws>, director:ws|null, participants:Map<id,{id,name,connected}> }
const sessions = new Map();
const wss = new WebSocketServer({ noServer: true });

function json(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}
function broadcast(session, obj) {
  session.clients.forEach(c => { if (c.readyState === 1) json(c, obj); });
}
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { clients:new Set(), director:null, participants:new Map() });
  return sessions.get(id);
}
function assignDirector(session) {
  if (!session.director) {
    const first = [...session.clients][0] || null;
    session.director = first;
    if (first) json(first, { type:"role", role:"director" });
  }
}
function presenceMsg(sid, session) {
  return { type:"presence", sessionId:sid,
    participants: Array.from(session.participants.values())
  };
}

function join(ws, data, query) {
  const sid = data.session_id || data.sessionId || query.session || "default";
  const name = data.name || "Performer";
  const role = (data.role === "director" || data.role === "host") ? "director" : "performer";
  const pwd = data.password || "";
  const client_uuid = data.client_uuid || null;

  if (RELAY_PASSWORD && pwd !== RELAY_PASSWORD) {
    try { ws.close(1008, "bad password"); } catch {}
    return;
  }

  const session = getSession(sid);
  session.clients.add(ws);
  ws._id = crypto.randomUUID();
  ws._sid = sid;
  ws._name = name;
  ws._role = role;
  ws._client_uuid = client_uuid;

  session.participants.set(ws._id, { id: ws._id, name, connected: true });

  if (role === "director") {
    session.director = ws;
    json(ws, { type: "role", role: "director" });
  } else {
    assignDirector(session);
    if (session.director !== ws) json(ws, { type: "role", role: "performer" });
  }

  broadcast(session, presenceMsg(sid, session));
}


function relayTelemetry(ws, data) {
  const sid = ws._sid;
  const session = sessions.get(sid);
  if (!session) return;
  const from = ws._id;
  const name = ws._name;

  const msg = { type: "telemetry", from, name };

  if (data.note) {
    const n = data.note;
    msg.note = {
      on: !!n.on, note: +n.note || 0, vel: +n.vel || 0, chIn: n.chIn ? +n.chIn : undefined
    };
  }
  if (data.cc) {
    const c = data.cc;
    msg.cc = {
      channel: +c.channel || 1, cc: +c.cc || 11, value: +c.value || 0
    };
  }

  session.clients.forEach(c => { if (c.readyState === 1) json(c, msg); });
}

function relayEvent(ws, type, data) {
  const sid = ws._sid;
  const session = sessions.get(sid);
  if (!session) return;
  const from = ws._id;
  const name = ws._name;
  const payload = { type, from, name, data, tServer: Date.now() };
  session.clients.forEach(c => { if (c.readyState === 1) json(c, payload); });
}

function close(ws) {
  const sid = ws._sid;
  const session = sessions.get(sid);
  if (!session) return;
  session.clients.delete(ws);
  const part = session.participants.get(ws._id);
  if (part) part.connected = false;

  if (session.director === ws) {
    session.director = null;
    assignDirector(session);
  }
  broadcast(session, presenceMsg(sid, session));
  if (session.clients.size === 0) sessions.delete(sid);
}

// heartbeat
function startHeartbeat(ws) {
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);
}
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 15000);

// upgrade handler
server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== "/ws" && pathname !== "/" && pathname !== "/midimyface") {
    socket.destroy(); return;
  }
  
  wss.handleUpgrade(req, socket, head, ws => {
    startHeartbeat(ws);
    ws.on("message", raw => {
      let msg=null; try{ msg=JSON.parse(raw.toString()); }catch{return;}
      if (!msg || typeof msg!=="object") return;
      switch (msg.type) {
        case "join": join(ws, msg, query); break;
        case "telemetry": relayTelemetry(ws, msg); break;
      
        // New pass-throughs from the client UI
        case "midi/cc":
        case "midi/note_on":
        case "midi/note_off":
        case "gesture/update":
        case "percussion/trigger":
        case "envelope/update":
        case "mode/change":
          relayEvent(ws, msg.type, msg.data || {}); break;
      
        case "system/ping":
        case "ping":
          json(ws, { type: msg.type === "ping" ? "pong" : "system/pong", tServer: Date.now() }); break;
      
        default: break;
      }      
    });
    ws.on("close", ()=> close(ws));
  });
});

server.listen(PORT, () => console.log("MIDImyFACE relay listening on", PORT));

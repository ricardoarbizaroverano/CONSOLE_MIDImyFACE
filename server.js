import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const MIDIMYFACE_JOIN_URL = process.env.MIDIMYFACE_JOIN_URL || "http://localhost:5500";
const RELAY_JOIN_TOKEN_SECRET = process.env.RELAY_JOIN_TOKEN_SECRET || "dev-relay-secret-change-me";
const INVITE_TOKEN_SECRET = process.env.INVITE_TOKEN_SECRET || "dev-invite-secret-change-me";
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "dev-auth-secret-change-me";
const API_CORS_ORIGINS = (process.env.API_CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_ADMIN_USERNAME = process.env.TEST_ADMIN_USERNAME || "admin";
const DEFAULT_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "changeme123";
const DEFAULT_ADMIN_MAX_PARTICIPANTS = Number(process.env.TEST_ADMIN_MAX_PARTICIPANTS || 50);

const users = new Map();
const sessions = new Map();

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randomId(size = 12) {
  return crypto.randomBytes(size).toString("base64url");
}

function randomSessionId() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function randomPassword() {
  return crypto.randomBytes(6).toString("base64url").slice(0, 10);
}

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function signToken(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = b64urlJson(header);
  const encodedPayload = b64urlJson(payload);
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  if (signature !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (payload.exp && nowSec() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function createRelayJoinToken({ sessionId, role, name, maxParticipants, clientUuid }) {
  return signToken(
    {
      type: "relay_join",
      sid: sessionId,
      role,
      name,
      maxp: maxParticipants,
      client_uuid: clientUuid || null,
      iat: nowSec(),
      exp: nowSec() + 60 * 30,
      jti: randomId(8),
    },
    RELAY_JOIN_TOKEN_SECRET
  );
}

function createInviteToken({ sessionId, maxParticipants }) {
  return signToken(
    {
      type: "invite",
      sid: sessionId,
      maxp: maxParticipants,
      iat: nowSec(),
      exp: nowSec() + 60 * 60 * 24,
      jti: randomId(8),
    },
    INVITE_TOKEN_SECRET
  );
}

function createAuthToken({ username }) {
  return signToken(
    {
      type: "host_auth",
      sub: username,
      iat: nowSec(),
      exp: nowSec() + 60 * 60 * 12,
      jti: randomId(8),
    },
    AUTH_TOKEN_SECRET
  );
}

function ensureDefaultAdmin() {
  if (users.has(DEFAULT_ADMIN_USERNAME)) return;
  users.set(DEFAULT_ADMIN_USERNAME, {
    username: DEFAULT_ADMIN_USERNAME,
    passwordHash: sha256(DEFAULT_ADMIN_PASSWORD),
    tierMaxParticipants: DEFAULT_ADMIN_MAX_PARTICIPANTS,
    isAdmin: true,
  });
}

ensureDefaultAdmin();

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function corsHeaders(origin) {
  if (API_CORS_ORIGINS.includes("*")) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      Vary: "Origin",
    };
  }
  if (origin && API_CORS_ORIGINS.some((allowed) => origin.startsWith(allowed))) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      Vary: "Origin",
    };
  }
  return {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

function parseAuthUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = verifyToken(token, AUTH_TOKEN_SECRET);
  if (!payload || payload.type !== "host_auth" || !payload.sub) return null;
  return users.get(payload.sub) || null;
}

function serveIndex(res) {
  const htmlPath = path.join(__dirname, "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const origin = req.headers.origin || "";
  const isApi = reqUrl.pathname.startsWith("/api/");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (reqUrl.pathname === "/health") {
    sendJson(
      res,
      200,
      {
        ok: true,
        service: "midimyface-console-phase1",
        sessions: sessions.size,
      },
      cors
    );
    return;
  }

  if (req.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/join")) {
    serveIndex(res);
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/auth/login") {
    try {
      const body = await readJsonBody(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const user = users.get(username);
      if (!user || user.passwordHash !== sha256(password)) {
        sendJson(res, 401, { ok: false, error: "invalid_credentials" }, cors);
        return;
      }
      const token = createAuthToken({ username });
      sendJson(
        res,
        200,
        {
          ok: true,
          token,
          user: {
            username: user.username,
            tierMaxParticipants: user.tierMaxParticipants,
            isAdmin: user.isAdmin,
          },
        },
        cors
      );
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid_json" }, cors);
    }
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/sessions/create") {
    const authUser = parseAuthUser(req);
    if (!authUser) {
      sendJson(res, 401, { ok: false, error: "unauthorized" }, cors);
      return;
    }

    try {
      const body = await readJsonBody(req);
      const requestedMax = Number(body.max_participants || 10);
      const maxParticipants = Math.max(1, Math.min(requestedMax, authUser.tierMaxParticipants));
      const sessionId = randomSessionId();
      const sessionPassword = String(body.session_password || "").trim() || randomPassword();

      sessions.set(sessionId, {
        sessionId,
        passwordHash: sha256(sessionPassword),
        maxParticipants,
        createdBy: authUser.username,
        createdAt: Date.now(),
      });

      const inviteToken = createInviteToken({ sessionId, maxParticipants });
      const hostJoinToken = createRelayJoinToken({
        sessionId,
        role: "host",
        name: `Host:${authUser.username}`,
        maxParticipants,
      });

      const inviteUrl = `${MIDIMYFACE_JOIN_URL}?session_id=${encodeURIComponent(sessionId)}&invite_token=${encodeURIComponent(inviteToken)}&console_api=${encodeURIComponent(PUBLIC_BASE_URL)}`;

      sendJson(
        res,
        200,
        {
          ok: true,
          session: {
            session_id: sessionId,
            session_password: sessionPassword,
            max_participants: maxParticipants,
            invite_token: inviteToken,
            invite_url: inviteUrl,
            host_join_token: hostJoinToken,
          },
        },
        cors
      );
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid_json" }, cors);
    }
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/sessions/join-token") {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || "").trim().slice(0, 40);
      const clientUuid = String(body.client_uuid || "").trim() || null;
      const inviteToken = String(body.invite_token || "").trim();
      let sessionId = String(body.session_id || "").trim();

      if (!name) {
        sendJson(res, 400, { ok: false, error: "missing_name" }, cors);
        return;
      }

      if (inviteToken) {
        const invitePayload = verifyToken(inviteToken, INVITE_TOKEN_SECRET);
        if (!invitePayload || invitePayload.type !== "invite" || !invitePayload.sid) {
          sendJson(res, 401, { ok: false, error: "invalid_invite" }, cors);
          return;
        }
        sessionId = invitePayload.sid;
      }

      if (!sessionId || !sessions.has(sessionId)) {
        sendJson(res, 404, { ok: false, error: "session_not_found" }, cors);
        return;
      }

      const session = sessions.get(sessionId);
      if (!inviteToken) {
        const password = String(body.password || "");
        if (sha256(password) !== session.passwordHash) {
          sendJson(res, 401, { ok: false, error: "bad_session_password" }, cors);
          return;
        }
      }

      const joinToken = createRelayJoinToken({
        sessionId,
        role: "performer",
        name,
        maxParticipants: session.maxParticipants,
        clientUuid,
      });

      sendJson(
        res,
        200,
        {
          ok: true,
          join_token: joinToken,
          session_id: sessionId,
          max_participants: session.maxParticipants,
        },
        cors
      );
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid_json" }, cors);
    }
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/sessions/host-join-token") {
    const authUser = parseAuthUser(req);
    if (!authUser) {
      sendJson(res, 401, { ok: false, error: "unauthorized" }, cors);
      return;
    }
    try {
      const body = await readJsonBody(req);
      const sessionId = String(body.session_id || "").trim();
      const session = sessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, { ok: false, error: "session_not_found" }, cors);
        return;
      }
      if (session.createdBy !== authUser.username && !authUser.isAdmin) {
        sendJson(res, 403, { ok: false, error: "forbidden" }, cors);
        return;
      }
      const hostJoinToken = createRelayJoinToken({
        sessionId,
        role: "host",
        name: `Host:${authUser.username}`,
        maxParticipants: session.maxParticipants,
      });
      sendJson(res, 200, { ok: true, host_join_token: hostJoinToken }, cors);
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid_json" }, cors);
    }
    return;
  }

  if (isApi) {
    sendJson(res, 404, { ok: false, error: "not_found" }, cors);
    return;
  }

  sendText(res, 404, "Not Found");
});

server.listen(PORT, () => {
  console.log(`[console] listening on :${PORT}`);
  console.log(`[console] default admin: ${DEFAULT_ADMIN_USERNAME}`);
  if (DEFAULT_ADMIN_PASSWORD === "changeme123") {
    console.warn("[console] WARNING: using default TEST_ADMIN_PASSWORD, change it in env");
  }
});

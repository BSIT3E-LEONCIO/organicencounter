require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const NODE_ENV = process.env.NODE_ENV || "development";
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY || "1";

const INTEREST_FALLBACK_MS = 20_000;
const MAX_INTERESTS = 5;
const MAX_INTEREST_LENGTH = 32;
const START_DEDUP_MS = 1200;
const MAX_MESSAGE_LENGTH = 500;
const MESSAGE_WINDOW_MS = 5_000;
const MAX_MESSAGES_PER_WINDOW = 15;

const SOCKET_EVENT_WINDOW_MS = 10_000;
const MAX_STARTS_PER_WINDOW = 8;
const MAX_NEXTS_PER_WINDOW = 8;
const MAX_STOPS_PER_WINDOW = 10;

const ABUSE_STRIKE_WINDOW_MS = 10 * 60 * 1000;
const ABUSE_STRIKE_THRESHOLD = 5;
const ABUSE_BLOCK_MS = 15 * 60 * 1000;

const URL_REGEX = /(https?:\/\/|www\.)\S+/i;
const BANNED_WORDS = ["fuck", "shit", "bitch", "asshole", "motherfucker", "nigga", "faggot"];

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return CLIENT_ORIGINS.includes("*") || CLIENT_ORIGINS.includes(origin);
}

function corsOriginValidator(origin, callback) {
  if (isAllowedOrigin(origin)) return callback(null, true);
  return callback(new Error("Not allowed by CORS"));
}

const app = express();
app.set("trust proxy", TRUST_PROXY);
app.disable("x-powered-by");

app.use(helmet());
app.use(express.json({ limit: "8kb" }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: NODE_ENV === "production" ? 200 : 1000,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use(
  cors({
    origin: corsOriginValidator,
    methods: ["GET", "POST"],
    credentials: true,
  }),
);

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024,
  cors: {
    origin: corsOriginValidator,
    methods: ["GET", "POST"],
    credentials: true,
  },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      return callback("Not allowed by CORS", false);
    }
    return callback(null, true);
  },
});
app.get("/health", (_req, res) => res.json({ ok: true }));

const waitingQueue = []; // string[]  socket IDs
const partners = new Map(); // socketId  → socketId
const userInterests = new Map(); // socketId  → string[]
const queuedAt = new Map(); // socketId  → timestamp
const activeSeekers = new Set(); // socketIds that explicitly requested matchmaking
const lastStartAt = new Map(); // socketId  → timestamp

const socketMessageWindow = new Map(); // socketId -> { count, windowStartedAt }
const socketEventWindow = new Map(); // socketId -> { [event]: { count, windowStartedAt } }
const ipAbuseState = new Map(); // ip -> { strikes, windowStartedAt, blockedUntil }

const getSocket = (id) => io.sockets.sockets.get(id);

function getIpAddress(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const firstForwarded = typeof forwarded === "string" ? forwarded.split(",")[0] : "";
  return (firstForwarded || socket.handshake.address || "unknown").trim();
}

function isIpBlocked(ip) {
  const state = ipAbuseState.get(ip);
  if (!state) return false;
  if (Date.now() >= state.blockedUntil) {
    ipAbuseState.delete(ip);
    return false;
  }
  return true;
}

function recordIpAbuse(ip) {
  const now = Date.now();
  const state = ipAbuseState.get(ip);
  if (!state || now - state.windowStartedAt > ABUSE_STRIKE_WINDOW_MS) {
    ipAbuseState.set(ip, {
      strikes: 1,
      windowStartedAt: now,
      blockedUntil: 0,
    });
    return;
  }

  state.strikes += 1;
  if (state.strikes >= ABUSE_STRIKE_THRESHOLD) {
    state.blockedUntil = now + ABUSE_BLOCK_MS;
  }
}

function isSocketEventRateLimited(socketId, eventName, maxAllowed) {
  const now = Date.now();
  const perSocket = socketEventWindow.get(socketId) || {};
  const current = perSocket[eventName];

  if (!current || now - current.windowStartedAt > SOCKET_EVENT_WINDOW_MS) {
    perSocket[eventName] = { count: 1, windowStartedAt: now };
    socketEventWindow.set(socketId, perSocket);
    return false;
  }

  current.count += 1;
  return current.count > maxAllowed;
}

function containsBlockedContent(message) {
  if (URL_REGEX.test(message)) return true;
  return false;
}

function maskProfanity(text) {
  let masked = text;
  for (const word of BANNED_WORDS) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "gi");
    masked = masked.replace(regex, "***");
  }
  return masked;
}

function sanitizeMessage(input) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const compacted = trimmed.replace(/\s+/g, " ").slice(0, MAX_MESSAGE_LENGTH);
  if (containsBlockedContent(compacted)) return "";
  return maskProfanity(compacted);
}

function isMessageRateLimited(socketId) {
  const now = Date.now();
  const current = socketMessageWindow.get(socketId);

  if (!current || now - current.windowStartedAt > MESSAGE_WINDOW_MS) {
    socketMessageWindow.set(socketId, { count: 1, windowStartedAt: now });
    return false;
  }

  current.count += 1;
  if (current.count > MAX_MESSAGES_PER_WINDOW) return true;
  return false;
}

function removeFromQueue(id) {
  // Remove all occurrences defensively to avoid stale duplicate entries.
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (waitingQueue[i] === id) waitingQueue.splice(i, 1);
  }
  queuedAt.delete(id);
}

function isSeekEligible(id) {
  return activeSeekers.has(id) && !partners.has(id);
}

function commonInterests(a, b) {
  return [...new Set(a.filter((i) => b.includes(i)))];
}

function normalizeInterests(interests = []) {
  if (!Array.isArray(interests)) return [];

  return [
    ...new Set(
      interests
        .filter((interest) => typeof interest === "string")
        .map((interest) => interest.toLowerCase().trim())
        .filter(
          (interest) =>
            interest.length > 0 && interest.length <= MAX_INTEREST_LENGTH,
        ),
    ),
  ].slice(0, MAX_INTERESTS);
}

function parseStartPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  return normalizeInterests(payload.interests);
}

function hasWaitedLongEnough(id) {
  const joinedAt = queuedAt.get(id);
  return (
    typeof joinedAt === "number" &&
    Date.now() - joinedAt >= INTEREST_FALLBACK_MS
  );
}

function getInterests(id) {
  return userInterests.get(id) || [];
}

function canFallbackPair(aId, bId) {
  const aInterests = getInterests(aId);
  const bInterests = getInterests(bId);

  // Interests are optional: if either user has no interests, they can fallback-match.
  if (aInterests.length === 0 || bInterests.length === 0) return true;

  // If both declared interests but do not overlap, allow fallback only after waiting.
  return hasWaitedLongEnough(aId) || hasWaitedLongEnough(bId);
}

function compactQueue() {
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    const id = waitingQueue[i];
    const socket = getSocket(id);
    if (!socket?.connected || !isSeekEligible(id)) {
      waitingQueue.splice(i, 1);
      queuedAt.delete(id);
    }
  }
}

function tryMatchQueueOnce() {
  compactQueue();
  if (waitingQueue.length < 2) return false;

  // Pass 1: prioritize users with shared interests.
  for (let i = 0; i < waitingQueue.length; i++) {
    const aId = waitingQueue[i];
    const aSocket = getSocket(aId);
    if (!aSocket?.connected || !isSeekEligible(aId)) continue;

    for (let j = i + 1; j < waitingQueue.length; j++) {
      const bId = waitingQueue[j];
      const bSocket = getSocket(bId);
      if (!bSocket?.connected || !isSeekEligible(bId)) continue;

      if (commonInterests(getInterests(aId), getInterests(bId)).length > 0) {
        pairUsers(aSocket, bSocket);
        return true;
      }
    }
  }

  // Pass 2: fallback matching for optional-interest behavior.
  for (let i = 0; i < waitingQueue.length; i++) {
    const aId = waitingQueue[i];
    const aSocket = getSocket(aId);
    if (!aSocket?.connected || !isSeekEligible(aId)) continue;

    for (let j = i + 1; j < waitingQueue.length; j++) {
      const bId = waitingQueue[j];
      const bSocket = getSocket(bId);
      if (!bSocket?.connected || !isSeekEligible(bId)) continue;

      if (canFallbackPair(aId, bId)) {
        pairUsers(aSocket, bSocket);
        return true;
      }
    }
  }

  return false;
}

function drainQueueMatches() {
  while (tryMatchQueueOnce()) {
    // Keep matching until no eligible pairs remain.
  }
}

function pairUsers(first, second) {
  // Defensive cleanup in case stale queue entries still exist.
  removeFromQueue(first.id);
  removeFromQueue(second.id);

  // Paired users are no longer actively seeking until they explicitly request it again.
  activeSeekers.delete(first.id);
  activeSeekers.delete(second.id);

  partners.set(first.id, second.id);
  partners.set(second.id, first.id);
  const ci = commonInterests(
    userInterests.get(first.id) || [],
    userInterests.get(second.id) || [],
  );
  first.emit("matched", { commonInterests: ci });
  second.emit("matched", { commonInterests: ci });
}

function joinQueue(socket, interests = []) {
  removeFromQueue(socket.id);

  // Never enqueue/match users unless they explicitly initiated search.
  if (!isSeekEligible(socket.id)) return;

  const normalized = normalizeInterests(interests);
  userInterests.set(socket.id, normalized);

  // Add to queue and run the matcher.
  waitingQueue.push(socket.id);
  queuedAt.set(socket.id, Date.now());
  drainQueueMatches();
}

function unpair(socket, options = {}) {
  const { notifyPartner = false, requeuePartner = false } = options;
  const partnerId = partners.get(socket.id);
  if (!partnerId) return;

  partners.delete(socket.id);
  partners.delete(partnerId);

  const partnerSocket = getSocket(partnerId);
  if (!partnerSocket?.connected) return;

  if (notifyPartner) {
    // Partner must explicitly choose "Find Match" again.
    activeSeekers.delete(partnerId);
    removeFromQueue(partnerId);
    partnerSocket.emit("partnerLeft");
  }
  if (requeuePartner)
    joinQueue(partnerSocket, userInterests.get(partnerId) || []);
}

io.on("connection", (socket) => {
  const ip = getIpAddress(socket);
  if (isIpBlocked(ip)) {
    socket.emit("security:block", { reason: "Too many abuse attempts. Try again later." });
    socket.disconnect(true);
    return;
  }

  // Do NOT auto-join — wait for explicit "start" from the landing page

  socket.on("start", (payload) => {
    if (isSocketEventRateLimited(socket.id, "start", MAX_STARTS_PER_WINDOW)) {
      recordIpAbuse(ip);
      return;
    }

    const interests = parseStartPayload(payload);
    const now = Date.now();

    // Guard 1: ignore accidental duplicate starts (double-click / strict-mode effects).
    const previousStart = lastStartAt.get(socket.id) || 0;
    if (now - previousStart < START_DEDUP_MS) return;
    lastStartAt.set(socket.id, now);

    // Guard 2: never let a start event tear down an already active connection.
    // The proper flow is End Chat -> Find Match.
    if (partners.has(socket.id)) return;

    // Guard 3: if user is already queued with same interests, ignore duplicate start.
    const alreadyQueued = waitingQueue.includes(socket.id);
    const sameInterests =
      JSON.stringify(getInterests(socket.id)) === JSON.stringify(interests);
    if (alreadyQueued && sameInterests && isSeekEligible(socket.id)) return;

    activeSeekers.add(socket.id);
    removeFromQueue(socket.id);
    joinQueue(socket, interests);
  });

  socket.on("message", (text) => {
    if (typeof text !== "string") return;
    if (isSocketEventRateLimited(socket.id, "message", MAX_MESSAGES_PER_WINDOW)) {
      recordIpAbuse(ip);
      return;
    }
    if (isMessageRateLimited(socket.id)) return;
    const message = sanitizeMessage(text);
    if (!message) return;
    const partnerSocket = getSocket(partners.get(socket.id));
    if (partnerSocket?.connected) partnerSocket.emit("message", message);
  });

  socket.on("typing", () => {
    const partnerSocket = getSocket(partners.get(socket.id));
    if (partnerSocket?.connected) partnerSocket.emit("typing");
  });

  socket.on("stopTyping", () => {
    const partnerSocket = getSocket(partners.get(socket.id));
    if (partnerSocket?.connected) partnerSocket.emit("stopTyping");
  });

  socket.on("next", () => {
    if (isSocketEventRateLimited(socket.id, "next", MAX_NEXTS_PER_WINDOW)) {
      recordIpAbuse(ip);
      return;
    }

    const interests = userInterests.get(socket.id) || [];
    activeSeekers.add(socket.id);
    removeFromQueue(socket.id);
    unpair(socket, { notifyPartner: true, requeuePartner: false });
    joinQueue(socket, interests);
  });

  socket.on("stop", () => {
    if (isSocketEventRateLimited(socket.id, "stop", MAX_STOPS_PER_WINDOW)) {
      recordIpAbuse(ip);
      return;
    }

    activeSeekers.delete(socket.id);
    removeFromQueue(socket.id);
    unpair(socket, { notifyPartner: true, requeuePartner: false });
    userInterests.delete(socket.id);
  });

  socket.on("disconnect", () => {
    activeSeekers.delete(socket.id);
    lastStartAt.delete(socket.id);
    socketMessageWindow.delete(socket.id);
    socketEventWindow.delete(socket.id);
    removeFromQueue(socket.id);
    unpair(socket, { notifyPartner: true, requeuePartner: false });
    userInterests.delete(socket.id);
  });
});

// Periodically retry queue matching so waiting users can fallback-match over time
// even when no new user joins right away.
setInterval(drainQueueMatches, 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Random Chat server running on http://localhost:${PORT}`);
});

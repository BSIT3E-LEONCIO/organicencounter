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
const BOT_FALLBACK_WAIT_MIN_MS = 3_000;
const BOT_FALLBACK_WAIT_MAX_MS = 5_000;
const BOT_OPENING_REPLY_MIN_MS = 2_400;
const BOT_OPENING_REPLY_MAX_MS = 4_200;
const BOT_FOLLOW_UP_BASE_MS = 1_800;
const BOT_FOLLOW_UP_MAX_MS = 5_500;
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
const BANNED_WORDS = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "motherfucker",
  "nigga",
  "faggot",
];

const BOT_PERSONAS = [
  {
    id: "f20manila",
    name: "Stranger",
    topics: [],
    opener: "F20Manila",
    prompts: ["wyd here?", "you new here?", "so how's life?"],
  },
  {
    id: "f21manila",
    name: "Stranger",
    topics: [],
    opener: "F21 QC",
    prompts: ["wyd here?", "you new here?", "so how's life?"],
  },
  {
    id: "f18manila",
    name: "Stranger",
    topics: [],
    opener: "F18",
    prompts: ["wyd here?", "you new here?", "so how's life?"],
  },
  {
    id: "f19manila",
    name: "Stranger",
    topics: [],
    opener: "F19",
    prompts: ["wyd here?", "you new here?", "so how's life?"],
  },
  {
    id: "f25manila",
    name: "Stranger",
    topics: [],
    opener: "F25 Caloocan",
    prompts: ["wyd here?", "you new here?", "so how's life?"],
  },
  {
    id: "f24manila",
    name: "Stranger",
    topics: [],
    opener: "F24 Bulacan",
    prompts: ["wyd here?", "you new here?", "so how's life?"],
  },
  {
    id: "f20manila",
    name: "Stranger",
    topics: [],
    opener: "F20 Taguig",
    prompts: ["wyd here?", "you new here?", "so how's life?"],
  },
];

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
const botFallbackTimers = new Map(); // socketId -> timeout
const botSessions = new Map(); // socketId -> { persona, replyTimer, typingTimer, turnCount, lastTopic, recentReplies, recentPromptTypes, userFacts, lastUserMessage }

const socketMessageWindow = new Map(); // socketId -> { count, windowStartedAt }
const socketEventWindow = new Map(); // socketId -> { [event]: { count, windowStartedAt } }
const ipAbuseState = new Map(); // ip -> { strikes, windowStartedAt, blockedUntil }

const getSocket = (id) => io.sockets.sockets.get(id);

function getIpAddress(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const firstForwarded =
    typeof forwarded === "string" ? forwarded.split(",")[0] : "";
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

function clearBotFallback(socketId) {
  const timer = botFallbackTimers.get(socketId);
  if (timer) clearTimeout(timer);
  botFallbackTimers.delete(socketId);
}

function stopBotConversation(socketId) {
  clearBotFallback(socketId);
  const session = botSessions.get(socketId);
  if (!session) return;

  if (session.replyTimer) clearTimeout(session.replyTimer);
  if (session.typingTimer) clearTimeout(session.typingTimer);

  const socket = getSocket(socketId);
  if (socket?.connected) socket.emit("stopTyping");

  botSessions.delete(socketId);
}

function randomFrom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function pickBotPersona() {
  return randomFrom(BOT_PERSONAS);
}

function isBotSocialRequest(text) {
  return /\b(insta|instagram|ig|telegram|tg|snap|snapchat|discord|whatsapp|whats\s?app|phone|number|num|contact|socials?)\b/i.test(
    text,
  );
}

function pickUnusedReply(options, used = []) {
  const freshOptions = options.filter((option) => !used.includes(option));
  if (freshOptions.length > 0) return randomFrom(freshOptions);
  return randomFrom(options);
}

function rememberBotReply(session, reply, topic = null) {
  session.recentReplies = [...(session.recentReplies || []), reply].slice(-4);
  if (topic) session.lastTopic = topic;
}

function rememberPromptType(session, promptType) {
  session.recentPromptTypes = [
    ...(session.recentPromptTypes || []),
    promptType,
  ].slice(-3);
}

function pickSessionReply(session, promptType, options, topic = null) {
  const reply = pickUnusedReply(options, session.recentReplies || []);
  rememberBotReply(session, reply, topic);
  rememberPromptType(session, promptType);
  return reply;
}

function updateBotMemory(text, session) {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return;

  session.lastUserMessage = text;
  session.userFacts ||= {};

  const hobbyMatch = normalized.match(
    /\b(gym|workout|fitness|running|run|basketball|football|gaming|game|music|guitar|art|drawing|anime|movies|movie|reading|books|cooking|travel|photography)\b/,
  );
  if (hobbyMatch) session.userFacts.hobby = hobbyMatch[1];

  const moodMatch = normalized.match(
    /\b(bored|lonely|tired|stressed|stress|restless|chill|chilling|busy)\b/,
  );
  if (moodMatch) session.userFacts.mood = moodMatch[1];

  const workStudyMatch = normalized.match(
    /\b(work|job|office|school|college|uni|class|study|studying|exam|shift)\b/,
  );
  if (workStudyMatch) session.userFacts.workStudy = workStudyMatch[1];

  const mediaMatch = normalized.match(
    /\b(movie|movies|show|shows|series|anime|song|songs|music|artist|album|netflix|spotify)\b/,
  );
  if (mediaMatch) session.userFacts.media = mediaMatch[1];

  if (
    /\b(bored|just passing time|nothing much|kill time|passing time)\b/.test(
      normalized,
    )
  ) {
    session.userFacts.reason = "passing-time";
  } else if (
    /\b(meet|meeting|someone|people|talk|convo|conversation|chat)\b/.test(
      normalized,
    )
  ) {
    session.userFacts.reason = "meeting-people";
  }
}

function getMemoryDrivenReply(session) {
  const facts = session.userFacts || {};
  const recentTypes = session.recentPromptTypes || [];

  if (facts.hobby && !recentTypes.includes("recall-hobby")) {
    return {
      promptType: "recall-hobby",
      topic: "hobbies",
      options: [
        `you mentioned ${facts.hobby} earlier. is that something you've been into for a while or more of a recent thing?`,
        `${facts.hobby} sounds like a good way to stay occupied. what part of it do you enjoy the most?`,
        `still thinking about the ${facts.hobby} part. do you usually do that to relax or because you're seriously into it?`,
      ],
    };
  }

  if (facts.workStudy && !recentTypes.includes("recall-work")) {
    return {
      promptType: "recall-work",
      topic: "work-study",
      options: [
        `you mentioned ${facts.workStudy} before. has that been eating up most of your week lately?`,
        `${facts.workStudy} can really shape your whole routine. do you still get much free time around it?`,
        `going back to what you said about ${facts.workStudy}, what's the part of it you actually don't mind?`,
      ],
    };
  }

  if (facts.media && !recentTypes.includes("recall-media")) {
    return {
      promptType: "recall-media",
      topic: "media",
      options: [
        `you brought up ${facts.media} earlier. have you found anything good lately or not really?`,
        `still on the ${facts.media} topic, are you more into familiar favorites or trying random stuff?`,
        `when you mentioned ${facts.media}, I was going to ask what your go-to pick is when you want to unwind.`,
      ],
    };
  }

  if (
    facts.reason === "passing-time" &&
    !recentTypes.includes("recall-reason")
  ) {
    return {
      promptType: "recall-reason",
      topic: session.lastTopic,
      options: [
        "you said you're mostly just passing time. do random chats usually help, or do they end up being hit or miss for you?",
        "since you're mostly here to kill time, what usually makes you stay in a convo instead of skipping?",
      ],
    };
  }

  if (facts.mood && !recentTypes.includes("recall-mood")) {
    return {
      promptType: "recall-mood",
      topic: "mood",
      options: [
        `earlier you sounded a bit ${facts.mood}. is the night getting better or still the same vibe?`,
        `you mentioned feeling ${facts.mood}. what usually shifts your mood fastest?`,
      ],
    };
  }

  return null;
}

function createBotReply(text, persona, session) {
  const normalized = text.toLowerCase().trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  const isQuestion = normalized.includes("?");
  const isShortReply = words.length <= 3;
  updateBotMemory(text, session);

  const greetingResponses = [
    "hey, how's your night going so far?",
    "yo, you just got on here or have you been scrolling for a while?",
    "hey haha, what kind of convo are you in the mood for tonight?",
  ];
  const shortReplyResponses = [
    "fair enough. are you usually on here just to pass time or actually hoping to click with someone?",
    "got you. what made you open the app tonight though?",
    "haha real. what kind of people do you normally enjoy talking to on apps like this?",
  ];
  const questionResponses = [
    "mostly just passing time and seeing who I end up talking to. what about you?",
    "kinda just here for an easy convo honestly. what about your side?",
    "a bit of both, depends who I run into. what are you hoping for tonight?",
  ];
  const generalResponses = [
    "that actually sounds pretty chill. what do you usually do when you're not on here?",
    "nice, I can see that. what's been taking most of your time lately?",
    "I get that. what kind of vibe are you usually hoping for when you talk to someone new?",
    "fair, that tells me a lot already. what do you usually enjoy talking about first?",
  ];
  const hobbyResponses = [
    "okay that's actually a good one. how did you get into that in the first place?",
    "nice, that sounds like something you could talk about for a while. what do you like most about it?",
    "that's a solid answer. do you do that often or only when you have free time?",
  ];
  const feelingResponses = [
    "yeah, I get that. is tonight more of a bored vibe or just wanting someone decent to talk to?",
    "that's fair honestly. has your day been long or are you just restless tonight?",
    "makes sense. some nights just feel slow like that. what usually fixes that mood for you?",
  ];
  const workStudyResponses = [
    "that can really eat up your time. is it something you actually enjoy or mostly just something you have to deal with?",
    "got you. does it keep you busy all week or do you still get decent free time?",
    "yeah that can shape your whole routine. what's the part of it you like the most?",
  ];
  const mediaResponses = [
    "nice, what kind are you into lately? more comfort picks or whatever's trending?",
    "that's always an easy rabbit hole. what's one you've enjoyed recently?",
    "good choice. are you picky with that stuff or do you try anything once?",
  ];

  const topicMatchers = [
    {
      topic: "hobbies",
      pattern:
        /\b(gym|workout|fitness|run|basketball|football|gaming|game|music|guitar|art|draw|drawing|anime|movie|movies|film|reading|books|cook|cooking|travel|photography)\b/,
      responses: hobbyResponses,
    },
    {
      topic: "mood",
      pattern:
        /\b(bored|lonely|tired|stress|stressed|restless|chill|chilling|nothing much|just here)\b/,
      responses: feelingResponses,
    },
    {
      topic: "work-study",
      pattern:
        /\b(work|job|office|school|college|uni|class|study|studying|exam|shift)\b/,
      responses: workStudyResponses,
    },
    {
      topic: "media",
      pattern:
        /\b(movie|movies|show|shows|series|anime|song|songs|music|artist|album|netflix|spotify)\b/,
      responses: mediaResponses,
    },
  ];

  if (!normalized) {
    return pickSessionReply(
      session,
      "empty",
      persona.prompts,
      session.lastTopic,
    );
  }

  if (/^(hi|hello|hey|yo|sup|wassup|what's up|whats up)$/.test(normalized)) {
    return pickSessionReply(
      session,
      "greeting",
      greetingResponses,
      session.lastTopic,
    );
  }

  if (/(^|\s)(hbu|wbu|you\?|and you\??)(\s|$)/.test(normalized)) {
    return pickSessionReply(
      session,
      "bounce-back",
      questionResponses,
      session.lastTopic,
    );
  }

  if (
    /\b(age|old|m or f|male|female|girl|boy|where.*from|location|asl)\b/.test(
      normalized,
    )
  ) {
    const reply =
      "let's keep it casual first. what made you hop on tonight though?";
    rememberBotReply(session, reply);
    rememberPromptType(session, "boundary");
    return reply;
  }

  if (
    /\b(bored|nothing|nm|nmu|idk|same|ok|okay|lol|lmao|fr|real)\b/.test(
      normalized,
    ) &&
    isShortReply
  ) {
    return pickSessionReply(session, "short-mood", shortReplyResponses, "mood");
  }

  for (const matcher of topicMatchers) {
    if (matcher.pattern.test(normalized)) {
      return pickSessionReply(
        session,
        `topic-${matcher.topic}`,
        matcher.responses,
        matcher.topic,
      );
    }
  }

  if (isQuestion) {
    const memoryReply = getMemoryDrivenReply(session);
    if (memoryReply) {
      return pickSessionReply(
        session,
        memoryReply.promptType,
        memoryReply.options,
        memoryReply.topic,
      );
    }

    return pickSessionReply(
      session,
      "question",
      questionResponses,
      session.lastTopic,
    );
  }

  if (session.turnCount >= 2 && isShortReply) {
    const memoryReply = getMemoryDrivenReply(session);
    if (memoryReply) {
      return pickSessionReply(
        session,
        memoryReply.promptType,
        memoryReply.options,
        memoryReply.topic,
      );
    }

    return pickSessionReply(
      session,
      "short-general",
      shortReplyResponses,
      session.lastTopic,
    );
  }

  const memoryReply = getMemoryDrivenReply(session);
  if (memoryReply) {
    return pickSessionReply(
      session,
      memoryReply.promptType,
      memoryReply.options,
      memoryReply.topic,
    );
  }

  if (session.lastTopic === "hobbies") {
    return pickSessionReply(
      session,
      "fallback-hobby",
      hobbyResponses,
      session.lastTopic,
    );
  }

  return pickSessionReply(
    session,
    "general",
    generalResponses,
    session.lastTopic,
  );
}

function getBotReplyDelay(text, options = {}) {
  const { isOpeningMessage = false } = options;

  if (isOpeningMessage) {
    return randomDelay(BOT_OPENING_REPLY_MIN_MS, BOT_OPENING_REPLY_MAX_MS);
  }

  const normalized = typeof text === "string" ? text.trim() : "";
  const wordCount = normalized
    ? normalized.split(/\s+/).filter(Boolean).length
    : 0;
  const punctuationDelay = /[?.!]/.test(normalized) ? 250 : 0;
  const wordDelay = Math.min(wordCount * 220, 2200);
  const naturalVariance = randomDelay(350, 1400);

  return Math.min(
    BOT_FOLLOW_UP_BASE_MS + wordDelay + punctuationDelay + naturalVariance,
    BOT_FOLLOW_UP_MAX_MS,
  );
}

function scheduleBotMessage(socketId, text, options = {}) {
  const session = botSessions.get(socketId);
  const socket = getSocket(socketId);
  if (!session || !socket?.connected) return;

  if (session.replyTimer) clearTimeout(session.replyTimer);
  if (session.typingTimer) clearTimeout(session.typingTimer);

  socket.emit("typing");
  const delayMs = getBotReplyDelay(text, options);

  session.typingTimer = setTimeout(() => {
    const liveSocket = getSocket(socketId);
    if (!botSessions.has(socketId) || !liveSocket?.connected) return;

    liveSocket.emit("stopTyping");
    liveSocket.emit("message", text);
    session.typingTimer = null;

    if (options.closeConversationAfterMs) {
      session.replyTimer = setTimeout(() => {
        const activeSocket = getSocket(socketId);
        if (!botSessions.has(socketId) || !activeSocket?.connected) return;

        activeSocket.emit("partnerLeft");
        stopBotConversation(socketId);
      }, options.closeConversationAfterMs);
      return;
    }

    session.replyTimer = null;
  }, delayMs);
}

function maybeStartBotConversation(socketId) {
  clearBotFallback(socketId);

  const socket = getSocket(socketId);
  if (!socket?.connected) return;
  if (
    !isSeekEligible(socketId) ||
    partners.has(socketId) ||
    botSessions.has(socketId)
  )
    return;

  compactQueue();
  const otherEligibleUsers = waitingQueue.filter(
    (id) =>
      id !== socketId &&
      isSeekEligible(id) &&
      Boolean(getSocket(id)?.connected),
  ).length;

  // Only offer the AI companion when there is nobody else to pair with.
  if (otherEligibleUsers > 0) return;

  const persona = pickBotPersona();
  const commonTopics = commonInterests(getInterests(socketId), persona.topics);

  removeFromQueue(socketId);
  activeSeekers.delete(socketId);
  botSessions.set(socketId, {
    persona,
    replyTimer: null,
    typingTimer: null,
    turnCount: 0,
    lastTopic: null,
    recentReplies: [],
    recentPromptTypes: [],
    userFacts: {},
    lastUserMessage: "",
  });

  socket.emit("matched", {
    commonInterests: commonTopics,
    isAiCompanion: true,
    companionProfile: {
      id: persona.id,
      name: persona.name,
      description: persona.description,
    },
  });

  scheduleBotMessage(socketId, persona.opener, { isOpeningMessage: true });
}

function scheduleBotFallback(socket) {
  clearBotFallback(socket.id);
  botFallbackTimers.set(
    socket.id,
    setTimeout(
      () => maybeStartBotConversation(socket.id),
      randomDelay(BOT_FALLBACK_WAIT_MIN_MS, BOT_FALLBACK_WAIT_MAX_MS),
    ),
  );
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
      clearBotFallback(id);
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
  stopBotConversation(first.id);
  stopBotConversation(second.id);
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
  stopBotConversation(socket.id);
  removeFromQueue(socket.id);

  // Never enqueue/match users unless they explicitly initiated search.
  if (!isSeekEligible(socket.id)) return;

  const normalized = normalizeInterests(interests);
  userInterests.set(socket.id, normalized);

  // Add to queue and run the matcher.
  waitingQueue.push(socket.id);
  queuedAt.set(socket.id, Date.now());
  drainQueueMatches();

  if (waitingQueue.includes(socket.id) && isSeekEligible(socket.id)) {
    scheduleBotFallback(socket);
  }
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
    socket.emit("security:block", {
      reason: "Too many abuse attempts. Try again later.",
    });
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

    stopBotConversation(socket.id);

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
    if (
      isSocketEventRateLimited(socket.id, "message", MAX_MESSAGES_PER_WINDOW)
    ) {
      recordIpAbuse(ip);
      return;
    }
    if (isMessageRateLimited(socket.id)) return;
    const message = sanitizeMessage(text);
    if (!message) return;

    const botSession = botSessions.get(socket.id);
    if (botSession) {
      botSession.turnCount += 1;

      if (isBotSocialRequest(message)) {
        const reply = "i have wait";
        rememberBotReply(botSession, reply, botSession.lastTopic);
        rememberPromptType(botSession, "boundary-social");
        scheduleBotMessage(socket.id, reply, {
          closeConversationAfterMs: 1300,
        });
        return;
      }

      const reply = createBotReply(message, botSession.persona, botSession);
      scheduleBotMessage(socket.id, reply);
      return;
    }

    const partnerSocket = getSocket(partners.get(socket.id));
    if (partnerSocket?.connected) partnerSocket.emit("message", message);
  });

  socket.on("typing", () => {
    if (botSessions.has(socket.id)) return;
    const partnerSocket = getSocket(partners.get(socket.id));
    if (partnerSocket?.connected) partnerSocket.emit("typing");
  });

  socket.on("stopTyping", () => {
    if (botSessions.has(socket.id)) return;
    const partnerSocket = getSocket(partners.get(socket.id));
    if (partnerSocket?.connected) partnerSocket.emit("stopTyping");
  });

  socket.on("topicSpin", (payload) => {
    if (!payload || typeof payload !== "object") return;
    const raw = payload.topic;
    if (typeof raw !== "string") return;
    const topic = raw.trim().slice(0, 120);
    if (!topic) return;

    // Only allow when paired
    const partnerSocket = getSocket(partners.get(socket.id));
    if (!partnerSocket?.connected) return;

    // Broadcast the result to both sides of the pair
    socket.emit("topicResult", { topic });
    partnerSocket.emit("topicResult", { topic });
  });

  socket.on("next", () => {
    if (isSocketEventRateLimited(socket.id, "next", MAX_NEXTS_PER_WINDOW)) {
      recordIpAbuse(ip);
      return;
    }

    const interests = userInterests.get(socket.id) || [];
    stopBotConversation(socket.id);
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

    stopBotConversation(socket.id);
    activeSeekers.delete(socket.id);
    removeFromQueue(socket.id);
    unpair(socket, { notifyPartner: true, requeuePartner: false });
    userInterests.delete(socket.id);
  });

  socket.on("disconnect", () => {
    stopBotConversation(socket.id);
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

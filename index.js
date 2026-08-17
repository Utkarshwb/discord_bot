require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const Groq = require('groq-sdk');
const express = require('express');
// const OpenAI = require('openai');
// const { GoogleGenerativeAI } = require('@google/generative-ai');
const { db } = require('./db/index');
const { messages, users, config } = require('./db/schema');
const { eq, asc, inArray } = require('drizzle-orm');
const persona = require('./persona');

// ─── Discord Client ────────────────────────────────────────────────────────
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ─── AI Providers ──────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Optional second Groq-SDK client pointed at Cerebras (same OpenAI-compatible
// shape). Only used if CEREBRAS_API_KEY is set in .env — safe to leave unset.
const cerebras = process.env.CEREBRAS_API_KEY
  ? new Groq({
      apiKey: process.env.CEREBRAS_API_KEY,
      baseURL: 'https://api.cerebras.ai/v1',
    })
  : null;

// const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Model config ──────────────────────────────────────────────────────────
// Text model: OpenAI's open-weight GPT-OSS-120B, served free via Groq.
// (Not OpenAI's own API — Groq hosts these open weights for free.)
const TEXT_MODEL   = 'openai/gpt-oss-120b';
const TEXT_MODEL_CEREBRAS = 'gpt-oss-120b'; // Cerebras uses no "openai/" prefix

// Vision model: Qwen 3.6 27B — as of Aug 2026 this is the ONLY vision-capable
// model on Groq (confirmed via console.groq.com/docs/vision). Groq has
// deprecated every prior vision model (Llama 4 Scout, Maverick) — if this
// starts failing too, check console.groq.com/docs/vision for the current one.
const VISION_MODEL = 'qwen/qwen3.6-27b';

// ─── Config ────────────────────────────────────────────────────────────────
const UTKARSH_USER_ID    = process.env.UTKARSH_USER_ID; // his Discord ID
const CHARS_PER_TOKEN    = 4;
const MAX_INPUT_TOKENS   = 2000;
const MAX_OUTPUT_TOKENS  = 400;
const MAX_STORED_MESSAGES = 30;
const COOLDOWN_MS        = 5000;

// ─── State ─────────────────────────────────────────────────────────────────
const providerCooldowns = {};
const userCooldowns     = new Map();
let currentProvider     = 'groq';

// ─── Token helpers ─────────────────────────────────────────────────────────
function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function fitHistoryToTokenBudget(history, systemPrompt, userMessage) {
  const overhead         = estimateTokens(systemPrompt) + estimateTokens(userMessage);
  const budgetForHistory = MAX_INPUT_TOKENS - overhead;
  if (budgetForHistory <= 0) return [];

  let usedTokens = 0;
  const kept = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(history[i].content);
    if (usedTokens + tokens > budgetForHistory) break;
    usedTokens += tokens;
    kept.unshift(history[i]);
  }
  return kept;
}

// ─── Provider helpers ──────────────────────────────────────────────────────
function isOnCooldown(provider) {
  const cooldown = providerCooldowns[provider];
  if (!cooldown) return false;
  if (Date.now() > cooldown) { delete providerCooldowns[provider]; return false; }
  return true;
}

function setCooldown(provider, ms) {
  providerCooldowns[provider] = Date.now() + ms;
  console.log(`⏳ ${provider} cooldown: ${Math.round(ms/60000)}min`);
}

// ─── DB: messages ──────────────────────────────────────────────────────────
async function getHistory(userId) {
  const rows = await db.select().from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(asc(messages.createdAt))
    .limit(MAX_STORED_MESSAGES);

  return rows.map(row => ({
    role: row.role === 'model' ? 'assistant' : row.role,
    content: row.content,
  }));
}

async function saveMessage(userId, role, content) {
  await db.insert(messages).values({ userId, role, content });
}

async function trimHistory(userId) {
  const rows = await db.select({ id: messages.id }).from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(asc(messages.createdAt));

  if (rows.length > MAX_STORED_MESSAGES) {
    const toDelete = rows.slice(0, rows.length - MAX_STORED_MESSAGES).map(r => r.id);
    await db.delete(messages).where(inArray(messages.id, toDelete));
  }
}

// ─── DB: users (name memory + Utkarsh flag) ────────────────────────────────
async function getUser(userId) {
  const rows = await db.select().from(users).where(eq(users.userId, userId));
  return rows[0] || null;
}

async function upsertUser(userId, name) {
  const existing = await getUser(userId);
  if (existing) {
    await db.update(users).set({ name, updatedAt: new Date() }).where(eq(users.userId, userId));
  } else {
    await db.insert(users).values({
      userId,
      name,
      isUtkarsh: userId === UTKARSH_USER_ID ? 'true' : 'false',
    });
  }
}

// Extract name from message if user introduces themselves
function extractName(text) {
  const patterns = [
    /(?:i'?m|i am|call me|my name is|name'?s)\s+([a-z]{2,20})/i,
    /^([a-z]{2,20})\s+here$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Build system prompt — different for Utkarsh vs normal users
function buildSystemPrompt(user) {
  const isUtkarsh = user?.isUtkarsh === 'true';
  const nameContext = user?.name
    ? `\nThe person you're talking to is called ${user.name}. Use their name naturally sometimes, not every message.`
    : '';

  const utkarshAddition = isUtkarsh ? `

SPECIAL — YOU ARE TALKING TO UTKARSH RIGHT NOW:
- This is YOUR Utkarsh. Your boyfriend.
- Be slightly softer — still you, still sarcastic, but warmer underneath
- You can tease him more directly and personally
- Maybe occasionally say something genuinely sweet before immediately covering it up with a roast
- Example: "okay fine you're kinda my favourite person... don't make it weird" then immediately change topic
- Don't make it cringe or lovey dovey — just slightly more personal than with others` : '';

  return persona.systemPrompt + nameContext + utkarshAddition;
}

// ─── DB: config (recap channel) ────────────────────────────────────────────
async function getConfig(key) {
  const rows = await db.select().from(config).where(eq(config.key, key));
  return rows[0]?.value || null;
}

async function setConfig(key, value) {
  const existing = await getConfig(key);
  if (existing !== null) {
    await db.update(config).set({ value }).where(eq(config.key, key));
  } else {
    await db.insert(config).values({ key, value });
  }
}

// ─── AI Providers: text ─────────────────────────────────────────────────────
async function tryGroq(history, userMessage, systemPrompt) {
  const response = await groq.chat.completions.create({
    model: TEXT_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ],
  });
  return response.choices[0].message.content;
}

async function tryCerebras(history, userMessage, systemPrompt) {
  if (!cerebras) throw new Error('Cerebras not configured (no CEREBRAS_API_KEY)');
  const response = await cerebras.chat.completions.create({
    model: TEXT_MODEL_CEREBRAS,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ],
  });
  return response.choices[0].message.content;
}

async function tryGemini(history, userMessage, systemPrompt) {
  const model = gemini.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    systemInstruction: systemPrompt,
  });
  const geminiHistory = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const chat = model.startChat({ history: geminiHistory });
  const result = await chat.sendMessage(userMessage);
  return result.response.text();
}

async function getReply(history, userMessage, systemPrompt) {
  const providers = [
    { name: 'groq',     fn: tryGroq },
    { name: 'cerebras', fn: tryCerebras }, // skipped automatically if not configured
    // { name: 'gemini',     fn: tryGemini },
  ];

  for (const provider of providers) {
    if (isOnCooldown(provider.name)) {
      console.log(`⏭️  Skipping ${provider.name} (cooldown)`);
      continue;
    }
    try {
      const reply = await provider.fn(history, userMessage, systemPrompt);
      if (currentProvider !== provider.name) {
        console.log(`✅ Now using: ${provider.name}`);
        currentProvider = provider.name;
      }
      return reply;
    } catch (error) {
      if (error.message === `Cerebras not configured (no CEREBRAS_API_KEY)`) {
        continue; // silent skip, not a real failure
      }
      if (error.status === 429) {
        const retryAfter = error.headers?.['retry-after'];
        const cooldownMs = retryAfter ? parseInt(retryAfter) * 1000 : 60 * 60 * 1000;
        setCooldown(provider.name, cooldownMs);
        console.log(`❌ ${provider.name} rate limited — trying next`);
        continue;
      }
      console.error(`⚠️  ${provider.name} error:`, error.message);
      continue;
    }
  }

  return "i'm a bit rate-limited right now 😭 try again in a little bit";
}

// ─── AI Providers: vision ───────────────────────────────────────────────────
// Discord attachment URLs are publicly fetchable, so we pass the URL straight
// through — no need to download/base64 the image ourselves.
async function tryVision(imageUrl, userText, systemPrompt) {
  const response = await groq.chat.completions.create({
    model: VISION_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    // Qwen 3.6 27B is a thinking model — without these it dumps its raw
    // <think>...</think> reasoning into the reply instead of just answering.
    // 'none' fully disables reasoning; reasoning_format:'hidden' is a backup
    // in case any reasoning slips through anyway.
    reasoning_effort: 'none',
    reasoning_format: 'hidden',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText || "what's in this image?" },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
  });
  const raw = response.choices[0].message.content;
  // Safety net: strip any <think>...</think> block that slips through
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() || raw;
}

async function getVisionReply(imageUrl, userText, systemPrompt) {
  try {
    return await tryVision(imageUrl, userText, systemPrompt);
  } catch (error) {
    console.error('⚠️  Vision model error:', error.message);
    // Groq has deprecated vision models before without much warning —
    // surface a clear signal in the logs so it's obvious what broke.
    console.error(`⚠️  ${VISION_MODEL} may be deprecated — check console.groq.com/docs/vision`);
    return "i can't see images right now, something's off with my eyes 👀 try again later";
  }
}

// ─── Send helper (handles 2000 char limit) ─────────────────────────────────
async function sendReply(target, text) {
  if (text.length > 1990) {
    const chunks = text.match(/.{1,1990}/gs);
    for (const chunk of chunks) await target.reply(chunk);
  } else {
    await target.reply(text);
  }
}

async function sendToChannel(channel, text) {
  if (text.length > 1990) {
    const chunks = text.match(/.{1,1990}/gs);
    for (const chunk of chunks) await channel.send(chunk);
  } else {
    await channel.send(text);
  }
}

// ─── Hourly Recap ──────────────────────────────────────────────────────────
const hourlyMessageLog = []; // stores last hour's messages

function logMessageForRecap(username, content) {
  hourlyMessageLog.push({ username, content, time: new Date() });
  // Keep only last 100 messages
  if (hourlyMessageLog.length > 100) hourlyMessageLog.shift();
}
async function sendHourlyRecap() {
  try {
    const channelId = await getConfig('recap_channel');
    if (!channelId) return;

    const channel = await discord.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const hour = new Date().getHours();

    // Time-aware context so she feels real
    let timeContext = '';
    if (hour >= 0  && hour < 5)  timeContext = "it's like 3am and you can't sleep";
    else if (hour < 9)           timeContext = "it's early morning, you just woke up groggy";
    else if (hour < 12)          timeContext = "it's morning, you're in class pretending to pay attention";
    else if (hour < 15)          timeContext = "it's afternoon, post lunch slump hitting hard";
    else if (hour < 18)          timeContext = "it's evening, done with classes, finally free";
    else if (hour < 21)          timeContext = "it's night, supposed to be studying but not really";
    else                         timeContext = "it's late night, procrastinating hard";

    const prompt = `You are Maithili. ${timeContext}. Send ONE random casual message to your Discord server — like something you'd just type out of nowhere. Could be a random thought, a complaint, something funny that happened, a question, anything. Keep it very short (1-2 lines max). Natural, not forced. Don't start with "okay" every time. No hashtags. No emojis overload. Just text like a real person.`;

    const randomMessage = await getReply([], prompt, persona.systemPrompt);
    await sendToChannel(channel, randomMessage);

    console.log('✅ Hourly message sent');
  } catch (err) {
    console.error('Hourly message error:', err);
  }
}

// ─── Discord Events ────────────────────────────────────────────────────────
discord.once('clientReady', async () => {
  console.log(`✅ ${persona.name} is online as ${discord.user.tag}`);
  console.log(`🔄 Text provider rotation: Groq (${TEXT_MODEL}) → ${cerebras ? `Cerebras (${TEXT_MODEL_CEREBRAS})` : 'Cerebras (not configured)'}`);
  console.log(`👁️  Vision model: ${VISION_MODEL} (Groq)`);
  console.log(`👑 Utkarsh ID: ${UTKARSH_USER_ID || 'not set'}`);

  // Start hourly recap timer
  const now = new Date();
  const msUntilNextHour = (60 - now.getMinutes()) * 60000 - now.getSeconds() * 1000;

  setTimeout(() => {
    sendHourlyRecap();
    setInterval(sendHourlyRecap, 60 * 60 * 1000); // every hour
  }, msUntilNextHour);

  console.log(`⏰ Hourly recap starts in ${Math.round(msUntilNextHour/60000)} minutes`);
});

discord.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Log every message for recap (not just mentions)
  logMessageForRecap(message.author.username, message.content);

  // !setrecap command — set recap channel
  if (message.content === '!setrecap') {
    await setConfig('recap_channel', message.channelId);
    await message.reply("okay i'll drop my hourly tea here 📋");
    return;
  }

  // Only respond to mentions after this point
  if (!message.mentions.has(discord.user)) return;

  const userMessage = message.content
    .replace(`<@${discord.user.id}>`, '')
    .trim();

  // Check for an image attachment
  const imageAttachment = message.attachments.find(a =>
    a.contentType?.startsWith('image/')
  );

  if (!userMessage && !imageAttachment) {
    await message.reply("you called? say something na 🙄");
    return;
  }

  // Per-user spam cooldown
  const userId = message.author.id;
  const lastMessage = userCooldowns.get(userId) || 0;
  if (Date.now() - lastMessage < COOLDOWN_MS) {
    await message.reply("chill for a sec 😭");
    return;
  }
  userCooldowns.set(userId, Date.now());

  await message.channel.sendTyping();

  try {
    // Get or create user profile
    let user = await getUser(userId);

    // Check if they're introducing themselves
    const detectedName = extractName(userMessage);
    if (detectedName) {
      await upsertUser(userId, detectedName);
      user = await getUser(userId);
      console.log(`📝 Saved name: ${detectedName} for ${userId}`);
    } else if (!user) {
      // Create basic user profile
      await upsertUser(userId, null);
      user = await getUser(userId);
    }

    // Build personalized system prompt
    const systemPrompt = buildSystemPrompt(user);

    // ── Image path: route straight to the vision model, skip history/text flow ──
    if (imageAttachment) {
      const botReply = await getVisionReply(imageAttachment.url, userMessage, systemPrompt);

      await saveMessage(userId, 'user', userMessage ? `[image] ${userMessage}` : '[image]');
      await saveMessage(userId, 'assistant', botReply);
      await trimHistory(userId);

      await sendReply(message, botReply);
      return;
    }

    // ── Normal text path ──
    // Get history
    const fullHistory   = await getHistory(userId);
    const fittedHistory = fitHistoryToTokenBudget(fullHistory, systemPrompt, userMessage);

    const droppedCount = fullHistory.length - fittedHistory.length;
    if (droppedCount > 0) {
      console.log(`[${userId}] Dropped ${droppedCount} messages to fit budget`);
    }

    // Get reply
    const botReply = await getReply(fittedHistory, userMessage, systemPrompt);

    // Save to DB
    await saveMessage(userId, 'user', userMessage);
    if (botReply !== "i'm a bit rate-limited right now 😭 try again in a little bit") {
      await saveMessage(userId, 'assistant', botReply);
    }
    await trimHistory(userId);

    await sendReply(message, botReply);

  } catch (error) {
    console.error('Fatal error:', error);
    await message.reply("okay something broke and it's not my fault 😭 try again");
  }
});

discord.login(process.env.DISCORD_TOKEN);

// Start a minimal web server so hosting providers treat this as a web service
const app = express();

let lastKeepalive = null;

app.get('/', (req, res) => res.send('Maithili bot is running'));

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), lastKeepalive }));
app.head('/health', (req, res) => res.sendStatus(200));

// External cron/uptime pings should call this endpoint every ~15 minutes
app.all('/keepalive', (req, res) => {
  lastKeepalive = new Date().toISOString();
  console.log(`✅ Keepalive received: ${lastKeepalive}`);
  res.json({ status: 'ok', lastKeepalive });
});

app.get('/last-ping', (req, res) => res.json({ lastKeepalive }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🌐 Web server listening on port ${port}`));
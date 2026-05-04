require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { db } = require('./db/index');
const { messages } = require('./db/schema');
const { eq, asc } = require('drizzle-orm');
const persona = require('./persona');

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Token Budget Config ───────────────────────────────────────────────────
const CHARS_PER_TOKEN     = 4;    // rough estimate: 1 token ≈ 4 chars
const MAX_INPUT_TOKENS    = 2000; // total budget for history + system prompt
const MAX_OUTPUT_TOKENS   = 400;  // bot reply cap
const MAX_STORED_MESSAGES = 30;   // how many messages to keep in DB per user
// ──────────────────────────────────────────────────────────────────────────

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Fit as many recent messages as possible within the token budget.
// Always keeps the most recent exchanges — drops oldest first.
function fitHistoryToTokenBudget(history, systemPrompt, userMessage) {
  const systemTokens  = estimateTokens(systemPrompt);
  const userTokens    = estimateTokens(userMessage);
  const overhead      = systemTokens + userTokens;
  const budgetForHistory = MAX_INPUT_TOKENS - overhead;

  if (budgetForHistory <= 0) return []; // system + user alone is already tight

  // Walk from newest → oldest, accumulate until budget is hit
  let usedTokens = 0;
  const kept = [];

  for (let i = history.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(history[i].content);
    if (usedTokens + tokens > budgetForHistory) break;
    usedTokens += tokens;
    kept.unshift(history[i]); // prepend to maintain order
  }

  return kept;
}

// Fetch full stored history for a user (up to MAX_STORED_MESSAGES)
async function getHistory(userId) {
  const rows = await db
    .select()
    .from(messages)
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

// Keep DB clean — trim to MAX_STORED_MESSAGES per user
async function trimHistory(userId) {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(asc(messages.createdAt));

  if (rows.length > MAX_STORED_MESSAGES) {
    const toDelete = rows.slice(0, rows.length - MAX_STORED_MESSAGES);
    for (const { id } of toDelete) {
      await db.delete(messages).where(eq(messages.id, id));
    }
  }
}

// Per-user cooldown to prevent spam draining quota
const cooldowns = new Map();
const COOLDOWN_MS = 5000;

discord.once('ready', () => {
  console.log(`✅ ${persona.name} is online as ${discord.user.tag}`);
});

discord.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(discord.user)) return;

  const userMessage = message.content
    .replace(`<@${discord.user.id}>`, '')
    .trim();

  if (!userMessage) {
    await message.reply("you called? say something na 🙄");
    return;
  }

  // Cooldown check
  const userId = message.author.id;
  const lastMessage = cooldowns.get(userId) || 0;
  if (Date.now() - lastMessage < COOLDOWN_MS) {
    await message.reply("chill for a sec 😭");
    return;
  }
  cooldowns.set(userId, Date.now());

  await message.channel.sendTyping();

  try {
    const fullHistory = await getHistory(userId);
    const fittedHistory = fitHistoryToTokenBudget(
      fullHistory,
      persona.systemPrompt,
      userMessage
    );

    // Debug log so you can tune the budget
    const droppedCount = fullHistory.length - fittedHistory.length;
    if (droppedCount > 0) {
      console.log(`[${userId}] Dropped ${droppedCount} old messages to fit token budget`);
    }

    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: persona.systemPrompt },
        ...fittedHistory,
        { role: 'user', content: userMessage },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
    });

    const botReply = response.choices[0].message.content;

    // Save full content (no truncation — quality preserved)
    await saveMessage(userId, 'user', userMessage);
    await saveMessage(userId, 'assistant', botReply);
    await trimHistory(userId);

    // Handle Discord 2000 char limit
    if (botReply.length > 1990) {
      const chunks = botReply.match(/.{1,1990}/gs);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(botReply);
    }

  } catch (error) {
    console.error('Error:', error);
    if (error.status === 429) {
      await message.reply("okay too many messages, give me a sec 😭 try in a minute");
    } else {
      await message.reply("okay something broke and it's not my fault 😭 try again");
    }
  }
});

discord.login(process.env.DISCORD_TOKEN);
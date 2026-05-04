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

// OpenRouter uses OpenAI-compatible API
const Groq = require('groq-sdk');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const MAX_HISTORY = 10;

// Get last N messages for a user from DB
async function getHistory(userId) {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(asc(messages.createdAt))
    .limit(MAX_HISTORY * 2);

  return rows.map(row => ({
    role: row.role === 'model' ? 'assistant' : row.role, // openai uses 'assistant' not 'model'
    content: row.content,
  }));
}

// Save message to DB
async function saveMessage(userId, role, content) {
  await db.insert(messages).values({ userId, role, content });
}

// Trim old messages
async function trimHistory(userId) {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(asc(messages.createdAt));

  if (rows.length > MAX_HISTORY * 2) {
    const toDelete = rows.slice(0, rows.length - MAX_HISTORY * 2);
    for (const { id } of toDelete) {
      await db.delete(messages).where(eq(messages.id, id));
    }
  }
}

discord.once('ready', () => {
  console.log(`✅ ${persona.name} is online as ${discord.user.tag}`);
  console.log(`🔀 Using OpenRouter`);
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

  await message.channel.sendTyping();

  try {
    const userId = message.author.id;
    const history = await getHistory(userId);

    const response = await groq.chat.completions.create({
  model: 'llama-3.3-70b-versatile', // fast + smart + free
  messages: [
    { role: 'system', content: persona.systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ],
  max_tokens: 500, // keep replies short = faster
});

const botReply = response.choices[0].message.content;

    // Save to DB (use 'assistant' for openai format)
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
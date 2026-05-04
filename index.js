require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-3-flash-preview',
  systemInstruction: persona.systemPrompt,
});

const MAX_HISTORY = 10; // exchanges per user

// Get last N messages for a user from DB
async function getHistory(userId) {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(asc(messages.createdAt))
    .limit(MAX_HISTORY * 2); // 10 exchanges = 20 messages

  // Convert to Gemini format
  return rows.map(row => ({
    role: row.role,
    parts: [{ text: row.content }],
  }));
}

// Save a message to DB
async function saveMessage(userId, role, content) {
  await db.insert(messages).values({ userId, role, content });
}

// Keep only latest MAX_HISTORY exchanges per user (trim old ones)
async function trimHistory(userId) {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(asc(messages.createdAt));

  // If over limit, delete oldest ones
  if (rows.length > MAX_HISTORY * 2) {
    const toDelete = rows.slice(0, rows.length - MAX_HISTORY * 2);
    const idsToDelete = toDelete.map(r => r.id);

    for (const id of idsToDelete) {
      await db.delete(messages).where(eq(messages.id, id));
    }
  }
}

discord.once('ready', () => {
  console.log(`✅ ${persona.name} is online as ${discord.user.tag}`);
  console.log(`🗄️  Connected to Supabase`);
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

    // Get history from Supabase
    const history = await getHistory(userId);

    // Start Gemini chat with history
    const chat = model.startChat({ history });

    // Send message to Gemini
    const result = await chat.sendMessage(userMessage);
    const botReply = result.response.text();

    // Save both messages to Supabase
    await saveMessage(userId, 'user', userMessage);
    await saveMessage(userId, 'model', botReply);

    // Trim old messages to keep only latest 10 exchanges
    await trimHistory(userId);

    // Send reply (handle Discord 2000 char limit)
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
    await message.reply("okay something broke and it's not my fault 😭 try again");
  }
});

discord.login(process.env.DISCORD_TOKEN);
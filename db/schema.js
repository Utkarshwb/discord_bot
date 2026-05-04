const { pgTable, text, integer, timestamp } = require('drizzle-orm/pg-core');

const messages = pgTable('messages', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),        // 'user' or 'model'
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

module.exports = { messages };
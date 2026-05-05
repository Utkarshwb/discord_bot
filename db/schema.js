const { pgTable, text, integer, timestamp } = require('drizzle-orm/pg-core');

const messages = pgTable('messages', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

const users = pgTable('users', {
  userId: text('user_id').primaryKey(),
  name: text('name'),
  isUtkarsh: text('is_utkarsh').default('false'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

const config = pgTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

module.exports = { messages, users, config };
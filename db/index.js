const { drizzle } = require('drizzle-orm/postgres-js');
const postgres = require('postgres');
const schema = require('./schema');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set — bot will crash on first DB call');
  process.exit(1);
}

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client, { schema });

module.exports = { db };
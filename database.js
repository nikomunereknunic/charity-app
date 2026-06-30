const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS needs (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      target_amount INTEGER NOT NULL,
      current_amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      payment_hash TEXT PRIMARY KEY,
      amount INTEGER NOT NULL,
      need_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const { rows } = await pool.query('SELECT COUNT(*) FROM needs');
  if (parseInt(rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO needs (title, target_amount) VALUES
      ('Potraviny a drogerie', 10000),
      ('Oblečení', 8000),
      ('Doprava', 5000),
      ('Energie', 12000),
      ('Úspory na horší časy', 15000)
    `);
    console.log('Potřeby přidány.');
  }
  console.log('Databáze připravena.');
}

run().catch(console.error);

module.exports = pool;

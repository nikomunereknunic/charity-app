require('dotenv').config();
const express = require('express');
const axios = require('axios');
const pool = require('./database.js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const LIGHTNING_ADDRESS = process.env.LIGHTNING_ADDRESS || 'morosewhip243@walletofsatoshi.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = process.env.PORT || 3000;

if (!LIGHTNING_ADDRESS) {
    console.warn('\n⚠️  LIGHTNING_ADDRESS není nastavena.\n');
}
if (!ADMIN_PASSWORD) {
    console.warn('\n⚠️  ADMIN_PASSWORD není nastavena – admin přehled nebude fungovat.\n');
}

function lightningAddressToUrl(address) {
    const [name, domain] = address.split('@');
    return `https://${domain}/.well-known/lnurlp/${name}`;
}

function checkAdminPassword(req, res, next) {
    if (!ADMIN_PASSWORD) {
        return res.status(500).json({ error: 'ADMIN_PASSWORD není nastavena na serveru.' });
    }
    const supplied = req.headers['x-admin-password'];
    if (!supplied || supplied !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Nesprávné heslo.' });
    }
    next();
}

// Zjistí, jestli začal nový měsíc, a pokud ano, vynuluje current_amount u všech potřeb.
// Historie plateb v tabulce invoices zůstává nedotčená - slouží pro admin přehled.
async function ensureMonthlyReset() {
    const currentMonthKey = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const { rows } = await pool.query(
        "SELECT value FROM app_settings WHERE key = 'last_reset_month'"
    );
    const lastResetMonth = rows.length ? rows[0].value : null;

    if (lastResetMonth !== currentMonthKey) {
        await pool.query('UPDATE needs SET current_amount = 0');
        await pool.query(
            `INSERT INTO app_settings (key, value) VALUES ('last_reset_month', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [currentMonthKey]
        );
        console.log(`Měsíční reset proveden pro ${currentMonthKey}.`);
    }
}

app.get('/api/needs', async (req, res) => {
    try {
        await ensureMonthlyReset();
        const { rows } = await pool.query("SELECT id, title, target_amount, current_amount FROM needs WHERE status = 'open'");
        res.json({ message: "success", data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/create-invoice', async (req, res) => {
    const amount = parseInt(req.body.amount, 10);
    const needId = parseInt(req.body.needId, 10);

    if (!Number.isInteger(amount) || amount <= 0)
        return res.status(400).json({ error: "Částka musí být kladné celé číslo." });
    if (!Number.isInteger(needId))
        return res.status(400).json({ error: "Chybí ID potřeby." });

    try {
        const { rows } = await pool.query("SELECT id FROM needs WHERE id = $1 AND status = 'open'", [needId]);
        if (!rows.length) return res.status(404).json({ error: "Potřeba neexistuje." });

        const lnurlInfo = await axios.get(lightningAddressToUrl(LIGHTNING_ADDRESS));
        const { callback, minSendable, maxSendable } = lnurlInfo.data;

        const amountMsat = amount * 1000;
        if (amountMsat < minSendable || amountMsat > maxSendable) {
            return res.status(400).json({ error: "Částka je mimo povolený rozsah." });
        }

        const invoiceResponse = await axios.get(callback, { params: { amount: amountMsat } });
        const payment_request = invoiceResponse.data.pr;

        if (!payment_request) {
            throw new Error("Nepodařilo se získat platební žádost.");
        }

        const payment_id = `${needId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        await pool.query(
            "INSERT INTO invoices (payment_hash, amount, need_id, status, source) VALUES ($1, $2, $3, 'pending', 'app')",
            [payment_id, amount, needId]
        );

        res.json({ payment_request, payment_hash: payment_id });
    } catch (error) {
        console.error("Chyba:", error.response?.data || error.message);
        res.status(502).json({ error: "Nepodařilo se vytvořit platbu." });
    }
});

app.post('/api/confirm-payment', async (req, res) => {
    const { payment_hash } = req.body;
    if (!payment_hash) return res.status(400).json({ error: "Chybí identifikátor platby." });

    try {
        const { rows } = await pool.query("SELECT amount, need_id, status FROM invoices WHERE payment_hash = $1", [payment_hash]);
        if (!rows.length) return res.status(404).json({ error: "Platba nenalezena." });
        if (rows[0].status === 'paid') return res.json({ paid: true });

        await pool.query("UPDATE invoices SET status = 'paid' WHERE payment_hash = $1", [payment_hash]);
        await pool.query("UPDATE needs SET current_amount = current_amount + $1 WHERE id = $2",
            [rows[0].amount, rows[0].need_id]);

        res.json({ paid: true });
    } catch (error) {
        console.error("Chyba při potvrzení:", error.message);
        res.status(500).json({ error: "Nepodařilo se potvrdit platbu." });
    }
});

app.get('/api/invoice-status/:hash', async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT status FROM invoices WHERE payment_hash = $1", [req.params.hash]);
        res.json({ paid: rows.length ? rows[0].status === 'paid' : false });
    } catch {
        res.json({ paid: false });
    }
});

app.get('/api/admin/invoices', checkAdminPassword, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT i.payment_hash, i.amount, i.status, i.created_at, i.source, i.note, n.title
            FROM invoices i
            JOIN needs n ON n.id = i.need_id
            WHERE i.status = 'paid'
            ORDER BY i.created_at DESC
        `);
        res.json({ data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Ruční zápis daru přijatého mimo appku (např. z Geyser Fund), aby se promítl
// do admin přehledu a do current_amount dané kategorie.
app.post('/api/admin/manual-entry', checkAdminPassword, async (req, res) => {
    const amount = parseInt(req.body.amount, 10);
    const needId = parseInt(req.body.needId, 10);
    const source = (req.body.source || 'manual').trim();
    const note = (req.body.note || '').trim() || null;

    if (!Number.isInteger(amount) || amount <= 0)
        return res.status(400).json({ error: "Částka musí být kladné celé číslo." });
    if (!Number.isInteger(needId))
        return res.status(400).json({ error: "Chybí ID potřeby." });

    try {
        const { rows } = await pool.query("SELECT id FROM needs WHERE id = $1", [needId]);
        if (!rows.length) return res.status(404).json({ error: "Potřeba neexistuje." });

        const payment_id = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        await pool.query(
            "INSERT INTO invoices (payment_hash, amount, need_id, status, source, note) VALUES ($1, $2, $3, 'paid', $4, $5)",
            [payment_id, amount, needId, source, note]
        );
        await pool.query("UPDATE needs SET current_amount = current_amount + $1 WHERE id = $2", [amount, needId]);

        res.json({ success: true });
    } catch (error) {
        console.error("Chyba při ručním zápisu:", error.message);
        res.status(500).json({ error: "Nepodařilo se zapsat dar." });
    }
});

// ---- Geyser Fund - automatické čtení celkové vybrané částky (best-effort) ----
// POZOR: Toto používá nezdokumentované GraphQL API Geyseru. Přesné názvy polí
// (project, balance, fundersCount) jsou odhad na základě veřejně dostupných
// informací o jejich frontendu, ne oficiální dokumentace. Pokud Geyser API
// změní, tahle část jen tiše selže (viz catch blok) a zbytek appky poběží dál.
const GEYSER_PROJECT_SLUG = process.env.GEYSER_PROJECT_SLUG || 'familycommunitylightningsupport';
const GEYSER_API_URL = 'https://api.geyser.fund/graphql';
const GEYSER_CACHE_MS = 5 * 60 * 1000; // 5 minut - ať appka nebombarduje jejich API při každém načtení

let geyserCache = { data: null, fetchedAt: 0 };

async function fetchGeyserStats() {
    const now = Date.now();
    if (geyserCache.data && (now - geyserCache.fetchedAt) < GEYSER_CACHE_MS) {
        return geyserCache.data;
    }

    const query = `
        query ProjectBySlug($slug: String!) {
            project(where: { slug: $slug }) {
                name
                balance
                fundersCount
            }
        }
    `;

    try {
        const response = await axios.post(
            GEYSER_API_URL,
            { query, variables: { slug: GEYSER_PROJECT_SLUG } },
            { headers: { 'Content-Type': 'application/json' }, timeout: 8000 }
        );

        const project = response.data?.data?.project;
        if (!project) throw new Error('Projekt nenalezen v odpovědi Geyser API (možná se změnila struktura odpovědi).');

        const result = {
            available: true,
            amountSats: typeof project.balance === 'number' ? project.balance : 0,
            fundersCount: typeof project.fundersCount === 'number' ? project.fundersCount : null
        };
        geyserCache = { data: result, fetchedAt: now };
        return result;
    } catch (error) {
        console.error('Geyser API nedostupné nebo se změnila jeho struktura:', error.response?.data || error.message);
        const fallback = { available: false };
        geyserCache = { data: fallback, fetchedAt: now };
        return fallback;
    }
}

// Veřejný endpoint pro transparentní přehled - kombinuje historický součet plateb
// z appky (all-time, nepodléhá měsíčnímu resetu) s aktuální částkou z Geyseru.
app.get('/api/transparency', async (req, res) => {
    try {
        const appTotalResult = await pool.query(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM invoices WHERE status = 'paid' AND source = 'app'"
        );
        const appTotal = parseInt(appTotalResult.rows[0].total, 10);

        const geyser = await fetchGeyserStats();

        res.json({ appTotal, geyser });
    } catch (err) {
        console.error('Chyba v /api/transparency:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`Server běží na http://localhost:${PORT}`));

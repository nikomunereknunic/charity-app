require('dotenv').config();
const express = require('express');
const axios = require('axios');
const pool = require('./database.js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const LIGHTNING_ADDRESS = process.env.LIGHTNING_ADDRESS || 'morosewhip243@walletofsatoshi.com';
const PORT = process.env.PORT || 3000;

if (!LIGHTNING_ADDRESS) {
    console.warn('\n⚠️  LIGHTNING_ADDRESS není nastavena.\n');
}

function lightningAddressToUrl(address) {
    const [name, domain] = address.split('@');
    return `https://${domain}/.well-known/lnurlp/${name}`;
}

app.get('/api/needs', async (req, res) => {
    try {
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

        await pool.query("INSERT INTO invoices (payment_hash, amount, need_id, status) VALUES ($1, $2, $3, 'pending')",
            [payment_id, amount, needId]);

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

app.listen(PORT, () => console.log(`Server běží na http://localhost:${PORT}`));

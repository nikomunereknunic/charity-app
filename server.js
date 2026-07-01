require('dotenv').config();
const express = require('express');
const axios = require('axios');
const pool = require('./database.js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const LNBITS_API_URL = process.env.LNBITS_API_URL || 'https://legend.lnbits.com/api/v1';
const LNBITS_API_KEY = process.env.LNBITS_API_KEY;
const PORT = process.env.PORT || 3000;

if (!LNBITS_API_KEY || LNBITS_API_KEY === 'vlozte_svuj_invoice_klic_sem') {
    console.warn('\n⚠️  LNBITS_API_KEY není nastaven.\n');
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

        const lnbitsResponse = await axios.post(`${LNBITS_API_URL}/invoices`, {
            out: false, amount, memo: `Příspěvek na potřebu č. ${needId}`
        }, { headers: { 'X-Api-Key': LNBITS_API_KEY } });

        const { payment_hash, payment_request } = lnbitsResponse.data;
        await pool.query("INSERT INTO invoices (payment_hash, amount, need_id, status) VALUES ($1, $2, $3, 'pending')",
            [payment_hash, amount, needId]);

        res.json({ payment_request, payment_hash });
    } catch (error) {
        console.error("Chyba:", error.response?.data || error.message);
        res.status(502).json({ error: "Nepodařilo se vytvořit platbu." });
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

async function checkInvoices() {
    if (!LNBITS_API_KEY) return;
    try {
        const { rows } = await pool.query("SELECT payment_hash, amount, need_id FROM invoices WHERE status = 'pending'");
        for (const invoice of rows) {
            try {
                const r = await axios.get(`${LNBITS_API_URL}/payments/${invoice.payment_hash}`,
                    { headers: { 'X-Api-Key': LNBITS_API_KEY } });
                if (r.data.paid) {
                    await pool.query("UPDATE invoices SET status = 'paid' WHERE payment_hash = $1", [invoice.payment_hash]);
                    await pool.query("UPDATE needs SET current_amount = current_amount + $1 WHERE id = $2",
                        [invoice.amount, invoice.need_id]);
                }
            } catch {}
        }
    } catch {}
}

setInterval(checkInvoices, 10000);

app.listen(PORT, () => console.log(`Server běží na http://localhost:${PORT}`));

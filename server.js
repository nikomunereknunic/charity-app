// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const db = require('./database.js');

const app = express();
app.use(express.json());
app.use(express.static('public')); // servíruje soubory z adresáře 'public' (HTML, CSS, JS)

// --- KONFIGURACE ---
const LNBITS_API_URL = process.env.LNBITS_API_URL || 'https://legend.lnbits.com/api/v1';
const LNBITS_API_KEY = process.env.LNBITS_API_KEY;
const PORT = process.env.PORT || 3000;

if (!LNBITS_API_KEY || LNBITS_API_KEY === 'vlozte_svuj_invoice_klic_sem') {
    console.warn(
        '\n⚠️  LNBITS_API_KEY není nastaven (nebo je placeholder).\n' +
        '   Vytváření plateb nebude fungovat, dokud nevyplníte .env podle .env.example.\n'
    );
}

// --- API ENDPOINTS ---

// Vrátí všechny otevřené potřeby
app.get('/api/needs', (req, res) => {
    const sql = "SELECT id, title, target_amount, current_amount FROM needs WHERE status = 'open'";
    db.all(sql, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: "success", data: rows });
    });
});

// Vytvoří novou platební žádost (invoice) pro danou potřebu
app.post('/api/create-invoice', async (req, res) => {
    const amount = parseInt(req.body.amount, 10);
    const needId = parseInt(req.body.needId, 10);

    if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ error: "Částka musí být kladné celé číslo (v satoshi)." });
    }
    if (!Number.isInteger(needId)) {
        return res.status(400).json({ error: "Chybí nebo je neplatné ID potřeby." });
    }

    // Ověříme, že potřeba existuje a je stále otevřená
    db.get("SELECT id FROM needs WHERE id = ? AND status = 'open'", [needId], async (err, need) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!need) {
            return res.status(404).json({ error: "Tato potřeba neexistuje nebo už je uzavřená." });
        }

        try {
            // 1. Vytvoříme invoice v LNbits
            const lnbitsResponse = await axios.post(`${LNBITS_API_URL}/invoices`, {
                out: false,
                amount: amount,
                memo: `Příspěvek na potřebu č. ${needId}`
            }, {
                headers: { 'X-Api-Key': LNBITS_API_KEY }
            });

            const { payment_hash, payment_request } = lnbitsResponse.data;

            // 2. Uložíme platbu do naší databáze, abychom mohli sledovat její stav
            db.run(
                "INSERT INTO invoices (payment_hash, amount, need_id, status) VALUES (?, ?, ?, 'pending')",
                [payment_hash, amount, needId],
                (err) => {
                    if (err) console.error("Chyba při ukládání invoice do DB:", err.message);
                }
            );

            // 3. Vrátíme payment_request (pro QR kód) i payment_hash (pro sledování stavu) frontendu
            res.json({ payment_request, payment_hash });

        } catch (error) {
            console.error("Chyba při komunikaci s LNbits:", error.response?.data || error.message);
            res.status(502).json({ error: "Nepodařilo se vytvořit platbu u LNbits." });
        }
    });
});

// Frontend se přes tento endpoint dotazuje, jestli už byla konkrétní platba zaplacena
app.get('/api/invoice-status/:hash', (req, res) => {
    db.get(
        "SELECT status FROM invoices WHERE payment_hash = ?",
        [req.params.hash],
        (err, row) => {
            if (err || !row) {
                return res.json({ paid: false });
            }
            res.json({ paid: row.status === 'paid' });
        }
    );
});

// --- SLEDOVÁNÍ PLATEB NA POZADÍ ---
async function checkInvoices() {
    if (!LNBITS_API_KEY) return; // bez klíče nemá smysl se ptát LNbits

    db.all("SELECT payment_hash, amount, need_id FROM invoices WHERE status = 'pending'", [], async (err, rows) => {
        if (err || !rows.length) return;

        for (const invoice of rows) {
            try {
                const lnbitsResponse = await axios.get(`${LNBITS_API_URL}/payments/${invoice.payment_hash}`, {
                    headers: { 'X-Api-Key': LNBITS_API_KEY }
                });

                if (lnbitsResponse.data.paid) {
                    console.log(`Platba ${invoice.payment_hash} byla zaplacena (${invoice.amount} sat).`);

                    db.run("UPDATE invoices SET status = 'paid' WHERE payment_hash = ?", [invoice.payment_hash]);
                    db.run(
                        "UPDATE needs SET current_amount = current_amount + ? WHERE id = ?",
                        [invoice.amount, invoice.need_id]
                    );
                }
            } catch (error) {
                // LNbits o invoice třeba ještě neví, nebo došlo k jiné chybě — zkusíme to znovu při dalším tiku
            }
        }
    });
}

setInterval(checkInvoices, 10000);

// --- SPUŠTĚNÍ SERVERU ---
app.listen(PORT, () => {
    console.log(`Server běží na http://localhost:${PORT}`);
});

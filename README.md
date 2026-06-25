# Charity App ⚡

Jednoduchý systém pro sbírky na konkrétní potřeby, placené přes Bitcoin Lightning (LNbits).

## Co je uvnitř

- `server.js` — Express server, API a sledování plateb na pozadí
- `database.js` — SQLite databáze (tabulky `needs` a `invoices`)
- `seed.js` — vloží pár ukázkových potřeb, aby šlo aplikaci hned vyzkoušet
- `public/index.html` — frontend (seznam potřeb, QR kód platby, sledování stavu)
- `.env.example` — vzor konfiguračního souboru

## Instalace

1. Rozbalte projekt a otevřete jeho složku v terminálu.
2. Nainstalujte závislosti:
   ```
   npm install
   ```
3. Vytvořte vlastní konfiguraci:
   ```
   cp .env.example .env
   ```
   Otevřete `.env` a vyplňte:
   - `LNBITS_API_URL` — adresa vaší LNbits instance (např. `https://legend.lnbits.com/api/v1`)
   - `LNBITS_API_KEY` — váš **Invoice key** z LNbits (Wallet → ikona klíče → API info)

   Klíč nikdy nesdílejte ani nenahrávejte do veřejného repozitáře.

4. Vložte pár ukázkových potřeb do databáze:
   ```
   npm run seed
   ```
5. Spusťte server:
   ```
   npm start
   ```
6. Otevřete v prohlížeči:
   ```
   http://localhost:3000
   ```

## Jak to funguje

- Frontend si z `/api/needs` natáhne otevřené potřeby a zobrazí je s ukazatelem postupu.
- Po kliknutí na „Podpořit" a výběru částky frontend zavolá `/api/create-invoice`, server vytvoří Lightning fakturu v LNbits a vrátí `payment_request` (pro QR kód) a `payment_hash`.
- Frontend každé 3 s kontroluje `/api/invoice-status/:hash`. Server zase každých 10 s na pozadí kontroluje u LNbits, jestli byly faktury zaplaceny, a pokud ano, připočítá částku k dané potřebě.

## Přidání nové potřeby

Zatím nejjednodušší cestou je přímý zápis do databáze, např. přes `sqlite3` CLI:
```sql
INSERT INTO needs (title, target_amount) VALUES ('Nová potřeba', 100000);
```
(Případné admin rozhraní pro správu potřeb z webu lze doplnit jako další krok.)

## Nasazení do produkce

Pro reálné použití doporučujeme:
- Provozovat aplikaci za HTTPS (např. přes reverzní proxy s Caddy/Nginx).
- Místo veřejné LNbits instance zvážit vlastní instalaci (RaspiBlitz/Umbrel/StartOS) pro plnou kontrolu nad prostředky.
- Zálohovat soubor `charity.db`.

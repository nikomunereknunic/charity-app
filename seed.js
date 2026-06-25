// seed.js
// Vloží pár ukázkových potřeb, pokud je tabulka prázdná.
// Spustit: npm run seed

const db = require('./database.js');

const sampleNeeds = [
    { title: "Zimní bundy pro azylový dům", target_amount: 50000 },
    { title: "Oprava střechy komunitního centra", target_amount: 250000 },
    { title: "Léky pro útulek pro zvířata", target_amount: 30000 }
];

db.serialize(() => {
    db.get("SELECT COUNT(*) as count FROM needs", [], (err, row) => {
        if (err) {
            console.error("Chyba při čtení tabulky:", err.message);
            process.exit(1);
        }

        if (row.count > 0) {
            console.log(`Tabulka 'needs' už obsahuje ${row.count} záznam(ů), nic nepřidávám.`);
            process.exit(0);
        }

        const stmt = db.prepare("INSERT INTO needs (title, target_amount) VALUES (?, ?)");
        sampleNeeds.forEach(n => stmt.run(n.title, n.target_amount));
        stmt.finalize(() => {
            console.log(`Vloženo ${sampleNeeds.length} ukázkových potřeb.`);
            process.exit(0);
        });
    });
});

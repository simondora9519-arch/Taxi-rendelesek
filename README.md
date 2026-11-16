# Céges Rendelések – Taxi

Webes alkalmazás céges taxirendelések rögzítésére. PC-n, telefonon és táblagépen is működik.

## Indítás saját gépen (próba)

1. Telepítse a Node.js-t (18-as vagy újabb): https://nodejs.org
2. Ebben a mappában futtassa: `node server.js`
3. Nyissa meg a böngészőben: http://localhost:3000

Első belépés: **admin / admin123**. Belépés után azonnal változtassa meg (bal alul: *Jelszó módosítása*), majd a *Felhasználók kezelése* menüben vegye fel a kollégákat.

## Online elérhetővé tétel

Bármely Node.js-t támogató tárhelyen fut (pl. Render.com, Railway, saját VPS):

- Indító parancs: `node server.js`
- A `PORT` környezeti változót a tárhely adja.
- Opcionális: `ADMIN_PASSWORD` – az első admin jelszava (csak az első indításkor számít).
- Opcionális: `DATA_DIR` – hova mentse az adatokat. **Állandó (persistent) tárhelyre mutasson**, különben újraindításkor elveszhetnek az adatok.
- Éles használatnál HTTPS-en keresztül érje el (a felsorolt tárhelyek ezt automatikusan adják).

## Adatok, mentés

Minden adat a `data/db.json` fájlban van. Biztonsági mentéshez elég ezt a fájlt rendszeresen lemásolni.

## Funkciók

- Felhasználónév + jelszó, „Emlékezzen rám” (30 napig bent marad), a böngésző jelszókezelője is megjegyzi
- Egyszerre több felhasználó; a változások **frissítés nélkül, azonnal** megjelennek mindenkinél
- Bal menü: év → hónap → nap, a napok mellett a rendelések száma, hétvégék kiemelve
- Új év hozzáadása: hónapok, napok automatikusan (szökőév is)
- Minden dátumnak saját oldala (könyvjelzőzhető címmel, pl. `#/2027-01-15`), előző/következő nap gomb
- Rendelés adatai: időpont (óra, perc), kiinduló és érkezési helyszín, leadás dátuma, ki adta le, cég, fizetési mód (készpénz / bankkártya / utalás), megjegyzés
- Szerkesztés, törlés; látszik, ki rögzítette és ki módosította
- Magyar nyelv, hétfővel kezdődő európai naptár, Europe/Budapest időzóna

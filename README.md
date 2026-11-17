# Céges Rendelések – Taxi (teljes verzió)

Online taxis rendelésrögzítő. PC-n, telefonon és táblagépen is működik, egyszerre többen használhatják.

Az adatok egy **MongoDB Atlas** adatbázisban vannak, ezért az ingyenes tárhely újraindulásakor sem vesznek el.

---

## 1. Beállítások a Renderen (környezeti változók)

| Név | Érték | Kötelező |
|---|---|---|
| `MONGODB_URI` | a MongoDB Atlas kapcsolati string | **igen** |
| `SESSION_SECRET` | hosszú véletlen szöveg (pl. 40+ karakter) | ajánlott |
| `ADMIN_USER` | admin felhasználónév (alap: `admin`) | nem |
| `ADMIN_PASSWORD` | az admin jelszava (alap: `admin123`) | igen, első indításnál |
| `ADMIN_EMAIL` | ide megy a jelszó-emlékeztető | nem |
| `BREVO_API_KEY` | Brevo API kulcs a levelekhez | a levélküldéshez |
| `MAIL_FROM` | feladó e-mail (Brevo-ban hitelesített cím) | a levélküldéshez |
| `PUBLIC_URL` | pl. `https://taxi-rendelesek.onrender.com` | ajánlott |
| `TRUST_PROXY` | `1` | ajánlott Renderen |

**Build Command:** `npm install` · **Start Command:** `node server.js`

> Az `ADMIN_PASSWORD` csak az első indításkor számít, amikor az admin létrejön. Utána a jelszót a Beállítások menüben lehet cserélni, és a környezeti változót törölni érdemes.

## 2. MongoDB Atlas (ingyenes)

1. Regisztrálj a https://cloud.mongodb.com oldalon.
2. **Create** → **M0 Free** csomag, régió: Frankfurt (legközelebb).
3. **Database Access** → új felhasználó jelszóval (ezt jegyezd meg).
4. **Network Access** → **Add IP Address** → `0.0.0.0/0` (a Render címét nem lehet előre tudni).
5. **Connect** → **Drivers** → másold ki a stringet: `mongodb+srv://...`
6. Ezt írd be a Renderen a `MONGODB_URI` értékének, a jelszót a sajátoddal helyettesítve.

## 3. Brevo (ingyenes e-mail, napi 300 levél)

1. Regisztrálj a https://www.brevo.com oldalon.
2. **Senders & IP** → vedd fel és hitelesítsd a feladó címet (pl. citytaxifehervar@cititaxfehervar.hu).
3. **SMTP & API** → **API Keys** → új kulcs. Ezt írd a `BREVO_API_KEY` értékének.
4. A `MAIL_FROM` legyen ugyanaz a hitelesített cím.

Ha nincs Brevo kulcs, a program akkor is működik: a jelszó-emlékeztető levél helyett a szerver naplójába írja a visszaállítási hivatkozást (Render → Logs).

## 4. Napi automatikus, titkosított mentés (ingyenes)

A `.github/workflows/backup.yml` fájl minden nap hajnali 3-kor titkosított mentést készít az adatbázisról, és elmenti a GitHub-tárhelyedbe.

Szükséges beállítások a GitHubon: **Settings → Secrets and variables → Actions → New repository secret**

| Titok | Érték |
|---|---|
| `MONGODB_URI` | ugyanaz a kapcsolati string |
| `BACKUP_PASSPHRASE` | hosszú, véletlen jelszó a titkosításhoz |

A mentések titkosítva (AES-256) a `backups` ágban jelennek meg, 90 napig. Visszaállítás:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -in mentes.enc -out mentes.json -pass pass:A_JELSZAVAD
# majd: mongoimport --uri "<MONGODB_URI>" --collection kartoteka --file mentes.json --jsonArray
```

## 5. Biztonság

- Jelszavak **bcrypt** (12 kör) hash-el, sima jelszó soha nem kerül az adatbázisba.
- Süti: `HttpOnly`, `SameSite=Strict`, éles környezetben `Secure` (HTTPS kötelező).
- Session: aláírt, 2 óra inaktivitás után automatikus kijelentkezés; „Emlékezzen rám” esetén legfeljebb 30 nap.
- Bejelentkezés elleni védelem: 5 hibás próbálkozás után az adott IP és felhasználó 30 percre tiltva, emellett óránként 10 kísérlet/IP.
- Jelszó-emlékeztető: egyszer használatos, 1 óráig érvényes hivatkozás e-mailben.
- Biztonsági fejlécek: CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options`, HSTS.

## 6. Amit tud

- Bal menü: év → hónap → nap; minden dátumnak saját oldala (`#/2027-01-15`).
- Egy nap oldalán kompakt sorokban, időrendben a rendelések és az időponthoz kötött megjegyzések; a napra szóló megjegyzés a lap tetején.
- Rendelés: időpont, indulás, érkezés, megállók, utasok, leadás dátuma, ki adta le, cég, fizetés (Készpénz, Bankkártya, Utalás, Amex, Menetlevél, WBS), taxiszám, szín, értesítés, megjegyzés.
- „Ellenőrizve” és „Hívtam” pipa; a taxiszámra duplán kattintva félkövér lesz (kiküldött fuvar).
- Színek jelöléssel (halvány kék/piros/sárga/szürke), a Beállításokban bővíthető.
- Mezőnkénti „mod.” jelölés: a módosított adat szürke lesz, és külön előzmény írható hozzá (dátum, ki kérte, mi változott) – ez a rendelésre kattintva nyílik le.
- Sokszorosítás: ugyanaz a rendelés 2–10 példányban, teljesen külön rendelésként.
- Kereső az egész évre (cég, leadó, cím, utas, taxiszám), leadási/teljesítési dátum szűrővel, időrendben.
- **Infók** menü: dátumhoz kötött megjegyzések saját keresővel.
- Értesítés: a beállított időpont előtt (óra, perc) hangjelzés, ha az oldal nyitva van (tálcára téve is). Teljesen zárt böngészőnél nem jelez.

const config = require("./config.json");
const admin = require("firebase-admin");
const axios = require("axios");

const { onRequest } = require("firebase-functions/v2/https");
const cors = require("cors");
const express = require("express");

admin.initializeApp();

const APPSHEET_API_KEY = config.APPSHEET_API_KEY;
const APPSHEET_APP_ID = config.APPSHEET_APP_ID;

if (!APPSHEET_API_KEY || !APPSHEET_APP_ID) {
    console.error("❌ Chybí API klíč nebo App ID! Ověř soubor `config.json`.");
    process.exit(1);
}

// ✅ Webhook přijímá změny z AppSheet a ukládá je do globální proměnné
const webhookApp = express();
webhookApp.use(cors({ origin: true }));
webhookApp.use(express.json());

webhookApp.post("/", async (req, res) => {
    try {
        console.log("📩 Příchozí data z AppSheet:", req.body);

        if (req.body.rowId) {
            refreshStatus = { type: "update", rowId: req.body.rowId }; // ✅ Uložíme změnu do paměti
            console.log("🔄 Nastaven nový refresh status:", refreshStatus);
        }

        res.status(200).json({ message: "✅ Webhook přijal data úspěšně!" });
    } catch (error) {
        console.error("❌ Chyba při zpracování webhooku:", error.message);
        res.status(500).json({ error: error.message });
    }
});

exports.webhook = onRequest(webhookApp);

// ✅ Funkce pro kontrolu změn (vrací status a resetuje ho)
let refreshStatus = { type: "none", rowId: null }; // ✅ Paměťová proměnná pro sledování změn

exports.checkRefreshStatus = onRequest((req, res) => {
    res.set("Access-Control-Allow-Origin", "*");

    console.log("🔍 Kontroluji refresh status:", refreshStatus);

    if (refreshStatus.type === "update") {
        console.log("✅ Aktualizace detekována, resetuji status...");
        const response = { ...refreshStatus };
        refreshStatus = { type: "none", rowId: null }; // ✅ Resetujeme po přečtení
        return res.status(200).json(response);
    }

    return res.status(200).json({ type: "none", rowId: null });
});

// ✅ Funkce pro převod datumu
function convertDateFormat(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split("/");
    if (parts.length !== 3) {
        console.warn(`⚠️ Neznámý formát datumu: ${dateStr}`);
        return null;
    }
    const [month, day, year] = parts;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

// ✅ Fetch AppSheet Data
exports.fetchAppSheetData = onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(204).send("");
    }

    try {
        console.log("🔍 Spouštím fetchAppSheetData...");

        // 🟢 Fetchujeme uživatele party
        const partyUrl = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/Uživatelé%20party/Find`;
        console.log(`📡 Požadavek na party: ${partyUrl}`);

        const partyResponse = await axios.post(partyUrl, { "Select": ["Row ID", "Parta", "HEX"] }, {
            headers: { "ApplicationAccessKey": APPSHEET_API_KEY }
        });

        console.log("✅ Odpověď z API (party):", JSON.stringify(partyResponse.data, null, 2));

        const partyMap = {};
        if (partyResponse.data && Array.isArray(partyResponse.data)) {
            partyResponse.data.forEach(party => {
                if (party["Row ID"]) {
                    partyMap[party["Row ID"]] = {
                        name: party.Parta || "Neznámá parta",
                        color: party.HEX || "#145C7E"
                    };
                }
            });
        }

        // 🟢 Fetchujeme data z tabulky "Zadání"
        const zadaniUrl = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/Zadání/Find`;
        console.log(`📡 Požadavek na zadání: ${zadaniUrl}`);

        const zadaniResponse = await axios.post(zadaniUrl, { "Select": ["Row ID", "Obec", "Datum", "Parta", "Odeslané", "Hotové", "Předané", "Detail"] }, {
            headers: { "ApplicationAccessKey": APPSHEET_API_KEY }
        });

        console.log("✅ Odpověď z API (zadání):", JSON.stringify(zadaniResponse.data, null, 2));

        if (!zadaniResponse.data || !Array.isArray(zadaniResponse.data)) {
            console.warn("⚠️ Žádné záznamy v Zadání!");
            return res.status(200).json({ events: [], partyMap });
        }

        // 🟢 Mapujeme události
        const events = zadaniResponse.data.map(record => ({
            id: record["Row ID"],
            title: record.Obec || "Neznámá obec",
            start: convertDateFormat(record.Datum),
            color: (partyMap[record.Parta] || {}).color || "#145C7E",
            party: record.Parta,
            extendedProps: {
                odeslane: record.Odeslané === "Y",
                hotove: record.Hotové === "Y",
                predane: record.Předané === "Y",
                detail: record.Detail || ""
            }
        }));

        console.log("📌 Události do kalendáře:", JSON.stringify(events, null, 2));

        return res.status(200).json({ events, partyMap });

    } catch (error) {
        console.error("❌ Chyba při načítání z AppSheet:", error.response?.data || error.message);
        return res.status(500).json({ error: error.response?.data || error.message });
    }
});


// ✅ Přidání nového záznamu do AppSheet
exports.addToAppSheet = onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method !== "POST") {
        return res.status(405).send("Pouze POST metoda je povolena.");
    }

    try {
        console.log("📨 Příchozí data:", req.body);

        const requestData = {
            Action: "Add",
            Properties: { Locale: "en-US" },
            Rows: [{
                "Obec": req.body.Obec || "Neznámá obec",
                "Datum": req.body.Datum || new Date().toISOString(),
                "Parta": req.body.Parta || "Neznámá parta",
                "Činnost": Array.isArray(req.body.Činnost) ? req.body.Činnost : [req.body.Činnost],
                "Detail": req.body.Detail || ""
            }]
        };

        const response = await axios.post(
            `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/Zadání/Action`,
            requestData, { headers: { "ApplicationAccessKey": APPSHEET_API_KEY } }
        );

        console.log("✅ Úspěšná odpověď z AppSheet:", response.data);
        return res.status(200).json({ message: "Záznam úspěšně přidán do AppSheet!", response: response.data });

    } catch (error) {
        console.error("❌ Chyba při volání AppSheet API:", error.response?.data || error.message);
        return res.status(500).json({ error: error.response?.data || error.message });
    }
});

// ✅ Aktualizace existujícího záznamu v AppSheet
exports.updateAppSheetEvent = onRequest(async (req, res) => {
    console.log("📨 Příchozí data:", req.body);

    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(204).send("");
    }

    try {
        const { rowId, Datum, Parta } = req.body;

        if (!rowId) {
            console.error("❌ Chybí rowId!", req.body);
            return res.status(400).json({ error: "❌ Chybí rowId" });
        }

        console.log("✅ Přijaté hodnoty:", { rowId, Datum, Parta });

        const requestData = {
            Action: "Edit",
            Rows: [{ "Row ID": rowId, Datum, Parta }]
        };

        console.log("📡 Odesílám data do AppSheet:", requestData);

        const response = await axios.post(
            `https://api.appsheet.com/api/v2/apps/${config.APPSHEET_APP_ID}/tables/Zadání/Action`,
            requestData,
            { headers: { "ApplicationAccessKey": config.APPSHEET_API_KEY } }
        );

        console.log("✅ Odpověď z AppSheet:", response.data);
        return res.status(200).json({ message: "Záznam úspěšně aktualizován!", response: response.data });
    } catch (error) {
        console.error("❌ Chyba při volání AppSheet API:", error.response?.data || error.message);
        return res.status(500).json({ error: error.response?.data || error.message });
    }
});

// ✅ CORS Handler
exports.corsHandler = onRequest((req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(204).send("");
    }

    res.status(400).send("Neplatná žádost");
});

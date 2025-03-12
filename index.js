const { onRequest } = require("firebase-functions/v2/https");
const cors = require("cors")({ origin: true });
const config = require("./config.json");
const admin = require("firebase-admin");
const axios = require("axios");
const express = require("express");

admin.initializeApp();

const APPSHEET_API_KEY = config.APPSHEET_API_KEY;
const APPSHEET_APP_ID = config.APPSHEET_APP_ID;

if (!APPSHEET_API_KEY || !APPSHEET_APP_ID) {
    console.error("❌ Chybí API klíč nebo App ID! Ověř soubor `config.json`.");
    process.exit(1);
}

// Globální proměnná pro refresh
let refreshStatus = { type: "none", rowId: null };

// Webhook (Express)
const webhookApp = express();
webhookApp.use(cors);
webhookApp.use(express.json());

webhookApp.post("/", async (req, res) => {
    if (req.body.rowId) {
        refreshStatus = { type: "update", rowId: req.body.rowId };
    }
    res.status(200).json({ message: "✅ Webhook přijal data úspěšně!" });
});
exports.webhook = onRequest(webhookApp);

// Check Refresh Status
exports.checkRefreshStatus = onRequest((req, res) => {
    cors(req, res, () => {
        res.set("Access-Control-Allow-Origin", "*");
        if (refreshStatus.type === "update") {
            const response = { ...refreshStatus };
            refreshStatus = { type: "none", rowId: null };
            return res.status(200).json(response);
        }
        return res.status(200).json({ type: "none", rowId: null });
    });
});

// Helper pro datum
function convertDateFormat(dateStr) {
    if (!dateStr) return null;
    const [month, day, year] = dateStr.split("/");
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

// Fetch data z AppSheet
exports.fetchAppSheetData = onRequest(async (req, res) => {
    cors(req, res, async () => {
        res.set("Access-Control-Allow-Origin", "*");
        try {
            const [partyResponse, zadaniResponse] = await Promise.all([
                axios.post(`https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/Uživatelé%20party/Find`, {
                    "Select": ["Row ID", "Parta", "HEX"]
                }, { headers: { "ApplicationAccessKey": APPSHEET_API_KEY } }),
                axios.post(`https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/Zadání/Find`, {
                    "Select": ["Row ID", "Obec", "Datum", "Parta", "Odeslané", "Hotové", "Předané", "Detail"]
                }, { headers: { "ApplicationAccessKey": APPSHEET_API_KEY } })
            ]);

            const partyMap = {};
            partyResponse.data.forEach(party => {
                partyMap[party["Row ID"]] = {
                    name: party.Parta || "Neznámá parta",
                    color: party.HEX || "#145C7E"
                };
            });

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

            return res.status(200).json({ events, partyMap });
        } catch (error) {
            return res.status(500).json({ error: error.response?.data || error.message });
        }
    });
});

// Přidání nového záznamu do AppSheet
exports.addToAppSheet = onRequest(async (req, res) => {
    cors(req, res, async () => {
        res.set("Access-Control-Allow-Origin", "*");
        if (req.method !== "POST") {
            return res.status(405).send("Pouze POST metoda je povolena.");
        }
        try {
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
            return res.status(200).json({ message: "✅ Záznam přidán!", response: response.data });
        } catch (error) {
            return res.status(500).json({ error: error.response?.data || error.message });
        }
    });
});

// Aktualizace existujícího záznamu v AppSheet
exports.updateAppSheetEvent = onRequest(async (req, res) => {
    cors(req, res, async () => {
        res.set("Access-Control-Allow-Origin", "*");
        try {
            const { rowId, Datum, Parta } = req.body;
            if (!rowId) {
                return res.status(400).json({ error: "❌ Chybí rowId" });
            }
            const requestData = {
                Action: "Edit",
                Rows: [{ "Row ID": rowId, Datum, Parta }]
            };
            const response = await axios.post(
                `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/Zadání/Action`,
                requestData, { headers: { "ApplicationAccessKey": APPSHEET_API_KEY } }
            );
            return res.status(200).json({ message: "✅ Záznam aktualizován!", response: response.data });
        } catch (error) {
            return res.status(500).json({ error: error.response?.data || error.message });
        }
    });
});

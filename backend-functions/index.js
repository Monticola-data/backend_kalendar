const { onRequest } = require("firebase-functions/v2/https");
const { onValueCreated } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors")({ origin: true });
const axios = require("axios");
const config = require("./config.json");

// ✅ Definitivně správná inicializace
const app = !admin.apps.length 
    ? admin.initializeApp({
        credential: admin.credential.cert("./service-account.json"),
        databaseURL: "https://kalendar-831f8-default-rtdb.firebaseio.com"
    }) 
    : admin.app();

// ✅ Správné explicitní získání reference na databázi přes app
const db = admin.database(app);

const APPSHEET_API_KEY = config.APPSHEET_API_KEY;
const APPSHEET_APP_ID = config.APPSHEET_APP_ID;

if (!APPSHEET_API_KEY || !APPSHEET_APP_ID) {
    console.error("❌ Chybí API klíč nebo App ID! Ověř soubor `config.json`.");
    process.exit(1);
}

const webhookApp = express();
webhookApp.use(cors);
webhookApp.use(express.json());

let refreshStatus = { type: "none", rowId: null };

exports.webhook = onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");

    const rowId = req.body.Data?.["Row ID"] || req.body.rowId;

    if (rowId) {
        try {
            await db.ref("webhookQueue").push({
                rowId,
                status: "waiting",
                timestamp: admin.database.ServerValue.TIMESTAMP
            });
            console.log("✅ Data ihned vložena do fronty.");
        } catch (error) {
            console.error("❌ Chyba ukládání do fronty:", error);
            return res.status(500).send("Chyba ukládání dat.");
        }
    } else {
        console.warn("⚠️ Chybí rowId v požadavku:", req.body);
        return res.status(400).send("Chybí rowId.");
    }

    return res.status(200).send("Webhook data přijata.");
});



exports.processWebhookQueue = onValueCreated("/webhookQueue/{pushId}", async (event) => {
    const data = event.data.val();
    const rowId = data.rowId;

    try {
        await db.ref("refreshStatus").set({
            type: "update",
            rowId,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });

        console.log("✅ refreshStatus aktualizován asynchronně:", rowId);
        await event.data.ref.update({ status: "done" });
    } catch (error) {
        console.error("❌ Chyba při asynchronním zpracování:", error);
        await event.data.ref.update({ status: "error", error: error.message });
    }
});




exports.checkRefreshStatus = onRequest(async (req, res) => { 
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(204).send("");
    }

    const snapshot = await db.ref("refreshStatus").once("value");
    const refreshStatus = snapshot.val();

    if (refreshStatus?.type === "update") {
        await db.ref("refreshStatus").remove(); // reset stavu
        return res.status(200).json(refreshStatus);
    }
    return res.status(200).json({ type: "none", rowId: null });
});



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




exports.fetchAppSheetData = onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(204).send("");
    }

    try {
        const partyUrl = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/Uživatelé%20party/Find`;
        const partyResponse = await axios.post(partyUrl, { "Select": ["Row ID", "Parta", "HEX"] }, {
            headers: { "ApplicationAccessKey": APPSHEET_API_KEY }
        });

        const partyMap = {};
        partyResponse.data.forEach(party => {
            if (party["Row ID"]) {
                partyMap[party["Row ID"]] = {
                    name: party.Parta || "Neznámá parta",
                    color: party.HEX || "#145C7E"
                };
            }
        });

        const zadaniUrl = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/Zadání/Find`;
        
        // ✅ přidán sloupec SECURITY_filter
        const zadaniResponse = await axios.post(zadaniUrl, { 
            "Select": ["Row ID", "Obec", "Datum", "Parta", "Odeslané", "Hotové", "Předané", "Detail", "SECURITY_filter"]
        }, {
            headers: { "ApplicationAccessKey": APPSHEET_API_KEY }
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
                detail: record.Detail || "",
                SECURITY_filter: record.SECURITY_filter || []  // ✅ toto je nově přidáno!
            }
        }));

        return res.status(200).json({ events, partyMap });
    } catch (error) {
        console.error("❌ Chyba při načítání dat z AppSheet:", error);
        return res.status(500).json({ error: error.response?.data || error.message });
    }
});




exports.addToAppSheet = onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type");

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

        return res.status(200).json({ message: "Záznam úspěšně přidán do AppSheet!", response: response.data });
    } catch (error) {
        return res.status(500).json({ error: error.response?.data || error.message });
    }
});





exports.updateAppSheetEvent = onRequest(async (req, res) => {
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




exports.corsHandler = onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(204).send("");
    }

    res.status(400).send("Neplatná žádost");
});



exports.testWrite = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  try {
    await db.ref("testPath").set({
      test: "Hello world!",
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
    console.log("✅ Testovací data úspěšně zapsána do RTDB");
    return res.status(200).send("Data úspěšně zapsána.");
  } catch (error) {
    console.error("❌ Chyba při zápisu:", error);
    return res.status(500).send("Chyba: " + error.message);
  }
});


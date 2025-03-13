const axios = require("axios");

// 🔹 Vlož sem svoje API klíče (nebo použij `.env`)
const APPSHEET_API_KEY = "V2-ly0gj-TjATe-RmTTa-QWPCw-bzru6-i5nnv-TpFGM-1SuuC";
const APPSHEET_APP_ID = "9fa4fd9c-be17-4052-b233-5918fe452998";
const APPSHEET_TABLE = "Zadání";

const fetchAppSheetData = async () => {
    try {
        console.log("🔍 Spouštím fetchAppSheetData...");

        const partyMap = {};

        // 🔹 Načtení seznamu party
        const partyUrl = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/Uživatelé%20party/Find`;
        console.log(`📡 Fetching party data from: ${partyUrl}`);

        const partyResponse = await axios.post(partyUrl, {
            "Select": ["Row ID", "Parta", "HEX"]
        }, {
            headers: { "ApplicationAccessKey": APPSHEET_API_KEY }
        });

        if (partyResponse.data && Array.isArray(partyResponse.data)) {
            partyResponse.data.forEach(party => {
                if (party["Row ID"]) {
                    partyMap[party["Row ID"]] = {
                        name: party.Parta || "Neznámá parta",
                        color: party.HEX || "#145C7E"
                    };
                }
            });
        } else {
            console.warn("⚠️ `partyResponse.data` je prázdné nebo nevalidní.");
        }

        console.log("🎨 Party Map keys:", Object.keys(partyMap));

        // 🔹 Načtení seznamu zakázek
        const zadaniUrl = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/Zadání/Find`;
        console.log(`📡 Fetching zakázky data from: ${zadaniUrl}`);

        const zadaniResponse = await axios.post(zadaniUrl, {
            "Select": ["Row ID", "Obec", "Datum", "Parta", "Odeslané", "Hotové", "Předané", "Detail"]
        }, {
            headers: { "ApplicationAccessKey": APPSHEET_API_KEY }
        });

        if (!zadaniResponse.data || !Array.isArray(zadaniResponse.data) || zadaniResponse.data.length === 0) {
            console.warn("⚠️ Žádné záznamy v Zadání!");
            return;
        }

        // 🔹 Výpis dat do konzole přesně tak, jak je API posílá
        zadaniResponse.data.forEach(record => {
            console.log("📡 Původní data z API:", record);
        });

        console.log("✅ Data byla úspěšně načtena, nyní je můžeme analyzovat.");

    } catch (error) {
        console.error("❌ Chyba při načítání z AppSheet:", error.response?.data || error.message);
    }
};

// 🔥 Spuštění testovací funkce
fetchAppSheetData();

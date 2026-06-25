const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

const SCRAPER_VERSION = "1.0.0"; 

puppeteer.use(StealthPlugin());

function parsePrydwenDate(dateStr) {
    if (!dateStr) return new Date(0);
    if (dateStr.includes('-') && !isNaN(Date.parse(dateStr))) {
        return new Date(dateStr);
    }
    const months = {
        January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
        July: 6, August: 7, September: 8, October: 9, November: 10, December: 11
    };
    const parts = dateStr.split('/');
    if (parts.length !== 3) return new Date(0);
    
    const day = parseInt(parts[0], 10);
    const month = months[parts[1]];
    const year = parseInt(parts[2], 10);
    
    if (month === undefined || isNaN(day) || isNaN(year)) return new Date(0);
    return new Date(year, month, day);
}

function formatToPrydwenDate(dateInput) {
    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) {
        const now = new Date();
        return `${now.getDate()}/${months[now.getMonth()]}/${now.getFullYear()}`;
    }
    return `${d.getDate()}/${months[d.getMonth()]}/${d.getFullYear()}`;
}

function extractJsonArray(html, keyName) {
    const regex = new RegExp(`\\\\*"${keyName}\\\\*"\\s*:\\s*\\\\*(\\[)`);
    const match = html.match(regex);
    if (!match) return null;
    
    const startIdx = html.indexOf('[', match.index + keyName.length);
    if (startIdx === -1) return null;
    
    let bracketCount = 0;
    let endIdx = -1;
    let inString = false;
    let escape = false;
    
    for (let i = startIdx; i < html.length; i++) {
        const char = html[i];
        if (char === '"' && !escape) {
            inString = !inString;
        }
        if (char === '\\' && inString) {
            escape = !escape;
        } else {
            escape = false;
        }
        if (!inString) {
            if (char === '[') bracketCount++;
            else if (char === ']') {
                bracketCount--;
                if (bracketCount === 0) {
                    endIdx = i;
                    break;
                }
            }
        }
    }
    
    if (endIdx === -1) return null;
    const rawStr = html.substring(startIdx, endIdx + 1);
    
    let cleanStr = rawStr;
    for (let iter = 0; iter < 5; iter++) {
        try {
            return JSON.parse(cleanStr);
        } catch (e) {
            cleanStr = cleanStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
    }
    try { return JSON.parse(cleanStr); } catch (e) { return null; }
}

function normalizeExtractedArray(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(item => {
        if (typeof item === 'string') {
            try {
                if (item.trim().startsWith('{')) return JSON.parse(item);
            } catch (e) {}
        }
        return item;
    });
}

function extractUpdateDate(html) {
    const match = html.match(/(?:\\"last_updated\\"|\\"updated_at\\"|["']last_updated["']|["']updated_at["'])\s*:\s*\\?"([^\\"]+)\\?"/);
    if (match) {
        const val = match[1];
        if (val.split('/').length === 3 && isNaN(Number(val.split('/')[1]))) return val;
        return formatToPrydwenDate(val);
    }
    const visibleMatch = html.match(/Last updated:\s*([A-Za-z0-9\s,]+)/i);
    if (visibleMatch) return formatToPrydwenDate(visibleMatch[1].trim());
    return formatToPrydwenDate(new Date());
}

async function runScraper() {
    console.log(`Starting ZZZ Scraper Core v${SCRAPER_VERSION}...`);
    
    const outputPath = path.join(process.cwd(), 'characters.json');
    let oldRosterMap = new Map();
    let forceFullUpdate = false;

    if (fs.existsSync(outputPath)) {
        try {
            const oldData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
            const oldVersion = oldData.version || "1.0";
            if (oldVersion !== SCRAPER_VERSION) {
                console.log(`[Force Reset] Version mismatch! Old: ${oldVersion} | New: ${SCRAPER_VERSION}. Re-initializing database.`);
                forceFullUpdate = true;
            }
            if (oldData.characters && Array.isArray(oldData.characters)) {
                oldData.characters.forEach(c => { if (c.Id) oldRosterMap.set(c.Id, c); });
            }
        } catch (e) {
            console.log("[Warning] Failed to parse old database. Forcing full initialization.");
            forceFullUpdate = true;
        }
    } else {
        console.log("[Initial Run] Database not found. Forcing full initialization.");
        forceFullUpdate = true;
    }

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log("Navigating to Prydwen characters page...");
        await page.goto('https://www.prydwen.gg/zenless/characters', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 15000));

        const htmlContent = await page.content();
        if (htmlContent.includes("Just a moment...") || htmlContent.includes("challenge-running")) {
            throw new Error("Cloudflare bypass failed.");
        }

        const rosterCharacters = extractJsonArray(htmlContent, "characters");
        if (!rosterCharacters) throw new Error("Could not find characters array identifier.");
        
        console.log(`Parsed ${rosterCharacters.length} characters from roster.`);

        const processedCharacters = rosterCharacters.map(char => {
            const oldChar = oldRosterMap.get(char.id || "");
            return {
                Id: char.id || "",
                Name: char.name || "",
                Link: char.slug ? `/zenless/characters/${char.slug}` : "",
                Rarity: char.rarity ? `${char.rarity}-Rank` : "",
                Element: char.element || "",
                Style: char.style || "",
                Faction: char.faction || "",
                SmallImage: char.smallImage || "",
                LastUpdated: oldChar ? (oldChar.LastUpdated || "") : ""
            };
        });

        const activeCharacters = processedCharacters.filter(char => char.Element !== "Unknown" && char.Style !== "Unknown");
        const charactersDir = path.join(process.cwd(), 'characters');
        if (!fs.existsSync(charactersDir)) fs.mkdirSync(charactersDir, { recursive: true });

        for (const char of activeCharacters) {
            const slug = char.Link.split('/').pop();
            if (!slug) continue;

            const charFilePath = path.join(charactersDir, `${slug}.json`);
            let localLastUpdated = char.LastUpdated || null;

            if (!localLastUpdated && fs.existsSync(charFilePath)) {
                try {
                    const localData = JSON.parse(fs.readFileSync(charFilePath, 'utf-8'));
                    if (localData.Meta && localData.Meta.LastUpdated) localLastUpdated = localData.Meta.LastUpdated;
                } catch (e) {}
            }

            console.log(`--------------------------------------------------`);
            console.log(`Processing: ${char.Name} (${slug})`);
            
            const targetUrl = `https://www.prydwen.gg${char.Link}`;
            try {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await new Promise(resolve => setTimeout(resolve, 5000));

                const detailHtml = await page.content();
                const remoteLastUpdated = extractUpdateDate(detailHtml);

                if (!forceFullUpdate && localLastUpdated && remoteLastUpdated === localLastUpdated) {
                    console.log(`[Status] ${char.Name} up-to-date (${remoteLastUpdated}). Skipping deep extraction.`);
                    char.LastUpdated = remoteLastUpdated;
                    continue;
                }

                console.log(`[Update] Local: ${localLastUpdated} | Remote: ${remoteLastUpdated}. Extracting deep data...`);

                const rawEngines = normalizeExtractedArray(extractJsonArray(detailHtml, "wEngines") || extractJsonArray(detailHtml, "engines") || []);
                const bestWEngines = rawEngines.map(e => {
                    if (!e) return null;
                    const name = e.name || (e.wEngine && e.wEngine.name) || (e.engine && e.engine.name) || e.title || e.id || "Unknown Engine";
                    const rating = e.rating || e.percentage || e.value || (e.stats && e.stats.percentage) || "100%";
                    return { Name: name, Rating: String(rating) };
                }).filter(Boolean);

                const rawSets = normalizeExtractedArray(extractJsonArray(detailHtml, "driveSets") || extractJsonArray(detailHtml, "diskSets") || []);
                const bestDiskSets = rawSets.map(s => {
                    if (!s) return null;
                    const name = s.name || (s.set && s.set.name) || (s.driveSet && s.driveSet.name) || s.title || "Unknown Set";
                    const rating = s.rating || s.percentage || s.value || "100%";
                    return { Name: name, Rating: String(rating) };
                }).filter(Boolean);

                const rawStats = normalizeExtractedArray(extractJsonArray(detailHtml, "statsPriority") || extractJsonArray(detailHtml, "mainStats") || []);
                const mainStats = rawStats
                    .filter(s => s && (s.slot === "4" || s.slot === "5" || s.slot === "6" || s.slot === 4 || s.slot === 5 || s.slot === 6))
                    .map(s => {
                        let statsArr = [];
                        if (Array.isArray(s.stats)) {
                            statsArr = s.stats.map(st => typeof st === 'object' ? (st.name || st.title || String(st)) : String(st));
                        } else if (s.stats) {
                            statsArr = [typeof s.stats === 'object' ? (s.stats.name || s.stats.title || String(s.stats)) : String(s.stats)];
                        }
                        return { Slot: String(s.slot), Stats: statsArr };
                    });

                const rawCalc = normalizeExtractedArray(extractJsonArray(detailHtml, "calculations") || extractJsonArray(detailHtml, "mindscapes") || []);
                const calculation = rawCalc.map(c => {
                    if (!c) return null;
                    if (typeof c === 'object') {
                        const name = c.name || c.label || c.title || c.id || "M?";
                        const value = c.value || c.percentage || c.rating || "100%";
                        return { Label: String(name), Value: String(value) };
                    }
                    return { Label: "M?", Value: String(c) };
                }).filter(Boolean);

                const finalizedCharacterData = {
                    Meta: { Id: char.Id, Name: char.Name, LastUpdated: remoteLastUpdated },
                    Build: { BestWEngines: bestWEngines, BestDiskSets: bestDiskSets, MainStats: mainStats, SubStats: [] },
                    Calculation: calculation
                };

                fs.writeFileSync(charFilePath, JSON.stringify(finalizedCharacterData, null, 2), 'utf-8');
                console.log(`[Success] Saved localized cache for ${char.Name}`);
                char.LastUpdated = remoteLastUpdated;
                console.log("For testing purposes only one character initialized. breaking from cycle.");
                break;
                
            } catch (charError) {
                console.error(`[Error] Failed processing ${char.Name}:`, charError.message);
            }
        }

        const finalOutput = {
            version: SCRAPER_VERSION,
            characters: processedCharacters
        };
        fs.writeFileSync(outputPath, JSON.stringify(finalOutput, null, 2), 'utf-8');
        console.log(`\n[Database Completed] Saved master file to ${outputPath} with version ${SCRAPER_VERSION}`);

    } catch (error) {
        console.error("Scraper execution failed:", error.message);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

runScraper();

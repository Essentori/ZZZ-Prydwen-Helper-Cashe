const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// Script version for database migration control (Hotfix v1.5.1)
const SCRAPER_VERSION = "1.5"; 

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

// Extractor for Arrays
function extractJsonArray(html, keyName) {
    const regex = new RegExp(`\\\\"${keyName}\\\\"\\s*:\\s*\\[|["']${keyName}["']\\s*:\\s*\\[`);
    const match = html.match(regex);
    if (!match) return null;
    
    const startIdx = match.index + match[0].length - 1;
    if (html[startIdx] !== '[') return null;
    
    let bracketCount = 0;
    let endIdx = -1;
    
    for (let i = startIdx; i < html.length; i++) {
        if (html[i] === '[') bracketCount++;
        else if (html[i] === ']') {
            bracketCount--;
            if (bracketCount === 0) {
                endIdx = i;
                break;
            }
        }
    }
    
    if (endIdx === -1) return null;
    let rawStr = html.substring(startIdx, endIdx + 1);
    
    for (let iter = 0; iter < 5; iter++) {
        try {
            return JSON.parse(rawStr);
        } catch (e) {
            rawStr = rawStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
    }
    try { return JSON.parse(rawStr); } catch (e) { return null; }
}

// Extractor for Objects
function extractJsonObject(html, keyName) {
    const regex = new RegExp(`\\\\*"${keyName}\\\\*"\\s*:\\s*\\\\*\\{|["']${keyName}["']\\s*:\\s*\\{`);
    const match = html.match(regex);
    if (!match) return null;
    
    const startIdx = match.index + match[0].length - 1;
    if (html[startIdx] !== '{') return null;
    
    let bracketCount = 0;
    let endIdx = -1;
    
    for (let i = startIdx; i < html.length; i++) {
        if (html[i] === '{') bracketCount++;
        else if (html[i] === '}') {
            bracketCount--;
            if (bracketCount === 0) {
                endIdx = i;
                break;
            }
        }
    }
    
    if (endIdx === -1) return null;
    let rawStr = html.substring(startIdx, endIdx + 1);
    
    for (let iter = 0; iter < 5; iter++) {
        try {
            return JSON.parse(rawStr);
        } catch (e) {
            rawStr = rawStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
    }
    try { return JSON.parse(rawStr); } catch (e) { return null; }
}

function extractFromPayload(stream, html, keyName) {
    if (stream) {
        const res = extractJsonArray(stream, keyName);
        if (res) return res;
    }
    return extractJsonArray(html, keyName);
}

function extractObjFromPayload(stream, html, keyName) {
    if (stream) {
        const res = extractJsonObject(stream, keyName);
        if (res) return res;
    }
    return extractJsonObject(html, keyName);
}

function extractUpdateDate(html, stream) {
    const match = html.match(/(?:\\"last_updated\\"|\\"updated_at\\"|["']last_updated["']|["']updated_at["'])\s*:\s*\\?"([^\\"]+)\\?"/) ||
                  (stream && stream.match(/(?:\\"last_updated\\"|\\"updated_at\\"|["']last_updated["']|["']updated_at["'])\s*:\s*\\?"([^\\"]+)\\?"/));
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
            let oldVersion = "1.0"; 

            if (!oldData) {
                oldVersion = "0.0";
            } else if (Array.isArray(oldData)) {
                oldVersion = "1.0";
                oldData.forEach(c => { if (c && c.Id) oldRosterMap.set(c.Id, c); });
            } else if (typeof oldData === 'object') {
                oldVersion = oldData.version || "1.0";
                if (oldData.characters && Array.isArray(oldData.characters)) {
                    oldData.characters.forEach(c => { if (c && c.Id) oldRosterMap.set(c.Id, c); });
                }
            }

            if (oldVersion !== SCRAPER_VERSION) {
                console.log(`[Force Reset] Version mismatch! Old DB Format: v${oldVersion} | New Scraper: v${SCRAPER_VERSION}. Forcing migration.`);
                forceFullUpdate = true;
            }
        } catch (e) {
            console.log("[Warning] Failed to parse old database. Forcing full initialization.");
            forceFullUpdate = true;
        }
    } else {
        console.log("[Initial Run] Database file not found. Forcing full initialization.");
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
        
        console.log("DOM content loaded. Waiting 15 seconds for layout scripts execution...");
        await new Promise(resolve => setTimeout(resolve, 15000));

        const htmlContent = await page.content();
        const streamContent = await page.evaluate(() => {
            if (!window.__next_f || !Array.isArray(window.__next_f)) return '';
            return window.__next_f.map(chunk => Array.isArray(chunk) ? chunk[1] : '').filter(Boolean).join('');
        });

        if (htmlContent.includes("Just a moment...") || htmlContent.includes("challenge-running") || htmlContent.includes("Access denied")) {
            throw new Error("Cloudflare bypass failed. Runner IP might be blocked.");
        }

        const rosterCharacters = extractFromPayload(streamContent, htmlContent, "characters");
        if (!rosterCharacters) {
            throw new Error("Could not find characters array identifier.");
        }
        
        console.log(`Parsed ${rosterCharacters.length} characters.`);

        const processedCharacters = rosterCharacters.map(char => {
            const oldChar = oldRosterMap.get(char.id || "");
            return {
                Id: char.id || "",
                Name: char.name || "",
                Link: char.slug || "",
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
            
            const targetUrl = `https://www.prydwen.gg/zenless/characters/${char.Link}`;
            try {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await new Promise(resolve => setTimeout(resolve, 5000));

                // 0. Metadata
                const detailHtml = await page.content();
                const detailStream = await page.evaluate(() => {
                    if (!window.__next_f || !Array.isArray(window.__next_f)) return '';
                    return window.__next_f.map(chunk => Array.isArray(chunk) ? chunk[1] : '').filter(Boolean).join('');
                });

                const remoteLastUpdated = extractUpdateDate(detailHtml, detailStream);

                if (forceFullUpdate) {
                    console.log(`[Migration Override] Version migration active! Forcing full rebuild for ${char.Name}.`);
                } else if (localLastUpdated && remoteLastUpdated === localLastUpdated) {
                    console.log(`[Status] ${char.Name} up-to-date (${remoteLastUpdated}). Skipping deep extraction.`);
                    char.LastUpdated = remoteLastUpdated;
                    continue;
                }

                console.log(`[Update] Extracting  data for ${char.Name} from https://www.prydwen.gg/zenless/characters/${char.Link} ...`);

                // 1. W-Engines (engineBuilds)
                const rawEngines = extractFromPayload(detailStream, detailHtml, "engineBuilds") || [];
                const bestWEngines = rawEngines.map(e => ({
                    Name: e.Engine || "Unknown Engine",
                    Rating: String(e.Percentage_top || e.Percentage_bottom || "100%").replace('%', '').trim() + "%"
                }));

                // 2. Drive Sets (diskBuilds)
                const rawSets = extractFromPayload(detailStream, detailHtml, "diskBuilds") || [];
                const bestDiskSets = rawSets.map(s => ({
                    Name: s.Set || "Unknown Set",
                    Rating: String(s.Percentage || "100%").replace('%', '').trim() + "%"
                }));

                // 3. Stats Priority & Substats (statBuilds)
                const rawStats = extractFromPayload(detailStream, detailHtml, "statBuilds") || [];
                let mainStats = [];
                let subStats = [];
                if (rawStats.length > 0) {
                    const stats = rawStats[0];
                    mainStats = [
                        { Slot: "4", Stats: stats.Disk_4 ? stats.Disk_4.split('>').map(s => s.trim()) : [] },
                        { Slot: "5", Stats: stats.Disk_5 ? stats.Disk_5.split('>').map(s => s.trim()) : [] },
                        { Slot: "6", Stats: stats.Disk_6 ? stats.Disk_6.split('>').map(s => s.trim()) : [] }
                    ];
                    if (stats.Substats) {
                        subStats = stats.Substats.split('>').map(s => s.trim());
                    }
                }

                // 4. Endgame Stats & Calculations ("character" root object)
                const characterObj = extractObjFromPayload(detailStream, detailHtml, "character") || {};
                
                let endgameStats = [];
                if (characterObj.endgameStats) {
                    const matches = characterObj.endgameStats.match(/<li>(.*?)<\/li>/g);
                    if (matches) {
                        endgameStats = matches.map(m => m.replace(/<\/?li>/g, '').replace(/<[^>]+>/g, '').trim());
                    }
                }

                let calculation = [];
                if (characterObj.data && characterObj.data.additional_ability) {
                    const dpsObj = characterObj.data.additional_ability.dps_standard || 
                                   (characterObj.data.additional_ability.damage_calc && characterObj.data.additional_ability.damage_calc.dps);
                    if (dpsObj && dpsObj.damage) {
                        const baseDmg = dpsObj.damage;
                        const mindscapes = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
                        calculation = mindscapes.map((m, idx) => {
                            const mDmg = dpsObj[`damage_${m}`];
                            if (mDmg) {
                                return { Label: `M${idx + 1}`, Value: ((mDmg / baseDmg) * 100).toFixed(2) + "%" };
                            }
                            return null;
                        }).filter(Boolean);
                    }
                }

                const finalizedCharacterData = {
                    Meta: { Id: char.Id, Name: char.Name, LastUpdated: remoteLastUpdated },
                    Build: { 
                        BestWEngines: bestWEngines, 
                        BestDiskSets: bestDiskSets, 
                        MainStats: mainStats, 
                        SubStats: subStats,
                        EndgameStats: endgameStats
                    },
                    Calculation: calculation
                };

                fs.writeFileSync(charFilePath, JSON.stringify(finalizedCharacterData, null, 2), 'utf-8');
                console.log(`[Success] Saved localized cache for ${char.Name}`);
                char.LastUpdated = remoteLastUpdated;
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

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

async function runScraper() {
    console.log("Initializing Cloudflare bypass via Puppeteer Stealth...");
    
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log("Navigating to Prydwen characters page...");
        await page.goto('https://www.prydwen.gg/zenless/characters', { 
            waitUntil: 'networkidle2',
            timeout: 60000 
        });

        console.log("Waiting for Cloudflare JavaScript challenge to resolve...");
        await new Promise(resolve => setTimeout(resolve, 10000));

        const htmlContent = await page.content();

        if (htmlContent.includes("Just a moment...") || htmlContent.includes("challenge-running")) {
            throw new Error("Cloudflare bypass failed: Browser is stuck on the verification screen.");
        }

        console.log("Extracting raw character data from page content...");
        
        const regex = /\\"characters\\"\s*:\s*\[|["']characters["']\s*:\s*\[/;
        const match = htmlContent.match(regex);
        if (!match) {
            throw new Error("Could not find characters array identifier in the page content.");
        }
        
        const startIdx = match.index + match[0].length - 1;
        let bracketCount = 0;
        let endIdx = -1;
        
        for (let i = startIdx; i < htmlContent.length; i++) {
            if (htmlContent[i] === '[') bracketCount++;
            else if (htmlContent[i] === ']') {
                bracketCount--;
                if (bracketCount === 0) {
                    endIdx = i;
                    break;
                }
            }
        }
        
        if (endIdx === -1) {
            throw new Error("Could not find matching closing bracket for characters array.");
        }
        
        let rawArrayStr = htmlContent.substring(startIdx, endIdx + 1);
        
        rawArrayStr = rawArrayStr.replace(/\\"/g, '"');
        
        const rawCharacters = JSON.parse(rawArrayStr);
        console.log(`Successfully parsed ${rawCharacters.length} characters from raw page data.`);

        const processedCharacters = rawCharacters.map(char => {
            return {
                Id: char.id || "",
                Name: char.name || "",
                Link: char.slug ? `/zenless/characters/${char.slug}` : "",
                Rarity: char.rarity ? `${char.rarity}-Rank` : "",
                Element: char.element || "",
                Style: char.style || "",
                Faction: char.faction || "",
                SmallImage: char.smallImage || ""
            };
        });

        const outputPath = path.join(process.cwd(), 'characters.json');
        fs.writeFileSync(outputPath, JSON.stringify(processedCharacters, null, 2), 'utf-8');
        console.log(`Success! Finalized clean database saved to ${outputPath}`);

    } catch (error) {
        console.error("Scraper execution failed:", error.message);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

runScraper();

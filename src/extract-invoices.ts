import * as fs from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { PDFParse } from 'pdf-parse';
import ollama from 'ollama';
import { z } from 'zod';
import Database from 'better-sqlite3';

import 'dotenv/config';

// 1. Database Type Definition
interface InvoiceRow {
    id: number;
    file_hash: string;
    file_path: string;
    vendor: string;
    invoice_num: string;
    total_original: number;
    currency: string;
    exchange_rate: number;
    total_gbp: number;
    date: string;
    tax_year: string;
    category: string;
    total: number;
}

const ROOT_FOLDER = process.env.ROOT_FOLDER;

if (!ROOT_FOLDER) {
    console.error("❌ ERROR: ROOT_FOLDER is not defined in environment variables.");
    process.exit(1);
}

const db = new Database(path.join(ROOT_FOLDER, 'Tax-Summary.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_hash TEXT UNIQUE,
    file_path TEXT,
    vendor TEXT,
    invoice_num TEXT,
    date TEXT, -- YYYY-MM-DD
    tax_year TEXT,
    category TEXT,
    currency TEXT,
    total_original REAL,
    exchange_rate REAL,
    total_gbp REAL,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const InvoiceSchema = z.object({
    invoiceNumber: z.string().describe("The unique invoice reference"),
    date: z.string().describe("Invoice date. Standardise to YYYY-MM-DD format"),
    // date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").describe("Standardised to YYYY-MM-DD"),
    // date: z.iso.date().describe("Invoice date. Standardise to YYYY-MM-DD format"),
    vendorName: z.string().describe("Company name"),
    totalAmount: z.number().describe("Final total amount"),
    currency: z.string().describe("3-letter currency code (e.g. GBP, USD, EUR)"),
    // confidence: z.number().min(0).max(10).describe("Confidence score from 0 to 1 indicating extraction reliability")
});

/**
 * Standardises dates to YYYY-MM-DD
 */
function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toISOString().split('T')[0];
}

/**
 * Fetches historical exchange rate to GBP for a specific date.
 * Uses a public API (Example: frankfurter.dev which is free and open)
 */
async function getExchangeRateToGBP(currency: string, date: string): Promise<number | null> {
    if (currency.toUpperCase() === 'GBP') return 1.0;
    try {
        const response = await fetch(`https://api.frankfurter.dev/v1/${date}?base=${currency.toUpperCase()}&symbols=GBP`);
        const data: any = await response.json();
        return data.rates?.GBP;
    } catch (e) {
        console.error(`⚠️ Could not fetch rate for ${currency} on ${date}. Defaulting to 1.0`);
        return null;
    }
}

/**
 * Sends a native macOS notification
 */
function notify(title: string, msg: string, sound: string = "Glass") {
    const command = `osascript -e 'display notification "${msg}" with title "${title}" sound name "${sound}"'`;
    
    execSync(command);
}

/**
 * Exports the results to a CSV file
*/
function exportToCSV() {
    const rows = db.prepare('SELECT * FROM processed_invoices ORDER BY date DESC').all() as InvoiceRow[];
    if (rows.length === 0) return;

    const headers = "Date,Category,Tax Year,Vendor,Invoice #,Original Amount,Currency,Rate,Total GBP\n";
    const csv = rows.map(r => 
        `${r.date},"${r.category}","${r.tax_year}","${r.vendor}",${r.invoice_num},${r.total_original},${r.currency},${r.exchange_rate},${r.total_gbp}`
    ).join("\n");

    if (!ROOT_FOLDER) {
        console.error("❌ ERROR: ROOT_FOLDER is not defined in environment variables.");
        process.exit(1);
    }

    writeFileSync(path.join(ROOT_FOLDER, 'Tax-Summary.csv'), headers + csv);
    console.log("📂 Export Complete: Tax-Summary.csv updated.");
}

let startTime = Date.now();

/**
 * Renders a terminal progress bar
 */
function drawProgressBar(current: number, total: number) {
    const width = 30;
    const progress = Math.round((current / total) * width);
    const percentage = Math.round((current / total) * 100);
    
    // Calculate ETA
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = current / elapsed;
    const remainingSeconds = Math.round((total - current) / rate);
    const eta = current > 1 ? `| ETA: ${Math.floor(remainingSeconds / 60)}m ${remainingSeconds % 60}s` : "";

    const bar = "█".repeat(progress) + "░".repeat(width - progress);
    
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`[${bar}] ${percentage}% | ${current}/${total} Files ${eta}`);
}

/**
 * Use the tag utility from homebrew
 * This bypasses the Finder app and works more reliably with iCloud paths.
 */
function applyMacTags(filePath: string, tags: string[]) {
    const absolutePath = path.resolve(filePath).replaceAll(" ", "\\ ");

    try {
        // We use the 'tag' command if you have it (brew install tag)
        execSync(`/opt/homebrew/bin/tag --add ${tags.map(t => `"${t}"`).join(",")} ${absolutePath}`)
    } catch (e) {
        // If tagging fails, we log it but don't stop the AI
        console.error(`⚠️ Tagging failed for: ${path.basename(filePath)}. Error: ${e instanceof Error ? e.message : 'Unknown'}`);
    }
}

// --- TAX LOGIC ---

/**
 * Calculates UK Tax Year (April 6th to April 5th)
 */
function calculateTaxYear(dateStr: string): string {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return "Unknown";
    const year = date.getFullYear();
    const taxYearStart = new Date(year, 3, 6); // April 6th
    return date >= taxYearStart ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

// --- MAIN AUTOMATION ---

async function getFileHash(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function getInvoices(dir: string): Promise<{path: string, category: string}[]> {
    let results: {path: string, category: string}[] = [];
    if (!existsSync(dir)) return [];

    const list = await fs.readdir(dir);
    for (const item of list) {
        const fullPath = path.join(dir, item);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
            results = results.concat(await getInvoices(fullPath));
        } else if (fullPath.endsWith('.pdf')) {
            // Determine category based on parent folder name
            const category = fullPath.toLowerCase().includes('income') ? 'Income' : 
                             fullPath.toLowerCase().includes('expenditure') ? 'Expenditure' : 'Other';
            results.push({ path: fullPath, category });
        }
    }
    return results;
}

/**
 * Throttling helper to prevent system freezes
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runTaxAutomation() {
    if (!ROOT_FOLDER) {
        console.error("❌ ERROR: ROOT_FOLDER is not defined in environment variables.");
        process.exit(1);
    }

    const files = await getInvoices(ROOT_FOLDER);
    const totalFiles = files.length;
    startTime = Date.now(); // Reset start time for accurate ETA
    
    let newlyAdded = 0;
    let errors = 0;

    for (let i = 0; i < totalFiles; i++) {
        const fileObj = files[i];
        // drawProgressBar(i + 1, totalFiles); // disabled as process.stdout.clearLine causes is not a function within the plist file

        try {
            const hash = await getFileHash(fileObj.path);
            if (db.prepare('SELECT id FROM processed_invoices WHERE file_hash = ?').get(hash)) {
                continue;
            }

            console.log(`🔍 Reading: ${path.basename(fileObj.path)}`);
            const dataBuffer = await fs.readFile(fileObj.path);

            // Convert Node.js Buffer to Uint8Array to satisfy pdf-parse v2 requirements
            const uint8Array = new Uint8Array(dataBuffer); 

            const parser = new PDFParse(uint8Array); 

            const { text } = await parser.getText();

            // Check if PDF actually has readable text
            if (!text || text.trim().length < 10) {
                throw new Error("PDF contains no readable text (it might be an image/scan).");
            }

            console.log(`🧠 AI Analyzing: ${path.basename(fileObj.path)}...`);
            
            const response = await ollama.chat({
                model: 'llama3.2',
                messages: [
                    // {
                    //     role: 'user', 
                    //     content: `Extract structured data from this invoice text. Return valid JSON only: ${text.slice(0, 5000)}` 
                    // }
                    {
                        role: 'system', 
                        content: "You are a data extraction bot. Return ONLY valid JSON. Return dates in YYYY-MM-DD format. If a date is missing, do not explain; simply fail. Return currencies in ISO 4217 format only. Work out the tax year based on the invoice date. No conversational text or assumptions." 
                    },
                    { 
                        role: 'user', 
                        content: `Extract from this invoice: ${text.slice(0, 5000)}` 
                    }
                ],
                format: InvoiceSchema.toJSONSchema()
            });

            const rawInv = InvoiceSchema.parse(JSON.parse(response.message.content.replace(/```json|```/g, "")));

            const cleanJson = response.message.content.replace(/```json|```/g, "").trim(); 
            const inv = InvoiceSchema.parse(JSON.parse(cleanJson));
            const taxYear = calculateTaxYear(inv.date);
            const stdDate = formatDate(inv.date);
            const rate = await getExchangeRateToGBP(inv.currency, stdDate) ?? 1;
            const totalGBP = Number((inv.totalAmount * rate).toFixed(2));

            db.prepare(`
                INSERT INTO processed_invoices 
                (file_hash, file_path, vendor, invoice_num, date, tax_year, category, currency, total_original, exchange_rate, total_gbp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                hash, 
                path.resolve(fileObj.path), 
                rawInv.vendorName, 
                rawInv.invoiceNumber, 
                stdDate, 
                taxYear, 
                fileObj.category, 
                rawInv.currency.toUpperCase(), 
                rawInv.totalAmount, 
                rate, 
                totalGBP,
            );
            
            applyMacTags(fileObj.path, [taxYear, fileObj.category]);
            
            newlyAdded++;
            notify(`✅ ${fileObj.category} Logged`, `${inv.vendorName}: £${totalGBP} (from ${rawInv.currency})`);

            // REQUIRED: Wait 250 milliseconds between files to prevent CPU saturation and freezes
            await delay(250);
        } catch (err: any) {
            errors++;
            // Log the actual error to terminal to see WHY it failed
            console.error(`❌ Failure on ${path.basename(fileObj.path)}:`, err.message || err);
            
            process.stdout.write('\n'); // Ensure error is logged above the bar
            
            notify("⚠️ Extraction Error", `${path.basename(fileObj.path)}: ${err.message || 'AI Failure'}`, "Basso");
            
            // Wait a moment after an error to let the system recover
            await delay(1000);
        }
    }

    if (newlyAdded > 0) {
        process.stdout.write('\n');
        exportToCSV();
    }

    notify("Tax Scan Complete", `New: ${newlyAdded} | Errors: ${errors}`, "Hero");
}

runTaxAutomation();
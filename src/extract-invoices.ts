import * as fs from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { PDFParse } from 'pdf-parse';
import ollama from 'ollama';
import { z } from 'zod';
import Database from 'better-sqlite3';

// 1. Database Type Definition
interface InvoiceRow {
    id: number;
    file_hash: string;
    file_path: string;
    vendor: string;
    invoice_num: string;
    date: string;
    tax_year: string;
    category: string;
    total: number;
}

const PROJECT_ROOT = '/Users/karlpodger/Sites/tax-scan';
const ROOT_FOLDER = '/Users/karlpodger/Library/Mobile Documents/com~apple~CloudDocs/Affairs/HMRC/Tax Return';
// const PROJECT_ROOT = import.meta.dirname;
// const ROOT_FOLDER = await import(`file:///${process.cwd().replace(/\\/g, '/')}`);

const db = new Database(path.join(PROJECT_ROOT, 'invoice_vault.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_hash TEXT UNIQUE,
    file_path TEXT,
    vendor TEXT,
    invoice_num TEXT,
    date TEXT,
    tax_year TEXT,
    category TEXT,
    total REAL,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const InvoiceSchema = z.object({
    invoiceNumber: z.string().describe("The unique invoice reference"),
    date: z.string().describe("Invoice date in YYYY-MM-DD format"),
    vendorName: z.string().describe("Company name"),
    totalAmount: z.number().describe("Final total amount"),
});

// --- NOTIFICATION & TAGGING HELPERS ---

/**
 * Sends a native macOS notification
 */
function notify(title: string, msg: string, sound: string = "Glass") {
    const command = `osascript -e 'display notification "${msg}" with title "${title}" sound name "${sound}"'`;
    
    execSync(command);
}

/**
 * Applies macOS Finder Tags for easy browsing
 */
function applyMacTags(filePath: string, tags: string[]) {
    const absolutePath = path.resolve(filePath);
    const tagsArray = tags.map(t => `"${t}"`).join(", ");
    
    const command = `osascript -e 'tell application "Finder" to set tags of (POSIX file "${absolutePath}" as alias) to {${tagsArray}}'`;

    try {
        execSync(command);
    } catch (e) {
        console.error(`Tagging failed for ${absolutePath}`);
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
    const files = await getInvoices(ROOT_FOLDER);
    console.log(`🚀 Starting scan: ${files.length} files found.`);
    
    let newlyAdded = 0;
    let errors = 0;

    for (const fileObj of files) {
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
                messages: [{ 
                    role: 'user', 
                    content: `Extract structured data from this invoice text. Return valid JSON only: ${text.slice(0, 5000)}` 
                }],
                format: InvoiceSchema.toJSONSchema()
            });

            // Parse response content
            const content = response.message.content;
            const inv = InvoiceSchema.parse(JSON.parse(content));
            const taxYear = calculateTaxYear(inv.date);

            // Database insertion
            db.prepare(`
                INSERT INTO processed_invoices (file_hash, file_path, vendor, invoice_num, date, tax_year, category, total)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(hash, path.resolve(fileObj.path), inv.vendorName, inv.invoiceNumber, inv.date, taxYear, fileObj.category, inv.totalAmount);
            
            applyMacTags(fileObj.path, [taxYear, fileObj.category]);
            
            newlyAdded++;
            notify(`✅ ${fileObj.category} Logged`, `${inv.vendorName}: £${inv.totalAmount}`);

            // REQUIRED: Wait 2 seconds between files to prevent CPU saturation and freezes
            await delay(2000);

        } catch (err: any) {
            errors++;
            // Log the actual error to terminal to see WHY it failed
            console.error(`❌ Failure on ${path.basename(fileObj.path)}:`, err.message || err);
            notify("⚠️ Extraction Error", `${path.basename(fileObj.path)}: ${err.message || 'AI Failure'}`, "Basso");
            
            // Wait a moment after an error to let the system recover
            await delay(1000);
        }
    }

    if (newlyAdded > 0 || errors > 0) {
        notify("Tax Scan Complete", `Processed: ${newlyAdded} new | Errors: ${errors}`, "Hero");
    }
    
    exportToCSV();
}

function exportToCSV() {
    const rows = db.prepare('SELECT * FROM processed_invoices').all() as InvoiceRow[];
    if (rows.length === 0) return;
    const headers = "Category,Tax Year,Vendor,Invoice #,Date,Total,File Path\n";
    const csv = rows.map(r => `"${r.category}","${r.tax_year}","${r.vendor}",${r.invoice_num},${r.date},${r.total},"${r.file_path}"`).join("\n");
    writeFileSync(path.join(PROJECT_ROOT, 'Tax_Summary.csv'), headers + csv);
}

runTaxAutomation();
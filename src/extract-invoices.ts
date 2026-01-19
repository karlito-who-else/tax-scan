import { exec } from 'node:child_process';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import ollama from 'ollama';
import { PDFParse } from 'pdf-parse';
import { z } from 'zod';

/**
 * Sends a native macOS notification
 */
function notify(title: string, msg: string, sound: string = "Glass") {
    const command = `osascript -e 'display notification "${msg}" with title "${title}" sound name "${sound}"'`;
    exec(command);
}

// --- TYPES & INTERFACES ---
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

const db = new Database('invoice_vault.db');
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

// Helper: Calculate UK Tax Year (6 April - 5 April)
function calculateTaxYear(dateStr: string): string {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return "Unknown";
    const year = date.getFullYear();
    const taxYearStart = new Date(year, 3, 6); // April 6th
    return date >= taxYearStart ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

// Helper: Apply macOS Finder Tags
function applyMacTags(filePath: string, tags: string[]) {
    const tagsArray = tags.map(t => `"${t}"`).join(", ");
    const script = `tell application "Finder" to set tags of (POSIX file "${path.resolve(filePath)}" as alias) to {${tagsArray}}`;
    exec(`osascript -e '${script}'`);
}

async function getFileHash(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Scanner that identifies category from the folder path
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
            const category = fullPath.toLowerCase().includes('income') ? 'Income' : 
                             fullPath.toLowerCase().includes('expenditure') ? 'Expenditure' : 'Other';
            results.push({ path: fullPath, category });
        }
    }
    return results;
}

async function runTaxAutomation() {
    const ROOT_FOLDER = '/Users/karlpodger/Library/Mobile Documents/com~apple~CloudDocs/Affairs/HMRC/Tax Return';
    const files = await getInvoices(ROOT_FOLDER);
    
    const insertStmt = db.prepare(`
        INSERT INTO processed_invoices (file_hash, file_path, vendor, invoice_num, date, tax_year, category, total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const fileObj of files) {
        try {
            const hash = await getFileHash(fileObj.path);
            if (db.prepare('SELECT id FROM processed_invoices WHERE file_hash = ?').get(hash)) continue;

            const dataBuffer = await fs.readFile(fileObj.path);
            const parser = new PDFParse(dataBuffer);
            const { text } = await parser.getText();

            const response = await ollama.chat({
                model: 'llama3.2',
                messages: [{ role: 'user', content: `Extract data: ${text.slice(0, 5000)}` }],
                format: InvoiceSchema.toJsonSchema()
            });

            const inv = InvoiceSchema.parse(JSON.parse(response.message.content));
            const taxYear = calculateTaxYear(inv.date);

            insertStmt.run(hash, path.resolve(fileObj.path), inv.vendorName, inv.invoiceNumber, inv.date, taxYear, fileObj.category, inv.totalAmount);
            
            // Apply macOS Tags for Finder browsing
            applyMacTags(fileObj.path, [taxYear, fileObj.category]);
            
            console.log(`✅ Logged & Tagged: ${inv.vendorName} (${taxYear})`);

        } catch (err) {
            console.error(`❌ Error on ${fileObj.path}:`, err);
        }
    }
    exportToCSV();
}

function exportToCSV() {
    const rows = db.prepare('SELECT * FROM processed_invoices').all() as InvoiceRow[];
    if (rows.length === 0) return;
    const headers = "Category,Tax Year,Vendor,Invoice #,Date,Total,File Path\n";
    const csv = rows.map(r => `"${r.category}","${r.tax_year}","${r.vendor}",${r.invoice_num},${r.date},${r.total},"${r.file_path}"`).join("\n");
    writeFileSync('Tax_Summary.csv', headers + csv);
}

runTaxAutomation();
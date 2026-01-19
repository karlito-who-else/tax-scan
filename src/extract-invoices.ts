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
    file_name: string;
    vendor: string;
    invoice_num: string;
    date: string;
    total: number;
    processed_at: string;
}

// --- DATABASE & SCHEMA SETUP ---
const db = new Database('invoice_vault.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_hash TEXT UNIQUE,
    file_path TEXT,
    file_name TEXT,
    vendor TEXT,
    invoice_num TEXT,
    date TEXT,
    total REAL,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const InvoiceSchema = z.object({
    invoiceNumber: z.string().describe("The unique reference number of the invoice"),
    date: z.string().describe("The date of the invoice in YYYY-MM-DD format"),
    vendorName: z.string().describe("The name of the company issuing the invoice"),
    totalAmount: z.number().describe("The final total amount due, as a number"),
});


async function getFileHash(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// --- MAIN LOGIC ---
async function processInvoices() {
    const TARGET_FOLDER = './Invoices';
    const files = await getFiles(TARGET_FOLDER, '.pdf');
    
    let newlyAddedCount = 0;
    let errorCount = 0;

    const checkHashStmt = db.prepare('SELECT id FROM processed_invoices WHERE file_hash = ?');
    const insertStmt = db.prepare(`
        INSERT INTO processed_invoices (file_hash, file_path, file_name, vendor, invoice_num, date, total)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    console.log(`🔍 Scanning ${files.length} documents...`);

    for (const file of files) {
        try {
            const hash = await getFileHash(file);
            if (checkHashStmt.get(hash)) continue; // Skip duplicates silently

            console.log(`🧠 AI Parsing: ${path.basename(file)}...`);
            const dataBuffer = await fs.readFile(file);
            const parser = new PDFParse(dataBuffer);
            const { text } = await parser.getText();

            const response = await ollama.chat({
                model: 'llama3.2',
                messages: [{ role: 'user', content: `Extract data: ${text.slice(0, 5000)}` }],
                format: InvoiceSchema.toJSONSchema() // Native Zod v4 Schema
            });

            const inv = InvoiceSchema.parse(JSON.parse(response.message.content));

            const result = insertStmt.run(hash, path.resolve(file), path.basename(file), inv.vendorName, inv.invoiceNumber, inv.date, inv.totalAmount);
            
            if (result.changes > 0) {
                newlyAddedCount++;
                notify("Invoice Logged", `${inv.vendorName}: $${inv.totalAmount}`, "Glass");
            }

        } catch (err) {
            errorCount++;
            const msg = err instanceof Error ? err.message : "Unknown error";
            notify("⚠️ Extraction Error", `Failed: ${path.basename(file)}`, "Basso");
            console.error(`❌ Error on ${file}: ${msg}`);
        }
    }

    // Final Summary Notification
    if (newlyAddedCount > 0 || errorCount > 0) {
        const summaryMsg = `Added: ${newlyAddedCount} | Errors: ${errorCount}`;
        notify("Scan Complete", summaryMsg, "Hero");
    }
    
    exportToCSV();
}

function exportToCSV() {
    const rows = db.prepare('SELECT * FROM processed_invoices').all() as InvoiceRow[];
    if (rows.length === 0) return;
    const headers = "Vendor,Invoice #,Date,Total,File Name\n";
    const csv = rows.map(r => `"${r.vendor}",${r.invoice_num},${r.date},${r.total},"${r.file_name}"`).join("\n");
    writeFileSync('Numbers_Import.csv', headers + csv);
}

async function getFiles(dir: string, ext: string): Promise<string[]> {
    let results: string[] = [];
    if (!existsSync(dir)) return [];
    const list = await fs.readdir(dir);
    for (const item of list) {
        const fullPath = path.join(dir, item);
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
            results = results.concat(await getFiles(fullPath, ext));
        } else if (fullPath.endsWith(ext)) {
            results.push(fullPath);
        }
    }
    return results;
}

processInvoices();
import { exec } from 'node:child_process';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import * as fs from 'fs-extra';
import ollama from 'ollama';
import { PDFParse } from 'pdf-parse';
import { z } from 'zod';

/**
 * Sends a native macOS alert notification with an error sound
 */
function sendErrorNotification(title: string, message: string) {
    // Uses "Basso" sound for errors
    const command = `osascript -e 'display notification "${message}" with title "❌ ${title}" sound name "Basso"'`;
    exec(command);
    console.error(`🚨 [CRITICAL]: ${title} - ${message}`);
}

/**
 * Sends a native macOS notification
 */
function sendNotification(title: string, subtitle: string, message: string) {
    const command = `osascript -e 'display notification "${message}" with title "${title}" subtitle "${subtitle}" sound name "Glass"'`;
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

// 3. Define Schema (Zod v4)
const InvoiceSchema = z.object({
    invoiceNumber: z.string().describe("The unique reference number of the invoice"),
    date: z.string().describe("The date of the invoice in YYYY-MM-DD format"),
    vendorName: z.string().describe("The name of the company issuing the invoice"),
    totalAmount: z.number().describe("The final total amount due, as a number"),
});

const TARGET_FOLDER = './Invoices';

async function getFileHash(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function processInvoices() {
    const files = await getFiles(TARGET_FOLDER, '.pdf');
    const checkHashStmt = db.prepare('SELECT id FROM processed_invoices WHERE file_hash = ?');
    const insertStmt = db.prepare(`
        INSERT INTO processed_invoices (file_hash, file_path, file_name, vendor, invoice_num, date, total)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const file of files) {
        try {
            const hash = await getFileHash(file);
            const absolutePath = path.resolve(file);

            if (checkHashStmt.get(hash)) {
                console.log(`⏩ Skipping duplicate: ${path.basename(file)}`);
                continue;
            }

            console.log(`🧠 AI Reading: ${path.basename(file)}...`);
            const dataBuffer = await fs.readFile(file);
            const parser = new PDFParse(dataBuffer);
            const { text } = await parser.getText();

            // Native Zod v4 JSON Schema generation
            const jsonSchema = InvoiceSchema.toJSONSchema();

            const response = await ollama.chat({
                model: 'llama3.2',
                messages: [{ 
                    role: 'user', 
                    content: `Extract structured data from this invoice text: ${text.slice(0, 5000)}` 
                }],
                format: jsonSchema // Standard JSON Schema object
            });

            const parsedData = InvoiceSchema.parse(JSON.parse(response.message.content));

            insertStmt.run(
                hash,
                absolutePath,
                path.basename(file),
                parsedData.vendorName,
                parsedData.invoiceNumber,
                parsedData.date,
                parsedData.totalAmount
            );

            sendNotification(
                "Invoice Processed", 
                parsedData.vendorName, 
                `Logged $${parsedData.totalAmount} for ${parsedData.invoiceNumber}`
            );

            console.log(`✅ Saved: ${parsedData.vendorName} ($${parsedData.totalAmount})`);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            // Alert the user via macOS Notification Center
            sendErrorNotification(
                "Extraction Failed", 
                `Could not process ${path.basename(file)}: ${errorMessage}`
            );

            console.error(`❌ Error on ${file}:`, error instanceof Error ? error.message : error);
        }
    }
    
    exportToCSV();
}

function exportToCSV() {
    const rows = db.prepare('SELECT * FROM processed_invoices').all() as InvoiceRow[];
    if (rows.length === 0) return;

    const headers = "Vendor,Invoice #,Date,Total,File Name\n";
    const csv = rows.map(r => 
        `"${r.vendor}",${r.invoice_num},${r.date},${r.total},"${r.file_name}"`
    ).join("\n");

    fs.writeFileSync('Numbers_Import.csv', headers + csv);
    console.log(`\n📂 Updated Numbers_Import.csv with ${rows.length} records.`);
}

async function getFiles(dir: string, ext: string): Promise<string[]> {
    let results: string[] = [];
    if (!fs.existsSync(dir)) return [];
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
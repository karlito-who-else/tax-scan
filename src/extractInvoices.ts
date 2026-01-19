import * as fs from 'fs-extra';
import * as path from 'node:path';
import { PDFParse } from 'pdf-parse';
import ollama from 'ollama';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import Database from 'better-sqlite3';

// 1. Database & Schema Setup
const db = new Database('invoice_vault.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE,
    file_name TEXT,
    vendor TEXT,
    invoice_num TEXT,
    date TEXT,
    total REAL,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const InvoiceSchema = z.object({
    invoiceNumber: z.string(),
    date: z.string(),
    vendorName: z.string(),
    totalAmount: z.number(),
});

const TARGET_FOLDER = './Invoices'; 

async function processWithPersistence() {
    const files = await getFiles(TARGET_FOLDER, '.pdf');
    const checkStmt = db.prepare('SELECT id FROM processed_invoices WHERE file_path = ?');
    const insertStmt = db.prepare(`
        INSERT INTO processed_invoices (file_path, file_name, vendor, invoice_num, date, total)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const file of files) {
        const absolutePath = path.resolve(file);

        // Check if already processed
        if (checkStmt.get(absolutePath)) {
            console.log(`⏩ Skipping (Already in DB): ${path.basename(file)}`);
            continue;
        }

        try {
            console.log(`🧠 AI Analyzing: ${path.basename(file)}...`);
            const dataBuffer = await fs.readFile(file);
            const parser = await new PDFParse(dataBuffer);
            const result = await parser.getText();
            const { text } = result;

            const response = await ollama.chat({
                model: 'llama3.2',
                messages: [{ role: 'user', content: `Extract from this invoice: ${text.slice(0, 4000)}` }],
                format: zodToJsonSchema(InvoiceSchema)
            });

            const inv = InvoiceSchema.parse(JSON.parse(response.message.content));

            // Save to SQLite
            insertStmt.run(
                absolutePath,
                path.basename(file),
                inv.vendorName,
                inv.invoiceNumber,
                inv.date,
                inv.totalAmount
            );

            console.log(`✅ Saved: ${inv.vendorName} - ${inv.invoiceNumber}`);
        } catch (error) {
            console.error(`❌ Error processing ${file}:`, error);
        }
    }
    
    exportToCSV();
}

function exportToCSV() {
    const data = db.prepare('SELECT * FROM processed_invoices').all();
    if (data.length === 0) return;

    const headers = "Vendor,Invoice #,Date,Total,File Name\n";
    const csv = data.map(row => 
        `"${row.vendor}",${row.invoice_num},${row.date},${row.total},"${row.file_name}"`
    ).join("\n");

    fs.writeFileSync('Numbers_Import.csv', headers + csv);
    console.log(`\n📂 Exported ${data.length} records to Numbers_Import.csv`);
}

// ... (getFiles helper function from previous step)
async function getFiles(dir: string, ext: string): Promise<string[]> {
    let results: string[] = [];
    const list = await fs.readdir(dir);
    for (const file of list) {
        const filePath = path.join(dir, file);
        if ((await fs.stat(filePath)).isDirectory()) {
            results = results.concat(await getFiles(filePath, ext));
        } else if (filePath.endsWith(ext)) {
            results.push(filePath);
        }
    }
    return results;
}

processWithPersistence();
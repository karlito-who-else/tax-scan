import * as fs from 'fs-extra';
import * as path from 'node:path';
import { PDFParse } from 'pdf-parse';
import ollama from 'ollama';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// 1. Define the exact data structure you want
const InvoiceSchema = z.object({
    invoiceNumber: z.string(),
    date: z.string(),
    vendorName: z.string(),
    totalAmount: z.number(),
    currency: z.string()
});

const TARGET_FOLDER = './Invoices';
const OUTPUT_FILE = './IntelligentInvoices.csv';

async function processWithAI() {
    const files = await getFiles(TARGET_FOLDER, '.pdf');
    const results = [];

    console.log(`🚀 Starting AI extraction for ${files.length} files...`);

    for (const file of files) {
        const dataBuffer = await fs.readFile(file);
        const parser = await new PDFParse(dataBuffer);
        const result = await parser.getText();
        const { text } = result;

        // 2. Send the raw text to your local AI
        const response = await ollama.chat({
            model: 'llama3.2',
            messages: [{ 
                role: 'user', 
                content: `Extract invoice data from this text: ${text.slice(0, 4000)}` 
            }],
            format: zodToJsonSchema(InvoiceSchema) // Force JSON output
        });

        const invoice = InvoiceSchema.parse(JSON.parse(response.message.content));
        
        results.push({
            File: path.basename(file),
            ...invoice
        });
        
        console.log(`✅ Processed: ${path.basename(file)}`);
    }

    // 3. Save to CSV
    const headers = "File,Vendor,Invoice #,Date,Total,Currency\n";
    const rows = results.map(r => 
        `${r.File},"${r.vendorName}",${r.invoiceNumber},${r.date},${r.totalAmount},${r.currency}`
    ).join("\n");

    await fs.writeFile(OUTPUT_FILE, headers + rows);
    console.log(`\n✨ Done! Open ${OUTPUT_FILE} in Numbers.`);
}

// Recursive file finder (same as previous example)
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

processWithAI().catch(console.error);
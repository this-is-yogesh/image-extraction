import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Output Data Contracts for SKU Image Curation
 */
export interface ProductSKUResult {
  sku: string;
  brand: string;
  product_name: string;
  category: string;
  net_quantity: string;
  pack_type: 'POUCH' | 'TETRAPAK' | 'BOX' | 'BOTTLE' | 'JAR' | 'CAN' | 'OTHER';
  primary_image: string;
  all_images: string[];
  discarded_duplicates: string[];
  classification_rationale: string;
}

export interface CatalogCurationResponse {
  products: ProductSKUResult[];
}

/**
 * Load environment variables from scripts/.env or .env if not already set in process.env
 */
export function loadEnv() {
  const envPaths = [
    path.resolve(process.cwd(), 'scripts/.env'),
    path.resolve(process.cwd(), '.env'),
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
}

/**
 * Token & Performance Optimized Preprocessing:
 * 1. Computes cryptographic SHA-256 hash to eliminate exact duplicate files BEFORE calling Gemini.
 * 2. Converts image to base64 with correct MIME type.
 */
interface ProcessedImage {
  originalFilename: string;
  mimeType: string;
  base64Data: string;
  hash: string;
}

function preprocessImages(imagePaths: string[]): {
  uniqueImages: ProcessedImage[];
  preDiscardedDuplicates: Map<string, string>; // duplicateFilename -> originalFilename
} {
  const seenHashes = new Map<string, string>(); // hash -> originalFilename
  const uniqueImages: ProcessedImage[] = [];
  const preDiscardedDuplicates = new Map<string, string>();

  for (const filePath of imagePaths) {
    const filename = path.basename(filePath);
    if (!fs.existsSync(filePath)) continue;

    const buffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    if (seenHashes.has(hash)) {
      // Duplicate detected! Save token cost by not sending this image to Gemini
      preDiscardedDuplicates.set(filename, seenHashes.get(hash)!);
      continue;
    }

    seenHashes.set(hash, filename);

    // Determine mime type
    const ext = path.extname(filePath).toLowerCase();
    let mimeType = 'image/jpeg';
    if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.webp') mimeType = 'image/webp';

    uniqueImages.push({
      originalFilename: filename,
      mimeType,
      base64Data: buffer.toString('base64'),
      hash,
    });
  }

  return { uniqueImages, preDiscardedDuplicates };
}

/**
 * JSON Schema for Gemini Structured Outputs
 */
const curationResponseSchema = {
  type: 'OBJECT',
  properties: {
    products: {
      type: 'ARRAY',
      description: 'List of unique SKUs identified from the batch of product images.',
      items: {
        type: 'OBJECT',
        properties: {
          sku: {
            type: 'STRING',
            description: 'Canonical or generated SKU identifier (e.g., AMUL-TAAZA-TONED-MILK-1L).',
          },
          brand: {
            type: 'STRING',
            description: 'Brand name (e.g. Amul, Fortune, Aashirvaad).',
          },
          product_name: {
            type: 'STRING',
            description: 'Full product name including variant (e.g. Taaza Homogenised Toned Milk).',
          },
          category: {
            type: 'STRING',
            description: 'Dynamic FMCG / E-commerce product category (e.g., Atta & Flours, Rice & Grains, Dairy Products, Edible Oils, Spices & Masalas, Snacks, Beverages, Personal Care).',
          },
          net_quantity: {
            type: 'STRING',
            description: 'Pack size/volume/weight (e.g. 1L, 1kg, 500g).',
          },
          pack_type: {
            type: 'STRING',
            enum: ['POUCH', 'TETRAPAK', 'BOX', 'BOTTLE', 'JAR', 'CAN', 'OTHER'],
            description: 'Physical packaging format.',
          },
          primary_image: {
            type: 'STRING',
            description: 'Filename of the single best front-facing hero packshot on a clean background.',
          },
          all_images: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description:
              'Ordered gallery: Index 0 MUST be primary_image, followed by back nutrition, side panel/barcode, manufacturer/marketer legal panels, and alternate angles.',
          },
          discarded_duplicates: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Filenames of visually redundant, blurry, or duplicate angles to exclude.',
          },
          classification_rationale: {
            type: 'STRING',
            description: 'Brief explanation of how images were grouped and why the hero shot was selected.',
          },
        },
        required: [
          'sku',
          'brand',
          'product_name',
          'category',
          'net_quantity',
          'pack_type',
          'primary_image',
          'all_images',
        ],
      },
    },
  },
  required: ['products'],
};

/**
 * Core Catalog Vision Curation Function using Gemini REST API with zero external dependencies
 */
export async function curateCatalogImages(
  imageFilePaths: string[],
  apiKey?: string
): Promise<CatalogCurationResponse> {
  loadEnv();
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('GEMINI_API_KEY not found in environment or .env file');
  }

  // 1. Pre-process and hash-deduplicate locally to optimize Gemini token usage
  const { uniqueImages, preDiscardedDuplicates } = preprocessImages(imageFilePaths);

  if (uniqueImages.length === 0) {
    return { products: [] };
  }

  console.log(`[Token Optimization] Filtered ${imageFilePaths.length} files down to ${uniqueImages.length} unique images for Gemini API.`);
  if (preDiscardedDuplicates.size > 0) {
    console.log(`[Token Optimization] Intercepted ${preDiscardedDuplicates.size} exact duplicate(s) locally:`, Array.from(preDiscardedDuplicates.entries()));
  }

  // 2. Token-Optimized System Instruction
  const systemInstruction = `
You are an expert FMCG & E-commerce Catalog Vision AI.
Analyze the provided batch of product images and accurately:
1. Group images belonging to the same unique SKU / Product Variant (Brand + Product Title + Weight/Volume).
2. Dynamically classify the product into its accurate 'category' (e.g. 'Rice & Grains', 'Atta & Flours', 'Dairy & Milk', 'Edible Oils & Ghee', 'Spices & Masalas', 'Snacks & Confectionery', 'Beverages', etc.).
3. Select the single best Primary Hero Image ('primary_image'):
   - MUST be the clean, front-facing packshot or 3D hero perspective.
   - MUST clearly display the brand logo and product name.
   - MUST NOT be a nutrition label crop, side panel, or manufacturer legal text.
4. Construct the ordered 'all_images' gallery:
   - Index 0: Primary Hero Packshot (exact match with primary_image).
   - Index 1: Back panel (Nutrition facts, ingredients, cooking instructions).
   - Index 2: Side panels (Barcode, FSSAI license, product details).
   - Index 3+: Technical brand panels (e.g. Dairy plant manufacturer list, GCMMF / marketer address cards for that brand).
5. Every single provided image MUST be accounted for either in an 'all_images' list or in 'discarded_duplicates'. Match filenames exactly as labeled.
`.trim();

  // 3. Build Multimodal Content Payload
  const parts: any[] = [];

  for (const img of uniqueImages) {
    parts.push({
      text: `[IMAGE_FILE: ${img.originalFilename}]`,
    });
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64Data,
      },
    });
  }

  parts.push({
    text: `Identify all unique SKUs from the ${uniqueImages.length} labeled images above and return the structured JSON output adhering to the schema.`,
  });

  // 4. Call Gemini API endpoint with structured outputs
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  console.log(`[Gemini API] Sending ${uniqueImages.length} images to ${model}... (analysis usually takes 15-45s)`);
  process.stdout.write('Processing');
  const timer = setInterval(() => {
    process.stdout.write('.');
  }, 2000);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: curationResponseSchema,
        },
      }),
    });
  } finally {
    clearInterval(timer);
    process.stdout.write('\n');
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status} ${response.statusText}): ${errorText}`);
  }

  const result = await response.json();
  const textPart = result?.candidates?.[0]?.content?.parts?.find((p: any) => p.text);
  const textOutput = textPart?.text;

  if (!textOutput) {
    throw new Error('No content returned by Gemini API');
  }

  const parsed: CatalogCurationResponse = JSON.parse(textOutput);

  // 5. Merge pre-discarded hash duplicates back into the output results
  for (const [dupFile, origFile] of preDiscardedDuplicates.entries()) {
    for (const prod of parsed.products) {
      if (prod.primary_image === origFile || prod.all_images.includes(origFile)) {
        if (!prod.discarded_duplicates) prod.discarded_duplicates = [];
        prod.discarded_duplicates.push(dupFile);
      }
    }
  }

  return parsed;
}

// Direct Execution when run directly
const isDirectRun = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  import.meta.url.endsWith(path.basename(process.argv[1]))
);

if (isDirectRun) {
  loadEnv();
  const targetArg = process.argv[2] || 'data/images';
  const imagesDir = path.resolve(process.cwd(), targetArg);

  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
    console.log(`Created image folder: ${imagesDir}`);
    console.log(`Please add product images (.jpg, .jpeg, .png, .webp) to "${targetArg}" and run again.`);
    process.exit(0);
  }

  const files = fs
    .readdirSync(imagesDir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => path.join(imagesDir, f));

  if (files.length === 0) {
    console.log(`No images found in ${imagesDir}.`);
    console.log(`Please place .jpg, .png, or .webp files in "${targetArg}" to curate.`);
    process.exit(0);
  }

  console.log(`Starting curation on ${files.length} images from ${imagesDir}...`);

  curateCatalogImages(files)
    .then((result) => {
      console.log('\n================ CURATION RESULT ================');
      console.log(JSON.stringify(result, null, 2));
      console.log('=================================================\n');
      console.log(`Successfully identified ${result.products.length} unique SKUs.`);
    })
    .catch((err) => {
      console.error('Error running curation:', err.message || err);
      process.exit(1);
    });
}

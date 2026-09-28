# Catalog Images Curator & Excel Generator 🛒✨

An intelligent FMCG & E-Commerce catalog vision AI tool that curates product images using Google's **Gemini Multimodal Vision API** and generates an Excel spreadsheet (`.xlsx`) with embedded product hero images and multi-angle galleries.

---

## 🌟 Features

- **Gemini Vision AI Curation**: Analyzes batches of product packshots, identifies unique SKUs, brand names, product variants, and pack sizes (e.g. `1L`, `500g`, `Tetrapak`, `Pouch`).
- **Token & Cost Optimization**: Computes cryptographic SHA-256 hashes locally to eliminate duplicate images before sending them to Gemini, saving API tokens.
- **Hero Image & Gallery Sorting**:
  - `primary_image`: Clean, front-facing hero packshot.
  - `all_images`: Ordered gallery (Hero → Back nutrition → Barcode/FSSAI side panel → Manufacturer details).
  - `discarded_duplicates`: Visually redundant or blurry angles.
- **Embedded Image Excel Generator**: Generates OpenXML `.xlsx` files with actual embedded thumbnail images using a pure Node.js in-memory ZIP builder (zero external Excel/Python dependencies).

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js**: v18+ (tested on Node v22)
- **Gemini API Key**: Get a free key from [Google AI Studio](https://aistudio.google.com/).

### 2. Configure Your API Key
Open [.env](file:///Users/ranvijaychouhan/Downloads/Work/product-images/.env) and paste your Gemini API key:

```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
```

### 3. Add Product Images
Place your `.jpg`, `.jpeg`, `.png`, or `.webp` product photos in the `data/images/` folder (or specify any folder path when running).

### 4. Run the Pipeline

#### End-to-End: Curate & Generate Excel Workbook
```bash
npm start
# or:
npm run generate-excel
```
> The generated Excel file with embedded images will be saved to:
> `data/images/products-images-curated.xlsx`

#### Run Vision Curation Only (JSON Output in Console)
```bash
npm run curate
```

---

## 🛠️ CLI Usage with Custom Paths

You can pass custom image directories and output file paths directly from the command line:

### Generate Excel from a custom folder:
```bash
npx tsx generate-catalog-excel.ts ./my-photos ./catalogs/output.xlsx
```

### Curate images from a custom folder:
```bash
npx tsx curate-catalog-images.ts ./my-photos
```

---

## 📦 Available NPM Scripts

| Command | Description |
|---|---|
| `npm start` | Runs end-to-end curation and generates the Excel file |
| `npm run generate-excel` | Same as `npm start` |
| `npm run curate` | Runs Gemini curation and outputs JSON to the console |
| `npm run typecheck` | Validates TypeScript types across the project |

---

## 📁 Project Structure

```text
product-images/
├── curate-catalog-images.ts   # Core Gemini vision curation logic & token deduplication
├── generate-catalog-excel.ts  # In-memory OpenXML Excel generator with embedded images
├── data/
│   └── images/                # Default directory to drop your product photos
├── .env                       # Local environment variables (GEMINI_API_KEY)
├── .env.example               # Example environment variable file
├── package.json               # NPM scripts and dependencies (tsx, typescript, @types/node)
├── tsconfig.json              # TypeScript configuration
└── README.md                  # Documentation
```

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { curateCatalogImages } from './curate-catalog-images.ts';
import type { CatalogCurationResponse, ProductSKUResult } from './curate-catalog-images.ts';

export type { CatalogCurationResponse, ProductSKUResult };

/**
 * In-memory Pure TypeScript Zip Builder using Node zlib
 */
interface ZipEntry {
  path: string;
  data: Buffer;
}

function calculateCrc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (~crc) >>> 0;
}

function createZipBuffer(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = entry.data;
    const compressed = zlib.deflateRawSync(data);
    const crc = calculateCrc32(data);
    const nameBuf = Buffer.from(entry.path, 'utf-8');

    // Local file header (30 bytes + filename)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // Signature
    lh.writeUInt16LE(20, 4);         // Version needed
    lh.writeUInt16LE(0, 6);          // General purpose bit flag
    lh.writeUInt16LE(8, 8);          // Compression method (Deflate)
    lh.writeUInt16LE(0, 10);         // Last mod file time
    lh.writeUInt16LE(0, 12);         // Last mod file date
    lh.writeUInt32LE(crc, 14);       // CRC32
    lh.writeUInt32LE(compressed.length, 18); // Compressed size
    lh.writeUInt32LE(data.length, 22);       // Uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);    // Filename length
    lh.writeUInt16LE(0, 28);                 // Extra field length
    nameBuf.copy(lh, 30);

    localHeaders.push(lh, compressed);

    // Central directory header (46 bytes + filename)
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0); // Signature
    ch.writeUInt16LE(20, 4);         // Version made by
    ch.writeUInt16LE(20, 6);         // Version needed
    ch.writeUInt16LE(0, 8);          // General purpose bit flag
    ch.writeUInt16LE(8, 10);         // Compression method (Deflate)
    ch.writeUInt16LE(0, 12);         // Last mod file time
    ch.writeUInt16LE(0, 14);         // Last mod file date
    ch.writeUInt32LE(crc, 16);       // CRC32
    ch.writeUInt32LE(compressed.length, 20); // Compressed size
    ch.writeUInt32LE(data.length, 24);       // Uncompressed size
    ch.writeUInt16LE(nameBuf.length, 28);    // Filename length
    ch.writeUInt16LE(0, 30);                 // Extra field length
    ch.writeUInt16LE(0, 32);                 // Comment length
    ch.writeUInt16LE(0, 34);                 // Disk number start
    ch.writeUInt16LE(0, 36);                 // Internal file attributes
    ch.writeUInt32LE(0, 38);                 // External file attributes
    ch.writeUInt32LE(offset, 42);            // Relative offset of local header
    nameBuf.copy(ch, 46);

    centralHeaders.push(ch);
    offset += lh.length + compressed.length;
  }

  const cdOffset = offset;
  const cdSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // Signature
  eocd.writeUInt16LE(0, 4);                // Number of this disk
  eocd.writeUInt16LE(0, 6);                // Disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8);   // Total entries on this disk
  eocd.writeUInt16LE(entries.length, 10);  // Total entries in central directory
  eocd.writeUInt32LE(cdSize, 12);          // Size of central directory
  eocd.writeUInt32LE(cdOffset, 16);        // Offset of central directory
  eocd.writeUInt16LE(0, 20);               // Comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

function parseUnit(netQty: string): { unit: string; unit_value: string } {
  const q = (netQty || '').trim().toLowerCase();
  if (q.includes('kg')) {
    const val = q.replace('kg', '').trim();
    return { unit: 'kg', unit_value: val || '1' };
  } else if (q.includes('g') && !q.includes('kg')) {
    const val = q.replace('g', '').trim();
    return { unit: 'g', unit_value: val || '500' };
  } else if (q.includes('litre') || q.includes('l')) {
    const val = q.replace('litre', '').replace('l', '').trim();
    return { unit: 'l', unit_value: val || '1' };
  } else if (q.includes('ml')) {
    const val = q.replace('ml', '').trim();
    return { unit: 'ml', unit_value: val || '500' };
  }
  return { unit: 'pc', unit_value: '1' };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Creates an Excel (.xlsx) file with embedded product images in pure TypeScript
 */
export function generateCatalogExcel(
  curationData: CatalogCurationResponse,
  imagesDir: string,
  outputPath: string
): string {
  const headers = [
    'sku', 'name', 'description', 'category', 'hsncode', 'gst',
    'unit', 'unit_value', 'status', 'brand', 'image', 'all_images', '_all_images_filenames'
  ];

  const sharedStrings: string[] = [];
  const stringToId = new Map<string, number>();

  function getStringId(s: string): number {
    const str = String(s ?? '');
    if (!stringToId.has(str)) {
      stringToId.set(str, sharedStrings.length);
      sharedStrings.push(str);
    }
    return stringToId.get(str)!;
  }

  for (const h of headers) {
    getStringId(h);
  }

  interface ImageToEmbed {
    row: number;
    col: number;
    colOffsetEmu: number;
    filePath: string;
    name: string;
  }

  const embeddedImages: ImageToEmbed[] = [];
  const rowsData: string[][] = [];

  for (let rIdx = 0; rIdx < curationData.products.length; rIdx++) {
    const rowNum = rIdx + 1; // 1-based data row
    const prod = curationData.products[rIdx];
    const { unit, unit_value } = parseUnit(prod.net_quantity);

    const primaryImg = prod.primary_image;
    const allImgs = prod.all_images || [];
    const allImgsLabel = allImgs.map((_, i) => `image_${i + 1}`).join(', ');
    const allImgsFilenames = allImgs.join(', ');

    rowsData.push([
      prod.sku || '',
      prod.product_name || '',
      prod.classification_rationale || '',
      prod.category || 'Grocery & Staples',
      '',
      '',
      unit,
      unit_value,
      'active',
      prod.brand || '',
      '',
      allImgsLabel,
      allImgsFilenames,
    ]);

    // 1. Embed primary image into Col 10 (Column 'image')
    if (primaryImg) {
      const imgPath = path.resolve(imagesDir, primaryImg);
      if (fs.existsSync(imgPath)) {
        embeddedImages.push({
          row: rowNum,
          col: 10,
          colOffsetEmu: 0,
          filePath: imgPath,
          name: `Hero_${prod.sku}`,
        });
      }
    }

    // 2. Embed gallery images into Col 11 (Column 'all_images')
    const emuWidth = 457200; // ~48px thumbnail width
    for (let gIdx = 0; gIdx < allImgs.length; gIdx++) {
      const gPath = path.resolve(imagesDir, allImgs[gIdx]);
      if (fs.existsSync(gPath)) {
        embeddedImages.push({
          row: rowNum,
          col: 11,
          colOffsetEmu: gIdx * (emuWidth + 50000),
          filePath: gPath,
          name: `Gallery_${prod.sku}_${gIdx + 1}`,
        });
      }
    }
  }

  // 1. Generate sheet1.xml
  const sheetLines: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '  <sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>',
    '  <sheetFormatPr defaultRowHeight="60" customHeight="1"/>',
    '  <cols>',
    '    <col min="1" max="1" width="18" customWidth="1"/>',
    '    <col min="2" max="2" width="28" customWidth="1"/>',
    '    <col min="3" max="3" width="30" customWidth="1"/>',
    '    <col min="4" max="4" width="18" customWidth="1"/>',
    '    <col min="5" max="6" width="12" customWidth="1"/>',
    '    <col min="7" max="8" width="10" customWidth="1"/>',
    '    <col min="9" max="9" width="10" customWidth="1"/>',
    '    <col min="10" max="10" width="15" customWidth="1"/>',
    '    <col min="11" max="11" width="14" customWidth="1"/>',
    '    <col min="12" max="12" width="35" customWidth="1"/>',
    '    <col min="13" max="13" width="40" customWidth="1"/>',
    '  </cols>',
    '  <sheetData>',
    '    <row r="1" ht="25" customHeight="1">',
  ];

  // Header Row
  for (let c = 0; c < headers.length; c++) {
    const colLetter = c < 26 ? String.fromCharCode(65 + c) : `A${String.fromCharCode(65 + c - 26)}`;
    const sid = getStringId(headers[c]);
    sheetLines.push(`      <c r="${colLetter}1" t="s" s="1"><v>${sid}</v></c>`);
  }
  sheetLines.push('    </row>');

  // Data Rows
  for (let r = 0; r < rowsData.length; r++) {
    const rowNum = r + 2;
    sheetLines.push(`    <row r="${rowNum}" ht="55" customHeight="1">`);
    for (let c = 0; c < rowsData[r].length; c++) {
      const colLetter = c < 26 ? String.fromCharCode(65 + c) : `A${String.fromCharCode(65 + c - 26)}`;
      const val = rowsData[r][c];
      if (val) {
        const sid = getStringId(val);
        sheetLines.push(`      <c r="${colLetter}${rowNum}" t="s" s="0"><v>${sid}</v></c>`);
      } else {
        sheetLines.push(`      <c r="${colLetter}${rowNum}" s="0"/>`);
      }
    }
    sheetLines.push('    </row>');
  }

  sheetLines.push('  </sheetData>', '  <drawing r:id="rId1"/>', '</worksheet>');
  const sheetXml = sheetLines.join('\n');

  // 2. Generate sharedStrings.xml
  const sstLines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`,
  ];
  for (const s of sharedStrings) {
    sstLines.push(`  <si><t>${escapeXml(s)}</t></si>`);
  }
  sstLines.push('</sst>');
  const sharedStringsXml = sstLines.join('\n');

  // 3. Process Images into Drawing XML and Media Files
  const mediaFiles: Array<{ name: string; data: Buffer }> = [];
  const drawingAnchors: string[] = [];
  const drawingRels: string[] = [];

  for (let i = 0; i < embeddedImages.length; i++) {
    const imgIndex = i + 1;
    const item = embeddedImages[i];
    const rawBuffer = fs.readFileSync(item.filePath);
    const ext = path.extname(item.filePath).toLowerCase();

    const mediaName = `image${imgIndex}${ext === '.png' ? '.png' : ext === '.webp' ? '.webp' : '.jpeg'}`;
    mediaFiles.push({ name: `xl/media/${mediaName}`, data: rawBuffer });

    const relId = `rId${imgIndex}`;
    drawingRels.push(
      `  <Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/>`
    );

    drawingAnchors.push(`  <xdr:oneCellAnchor editAs="oneCell">
    <xdr:from>
      <xdr:col>${item.col}</xdr:col>
      <xdr:colOff>${item.colOffsetEmu + 36000}</xdr:colOff>
      <xdr:row>${item.row}</xdr:row>
      <xdr:rowOff>36000</xdr:rowOff>
    </xdr:from>
    <xdr:ext cx="400000" cy="400000"/>
    <xdr:pic>
      <xdr:nvPicPr>
        <xdr:cNvPr id="${imgIndex}" name="${item.name}"/>
        <xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>
      </xdr:nvPicPr>
      <xdr:blipFill>
        <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relId}"/>
        <a:stretch><a:fillRect/></a:stretch>
      </xdr:blipFill>
      <xdr:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="400000" cy="400000"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:oneCellAnchor>`);
  }

  const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
${drawingAnchors.join('\n')}
</xdr:wsDr>`;

  const drawingRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${drawingRels.join('\n')}
</Relationships>`;

  // 4. Static XML Files
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/></patternFill></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="webp" ContentType="image/webp"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
</Types>`;

  const packageRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const sheetRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;

  // 5. Assemble all entries and create zip buffer in memory
  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf-8') },
    { path: '_rels/.rels', data: Buffer.from(packageRelsXml, 'utf-8') },
    { path: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf-8') },
    { path: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRelsXml, 'utf-8') },
    { path: 'xl/styles.xml', data: Buffer.from(stylesXml, 'utf-8') },
    { path: 'xl/sharedStrings.xml', data: Buffer.from(sharedStringsXml, 'utf-8') },
    { path: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf-8') },
    { path: 'xl/worksheets/_rels/sheet1.xml.rels', data: Buffer.from(sheetRelsXml, 'utf-8') },
    { path: 'xl/drawings/drawing1.xml', data: Buffer.from(drawingXml, 'utf-8') },
    { path: 'xl/drawings/_rels/drawing1.xml.rels', data: Buffer.from(drawingRelsXml, 'utf-8') },
    ...mediaFiles.map((m) => ({ path: m.name, data: m.data })),
  ];

  const zipBuffer = createZipBuffer(entries);
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, zipBuffer);

  console.log(`[Excel Output] Generated pure TypeScript .xlsx with ${embeddedImages.length} embedded images at: ${outputPath}`);
  return outputPath;
}

/**
 * End-to-End Orchestrator:
 * 1. Curates images using Gemini Multimodal Vision API
 * 2. Generates an Excel workbook with embedded hero images and multi-angle galleries
 */
export async function curateAndGenerateExcel(
  imagesDir: string = path.resolve(process.cwd(), 'data/images'),
  outputXlsxPath: string = path.resolve(process.cwd(), 'data/images/products-images-curated.xlsx')
) {
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  const files = fs
    .readdirSync(imagesDir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => path.join(imagesDir, f));

  if (files.length === 0) {
    console.log(`No images found in ${imagesDir}. Please add .jpg, .png, or .webp files to curate.`);
    return { curationResult: { products: [] }, outputXlsxPath };
  }

  console.log(`[Step 1/2] Curating ${files.length} images using Gemini Vision AI...`);
  const curationResult = await curateCatalogImages(files);

  console.log(`[Step 2/2] Generating Excel workbook with embedded images: ${outputXlsxPath}...`);
  generateCatalogExcel(curationResult, imagesDir, outputXlsxPath);

  return {
    curationResult,
    outputXlsxPath,
  };
}

// Standalone execution when run directly
const isDirectRun = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  import.meta.url.endsWith(path.basename(process.argv[1]))
);

if (isDirectRun) {
  const targetDir = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : path.resolve(process.cwd(), 'data/images');
  const targetOut = process.argv[3] ? path.resolve(process.cwd(), process.argv[3]) : path.resolve(targetDir, 'products-images-curated.xlsx');

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    console.log(`Created image folder: ${targetDir}`);
    console.log(`Please add product images (.jpg, .jpeg, .png, .webp) to "${targetDir}" and run again.`);
    process.exit(0);
  }

  curateAndGenerateExcel(targetDir, targetOut)
    .then((res) => {
      console.log(`\n🎉 Completed! Curated Excel workbook with embedded images saved to:\n${res.outputXlsxPath}`);
    })
    .catch((err) => {
      console.error('Error generating catalog Excel:', err.message || err);
      process.exit(1);
    });
}

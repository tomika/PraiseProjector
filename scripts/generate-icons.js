import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import png2icons from "png2icons";
import sharp from "sharp";

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Source PNG from the webapp's own image set (NOT the frozen legacy public/app tree).
const inputPng = path.join(__dirname, "../public/images/pp.png");
const outputDir = path.join(__dirname, "../dist/build");
const outputFilename = "icon";

async function generateIcons() {
  console.log("Reading PNG file:", inputPng);

  // Resize source PNG to 1024x1024 (required for high-quality icons)
  console.log("Resizing PNG to 1024x1024...");
  const pngBuffer = await sharp(inputPng).resize(1024, 1024).png().toBuffer();

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Also save the PNG for Linux
  fs.writeFileSync(path.join(outputDir, `${outputFilename}.png`), pngBuffer);
  console.log(`Created ${outputFilename}.png`);

  // Generate ICNS for macOS
  console.log("Generating ICNS for macOS...");
  const icns = png2icons.createICNS(pngBuffer, png2icons.BILINEAR, 0);
  if (icns) {
    fs.writeFileSync(path.join(outputDir, `${outputFilename}.icns`), icns);
    console.log(`Created ${outputFilename}.icns`);
  } else {
    console.error("Failed to create ICNS");
  }

  // Generate ICO for Windows (with all required sizes including 256x256)
  console.log("Generating ICO for Windows...");
  const ico = png2icons.createICO(pngBuffer, png2icons.BILINEAR, 0, true, true);
  if (ico) {
    fs.writeFileSync(path.join(outputDir, `${outputFilename}.ico`), ico);
    console.log(`Created ${outputFilename}.ico`);
  } else {
    console.error("Failed to create ICO");
  }

  // Generate PWA icons for web app
  const pwaOutputDir = path.join(__dirname, "../public/assets");
  console.log("Generating PWA icons...");

  const generatedSizes = [];
  for (const size of [48, 64, 192, 512]) {
    const png = await sharp(inputPng).resize(size, size).png().toBuffer();
    fs.writeFileSync(path.join(pwaOutputDir, `pp-${size}.png`), png);
    console.log(`Created pp-${size}.png`);
    generatedSizes.push(size);
  }

  console.log("Done! Icons generated successfully.");
  console.log("");
  console.log("The following icon files are now available:");
  console.log(`  - ${outputFilename}.ico (Windows)`);
  console.log(`  - ${outputFilename}.icns (macOS)`);
  console.log(`  - ${outputFilename}.png (Linux)`);
  for (const size of generatedSizes) console.log(`  - pp-${size}.png (PWA)`);
}

generateIcons().catch(console.error);

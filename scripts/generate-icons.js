import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import png2icons from "png2icons";
import sharp from "sharp";

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use the source PNG from public/app (single source of truth for icon generation)
const inputPng = path.join(__dirname, "../public/app/images/pp.png");
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
  
  // 192x192 for PWA manifest
  const png192 = await sharp(inputPng).resize(192, 192).png().toBuffer();
  fs.writeFileSync(path.join(pwaOutputDir, "pp-192.png"), png192);
  console.log("Created pp-192.png");
  
  // 512x512 for PWA manifest
  const png512 = await sharp(inputPng).resize(512, 512).png().toBuffer();
  fs.writeFileSync(path.join(pwaOutputDir, "pp-512.png"), png512);
  console.log("Created pp-512.png");

  console.log("Done! Icons generated successfully.");
  console.log("");
  console.log("The following icon files are now available:");
  console.log(`  - ${outputFilename}.ico (Windows)`);
  console.log(`  - ${outputFilename}.icns (macOS)`);
  console.log(`  - ${outputFilename}.png (Linux)`);
  console.log("  - pp-192.png (PWA)");
  console.log("  - pp-512.png (PWA)");
}

generateIcons().catch(console.error);

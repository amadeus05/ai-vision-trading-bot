import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

/**
 * TUNING PARAMETERS
 * Adjust these values to find the perfect crop.
 */
const cropConfig = {
    left: 48,    // distance from left edge
    top: 46,      // distance from top edge
    width: 1836,  // width of the result
    height: 1004,  // height of the result
};

const INPUT_FILE = 'legend_15m.png'; // Change this to your source image
const PREVIEW_FILE = 'debug-preview.png';
const RESULT_FILE = 'debug-result.png';

async function runCropDebugger() {
    try {
        if (!fs.existsSync(INPUT_FILE)) {
            console.error(`❌ Error: Input file "${INPUT_FILE}" not found in current directory.`);
            console.log('Available images:', fs.readdirSync('.').filter(f => f.endsWith('.png')));
            return;
        }

        console.log(`🚀 Starting crop debugger for ${INPUT_FILE}...`);
        console.log(`📍 Config: Left: ${cropConfig.left}, Top: ${cropConfig.top}, Width: ${cropConfig.width}, Height: ${cropConfig.height}`);

        const metadata = await sharp(INPUT_FILE).metadata();
        console.log(`🖼️  Original Image: ${metadata.width}x${metadata.height}`);

        // 1. Create Preview (Original with a red box)
        // We use an SVG overlay to draw the rectangle
        const svgOverlay = Buffer.from(`
            <svg width="${metadata.width}" height="${metadata.height}">
                <rect x="${cropConfig.left}" y="${cropConfig.top}" width="${cropConfig.width}" height="${cropConfig.height}" 
                      fill="rgba(255, 0, 0, 0.3)" stroke="red" stroke-width="4" />
            </svg>
        `);

        await sharp(INPUT_FILE)
            .composite([{ input: svgOverlay, top: 0, left: 0 }])
            .toFile(PREVIEW_FILE);

        console.log(`✅ Preview created: ${PREVIEW_FILE} (Red box shows the crop area)`);

        // 2. Create Result (The actual crop)
        await sharp(INPUT_FILE)
            .extract(cropConfig)
            .toFile(RESULT_FILE);

        console.log(`✅ Crop result created: ${RESULT_FILE}`);
        console.log('\n--- Final Code Snippet ---');
        console.log(`.extract({`);
        console.log(`  left: ${cropConfig.left},`);
        console.log(`  top: ${cropConfig.top},`);
        console.log(`  width: ${cropConfig.width},`);
        console.log(`  height: ${cropConfig.height}`);
        console.log(`})`);
        console.log('--------------------------');

    } catch (error) {
        console.error('❌ Error during processing:', error);
    }
}

runCropDebugger();

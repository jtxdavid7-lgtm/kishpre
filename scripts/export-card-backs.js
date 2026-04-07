import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import sharp from 'sharp';

const INPUT_DIR = resolve('public/card-backs');

async function exportOne(name) {
  const src = resolve(INPUT_DIR, `${name}.svg`);
  const dst = resolve(INPUT_DIR, `${name}.png`);
  await sharp(src, { density: 320 })
    .resize(600, 840, { fit: 'contain', background: { r: 4, g: 6, b: 17, alpha: 0 } })
    .png({ compressionLevel: 8 })
    .toFile(dst);
  console.log(`Exported ${name}.png`);
}

async function main() {
  const files = await readdir(INPUT_DIR);
  const svgs = files.filter((file) => file.endsWith('.svg'));
  for (const file of svgs) {
    const name = file.replace('.svg', '');
    await exportOne(name);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

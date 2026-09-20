import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { TABLE_SAMPLES } from "../src/components/tableSamples";
import { generateTableTypst } from "../src/components/tableTypst";

/**
 * Renders the new-table sample thumbnails to `public/table-samples` with the
 * Typst CLI. Run after changing a sample: `bun run samples:render`.
 */
const root = resolve(import.meta.dir, "..");
const outDir = resolve(root, "public/table-samples");
const workDir = resolve(tmpdir(), "typsastra-table-samples");
mkdirSync(outDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

for (const sample of TABLE_SAMPLES) {
  const table = sample.build();
  const code = generateTableTypst(table);
  // Matching the preview path: `fr` tracks need a definite width.
  const usesFractions = table.columnSizes.some(size => size.endsWith("fr"));
  const body = usesFractions ? `#block(width: 480pt)[\n${code}\n]` : code;
  const document = `#set page(width: auto, height: auto, margin: 12pt)\n#set text(size: 11pt)\n${body}\n`;
  const typPath = resolve(workDir, `${sample.id}.typ`);
  const svgPath = resolve(outDir, `${sample.id}.svg`);
  await Bun.write(typPath, document);
  const result = Bun.spawnSync(["typst", "compile", typPath, svgPath]);
  if (result.exitCode !== 0) {
    console.error(`Failed to render "${sample.id}":\n${result.stderr.toString()}`);
    process.exit(1);
  }
  console.log(`rendered ${sample.id}`);
}

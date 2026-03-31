import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import sharp from "sharp";
import { optimizeAssets } from "../src/index.js";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "img-opt-"));
  createdDirs.push(root);

  const assetsDir = join(root, "src", "assets");
  const componentsDir = join(root, "src", "components");

  await mkdir(assetsDir, { recursive: true });
  await mkdir(componentsDir, { recursive: true });

  await writeFile(
    join(assetsDir, "icon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="40" height="40" fill="#ff0000"></rect></g></svg>`,
  );
  await writeFile(
    join(assetsDir, "hero.png"),
    await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 4,
        background: { r: 0, g: 128, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer(),
  );
  await writeFile(
    join(componentsDir, "App.ts"),
    `export const hero = "../assets/hero.png";\nexport const icon = "../assets/icon.svg";\n`,
  );

  return assetsDir;
}

test("optimizes assets and updates references", async () => {
  const assetsDir = await createFixture();
  const summary = await optimizeAssets(assetsDir, {
    sourceDir: join(assetsDir, ".."),
    webpThreshold: 8 * 1024,
    logger: () => undefined,
  });

  const source = await readFile(join(assetsDir, "..", "components", "App.ts"), "utf8");
  const webpStats = await stat(join(assetsDir, "hero.webp"));
  const svgContents = await readFile(join(assetsDir, "icon.svg"), "utf8");

  assert.equal(summary.scanned, 2);
  assert.equal(summary.changed, 2);
  assert.equal(summary.failed, 0);
  assert.equal(source.includes("../assets/hero.webp"), true);
  assert.equal(source.includes("../assets/icon.svg"), true);
  assert.equal(webpStats.size > 0, true);
  assert.equal(svgContents.includes("</rect>"), false);
});

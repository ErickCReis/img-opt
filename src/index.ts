import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import sharp from "sharp";
import { optimize as svgo } from "svgo";

const IMAGE_EXTENSIONS = [".svg", ".png"] as const;
const SOURCE_EXTENSIONS = [".vue", ".ts", ".tsx", ".js", ".jsx", ".css", ".scss"] as const;

export type OptimizeLogger = (message: string) => void;

export interface OptimizeAssetsOptions {
  cwd?: string;
  sourceDir?: string;
  ignoreDirs?: string[];
  webpThreshold?: number;
  webpQuality?: number;
  maxWidth?: number;
  keepOriginals?: boolean;
  dryRun?: boolean;
  logger?: OptimizeLogger;
}

export interface OptimizationSummary {
  assetsDir: string;
  sourceDir: string;
  scanned: number;
  changed: number;
  skipped: number;
  failed: number;
  bytesBefore: number;
  bytesAfter: number;
  savedBytes: number;
}

interface ImageEntry {
  path: string;
  size: number;
  ext: (typeof IMAGE_EXTENSIONS)[number];
}

interface OptimizeResult {
  newPath: string;
  size: number;
}

const DEFAULT_IGNORE_DIRS = ["ico"];
const DEFAULT_WEBP_THRESHOLD = 100 * 1024;
const DEFAULT_WEBP_QUALITY = 82;
const DEFAULT_MAX_WIDTH = 3840;

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${(bytes / 1024).toFixed(2)}KB`;

const toPosixPath = (value: string): string => value.replaceAll("\\", "/");

const resolveFrom = (cwd: string, value: string): string =>
  isAbsolute(value) ? value : resolve(cwd, value);

const maybePrefixDotSlash = (value: string): string =>
  value.startsWith(".") ? value : `./${value}`;

const inferSourceDir = (assetsDir: string): string => {
  const normalized = toPosixPath(assetsDir);
  const marker = "/src/";
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex >= 0) {
    return normalized.slice(0, markerIndex + marker.length - 1);
  }

  if (normalized.endsWith("/src")) {
    return normalized;
  }

  return dirname(assetsDir);
};

async function walk(
  dir: string,
  exts: readonly string[],
  ignoreDirs: Set<string>,
): Promise<string[]> {
  const results: string[] = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);

    if (entry.isDirectory()) {
      if (!ignoreDirs.has(entry.name)) {
        results.push(...(await walk(full, exts, ignoreDirs)));
      }
      continue;
    }

    if (exts.includes(extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }

  return results;
}

async function toWebp(
  filePath: string,
  { maxWidth, quality, dryRun }: { maxWidth: number; quality: number; dryRun: boolean },
): Promise<OptimizeResult> {
  const webpPath = filePath.replace(/\.(svg|png)$/i, ".webp");

  let pipeline: sharp.Sharp;
  if (extname(filePath).toLowerCase() === ".svg") {
    const buffer = await readFile(filePath);
    const header = buffer.subarray(0, 1024).toString();
    const widthMatch = header.match(/(?:width|viewBox="[\d.]+ [\d.]+ )([\d.]+)/);
    const intrinsicWidth = Number(widthMatch?.[1] ?? 0);
    const targetWidth = Math.min(intrinsicWidth * 2 || 2048, maxWidth);
    const density = Math.max(72, Math.round((targetWidth / (intrinsicWidth || 1)) * 72));
    pipeline = sharp(buffer, { density });
  } else {
    pipeline = sharp(filePath);
  }

  const metadata = await pipeline.metadata();
  if ((metadata.width ?? 0) > maxWidth) {
    pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  }

  if (!dryRun) {
    await pipeline.webp({ quality, effort: 6 }).toFile(webpPath);
  } else {
    await pipeline.webp({ quality, effort: 6 }).toBuffer();
  }

  const size = dryRun
    ? (await pipeline.webp({ quality, effort: 6 }).toBuffer()).byteLength
    : (await stat(webpPath)).size;
  return { newPath: webpPath, size };
}

async function optimizeSvg(filePath: string, dryRun: boolean): Promise<OptimizeResult | null> {
  const raw = await readFile(filePath, "utf8");
  const { data } = svgo(raw, { multipass: true, path: filePath });

  if (Buffer.byteLength(data) >= Buffer.byteLength(raw)) {
    return null;
  }

  if (!dryRun) {
    await writeFile(filePath, data);
  }

  return { newPath: filePath, size: Buffer.byteLength(data) };
}

async function optimizePng(filePath: string, dryRun: boolean): Promise<OptimizeResult | null> {
  const raw = await readFile(filePath);
  const optimized = await sharp(raw).png({ compressionLevel: 9, effort: 10 }).toBuffer();

  if (optimized.byteLength >= raw.byteLength) {
    return null;
  }

  if (!dryRun) {
    await writeFile(filePath, optimized);
  }

  return { newPath: filePath, size: optimized.byteLength };
}

async function updateRefs(
  sourceFiles: string[],
  oldPath: string,
  newPath: string,
  sourceDir: string,
  projectDir: string,
  dryRun: boolean,
  logger: OptimizeLogger,
): Promise<number> {
  if (oldPath === newPath) {
    return 0;
  }

  let touched = 0;

  for (const file of sourceFiles) {
    const content = await readFile(file, "utf8");
    let updated = content;

    const replacements = new Map<string, string>([
      [toPosixPath(relative(sourceDir, oldPath)), toPosixPath(relative(sourceDir, newPath))],
      [toPosixPath(relative(projectDir, oldPath)), toPosixPath(relative(projectDir, newPath))],
      [
        toPosixPath(relative(dirname(file), oldPath)),
        toPosixPath(relative(dirname(file), newPath)),
      ],
    ]);

    for (const [from, to] of replacements) {
      const variants = new Map<string, string>([
        [from, to],
        [from.replaceAll(" ", "%20"), to.replaceAll(" ", "%20")],
      ]);

      if (from.startsWith("../") || from.startsWith("./")) {
        variants.set(maybePrefixDotSlash(from), maybePrefixDotSlash(to));
        variants.set(
          maybePrefixDotSlash(from).replaceAll(" ", "%20"),
          maybePrefixDotSlash(to).replaceAll(" ", "%20"),
        );
      }

      for (const [needle, replacement] of variants) {
        if (needle.length > 0) {
          updated = updated.replaceAll(needle, replacement);
        }
      }
    }

    if (updated !== content) {
      touched += 1;
      logger(`    ref  ${toPosixPath(relative(projectDir, file))}`);
      if (!dryRun) {
        await writeFile(file, updated);
      }
    }
  }

  return touched;
}

export async function optimizeAssets(
  assetsPath: string,
  options: OptimizeAssetsOptions = {},
): Promise<OptimizationSummary> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const assetsDir = resolveFrom(cwd, assetsPath);
  const sourceDir = resolveFrom(cwd, options.sourceDir ?? inferSourceDir(assetsDir));
  const projectDir = dirname(sourceDir);
  const ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const logger = options.logger ?? console.log;
  const dryRun = options.dryRun ?? false;
  const webpThreshold = options.webpThreshold ?? DEFAULT_WEBP_THRESHOLD;
  const webpQuality = options.webpQuality ?? DEFAULT_WEBP_QUALITY;
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;

  const imageFiles = await walk(assetsDir, IMAGE_EXTENSIONS, ignoreDirs);
  const images = await Promise.all(
    imageFiles.map(async (filePath) => {
      const fileStat = await stat(filePath);
      return {
        path: filePath,
        size: fileStat.size,
        ext: extname(filePath).toLowerCase() as ImageEntry["ext"],
      };
    }),
  );

  images.sort((left, right) => right.size - left.size);

  if (images.length === 0) {
    return {
      assetsDir,
      sourceDir,
      scanned: 0,
      changed: 0,
      skipped: 0,
      failed: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      savedBytes: 0,
    };
  }

  const sourceFiles = await walk(sourceDir, SOURCE_EXTENSIONS, ignoreDirs);
  let changed = 0;
  let skipped = 0;
  let failed = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const image of images) {
    const label = toPosixPath(relative(projectDir, image.path));
    logger(`  ${label} ...`);

    try {
      let result: OptimizeResult | null = null;

      if (image.size >= webpThreshold) {
        result = await toWebp(image.path, {
          maxWidth,
          quality: webpQuality,
          dryRun,
        });
        await updateRefs(
          sourceFiles,
          image.path,
          result.newPath,
          sourceDir,
          projectDir,
          dryRun,
          logger,
        );

        if (!options.keepOriginals && !dryRun) {
          await unlink(image.path);
        }
      } else if (image.ext === ".svg") {
        result = await optimizeSvg(image.path, dryRun);
      } else {
        result = await optimizePng(image.path, dryRun);
      }

      if (!result) {
        skipped += 1;
        logger("    already optimal");
        continue;
      }

      changed += 1;
      bytesBefore += image.size;
      bytesAfter += result.size;
      const savedPercent = Math.max(0, Math.floor((1 - result.size / image.size) * 100));
      logger(`    ${formatBytes(image.size)} -> ${formatBytes(result.size)} (-${savedPercent}%)`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger(`    FAILED: ${message}`);
    }
  }

  return {
    assetsDir,
    sourceDir,
    scanned: images.length,
    changed,
    skipped,
    failed,
    bytesBefore,
    bytesAfter,
    savedBytes: bytesBefore - bytesAfter,
  };
}

export { formatBytes };

#!/usr/bin/env node

import { parseArgs } from "node:util";
import process from "node:process";
import { formatBytes, optimizeAssets } from "./index.js";

const helpText = `img-opt

Optimize SVG and PNG assets for a web application.

Usage:
  npx @erickcreis/img-opt <path> [options]

Arguments:
  <path>                  Path to the assets directory to optimize.

Options:
  -s, --source-dir <dir>  Directory to scan for source-file references.
  -i, --ignore-dir <dir>  Directory name to skip. Repeatable.
  -t, --threshold <kb>    Convert files at or above this size to WebP. Default: 100
  -q, --quality <0-100>   WebP quality. Default: 82
  -w, --max-width <px>    Max raster width for WebP output. Default: 3840
  -k, --keep-originals    Keep original files after WebP conversion.
  -n, --dry-run           Show planned changes without writing files.
  -h, --help              Show this help text.
`;

const fail = (message: string): never => {
  console.error(`img-opt: ${message}`);
  process.exit(1);
};

const parsePositiveInteger = (label: string, value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer.`);
  }

  return parsed;
};

const getRequiredPath = (value: string | undefined): string => {
  if (value !== undefined) {
    return value;
  }

  console.log(helpText);
  return fail("missing required <path> argument.");
};

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "source-dir": { type: "string", short: "s" },
      "ignore-dir": { type: "string", short: "i", multiple: true },
      threshold: { type: "string", short: "t" },
      quality: { type: "string", short: "q" },
      "max-width": { type: "string", short: "w" },
      "keep-originals": { type: "boolean", short: "k" },
      "dry-run": { type: "boolean", short: "n" },
    },
  });

  if (parsed.values.help) {
    console.log(helpText);
    return;
  }

  const targetPath = getRequiredPath(parsed.positionals.at(0));
  const options = {
    logger: (message: string) => console.log(message),
    ...(parsed.values["source-dir"] ? { sourceDir: parsed.values["source-dir"] } : {}),
    ...(parsed.values["ignore-dir"]?.length ? { ignoreDirs: parsed.values["ignore-dir"] } : {}),
    ...(parsed.values.threshold
      ? {
          webpThreshold: parsePositiveInteger("threshold", parsed.values.threshold) * 1024,
        }
      : {}),
    ...(parsed.values.quality
      ? {
          webpQuality: parsePositiveInteger("quality", parsed.values.quality),
        }
      : {}),
    ...(parsed.values["max-width"]
      ? {
          maxWidth: parsePositiveInteger("max-width", parsed.values["max-width"]),
        }
      : {}),
    ...(parsed.values["keep-originals"] ? { keepOriginals: true } : {}),
    ...(parsed.values["dry-run"] ? { dryRun: true } : {}),
  };
  const summary = await optimizeAssets(targetPath, options);

  if (summary.scanned === 0) {
    console.log("Nothing to optimize.");
    return;
  }

  console.log("");
  console.log(
    `Done. ${formatBytes(summary.bytesBefore)} -> ${formatBytes(summary.bytesAfter)} (saved ${formatBytes(summary.savedBytes)})`,
  );
  console.log(
    `Scanned ${summary.scanned} file(s), changed ${summary.changed}, skipped ${summary.skipped}, failed ${summary.failed}.`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`img-opt: ${message}`);
  process.exit(1);
});

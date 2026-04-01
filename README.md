# `@erickreis/img-opt`

Simple CLI to optimize SVG and PNG assets in a web app.

## Usage

```bash
npx @erickreis/img-opt src/assets
```

By default the command:

- scans the target directory for `.svg` and `.png`
- converts files `>= 100KB` to `.webp`
- optimizes smaller SVGs with SVGO
- recompresses smaller PNGs with `sharp`
- updates matching source-file references under the inferred `src` directory

## Options

```bash
npx @erickreis/img-opt <path> [options]

Options:
  -s, --source-dir <dir>  Directory to scan for source-file references
  -i, --ignore-dir <dir>  Directory name to skip. Repeatable
  -t, --threshold <kb>    Convert files at or above this size to WebP
  -q, --quality <0-100>   WebP quality
  -w, --max-width <px>    Max raster width for WebP output
  -k, --keep-originals    Keep original files after WebP conversion
  -n, --dry-run           Print changes without writing files
  -h, --help              Show help
```

## Local development

```bash
bun install
bun run build
bun run typecheck
bun run lint
bun test
```

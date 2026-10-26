# OpenTurnitout

Clean papers and code before you share. Strips hidden characters, removes document
metadata, and rewrites prose so it reads like a person wrote it — leaving equations,
citations, formatting, and code logic untouched.

Runs entirely on your machine. The 12B humanizer model is downloaded once, on first
launch, and never leaves your disk.

# Turnitout

> **⚠️ IMPORTANT: Before running this app, you must download the AI engine.**
> Run `npm run setup` in your terminal to automatically fetch the correct `llama-server` files for your operating system. 

*(If the setup script fails, you can manually download the `llama.cpp` release for your OS from [GitHub](https://github.com/ggml-org/llama.cpp/releases), extract it, and place `llama-server.exe` and all `.dll` files into a folder named `bin` in the project root).*

## Development

    npm install
    npm run setup      # downloads llama-server for your platform into ./bin
    npm start

The first launch shows a setup screen: it detects your RAM, recommends the right
quantization, and downloads the model (3.9–12.7 GB depending on choice). Subsequent
launches skip the download and start the sidecar directly.

## Building installers

    npm run build:mac     # .dmg (arm64 + x64)
    npm run build:win     # .exe installer
    npm run build:linux   # .AppImage

Before building for a platform, run `node scripts/fetch-llama-server.js --all`
(or build on that platform so only one binary is fetched). The `bin/` directory is
bundled into the installer's resources.

## What gets shipped in the installer

- Electron shell + Turnitout renderer (~150–200 MB)
- `llama-server` binary for the target platform (~30 MB with shared libs)
- **Not** the model weights — those are downloaded on first run from
  `jialinyyzz/humanizer-GGUF` on Hugging Face.

## Hardware requirements

| RAM | Model | Quality | Speed |
| :--- | :--- | :--- | :--- |
| 32 GB+ | Q8_0 (12.7 GB) | Best | Fast with GPU, slow on CPU |
| 16 GB | Q6_K (10.0 GB) | No measurable loss | Good |
| 14 GB | Q4_K_M (7.6 GB) | Slight loss, recommended | Good |
| 12 GB | Q3-QAT (5.6 GB) | Small loss | OK |
| 8 GB | 2-bit (3.9 GB) | Lowest quality | Slow, may swap |

GPU offload (`-ngl 99`) uses Metal on macOS, Vulkan on Windows, CUDA/Vulkan on Linux.
Without a GPU, inference runs on CPU and will be 10–30× slower.

If the machine has less than 8 GB RAM, the app offers a rules-only mode with no AI.

## Code signing

For customer distribution:

- **macOS:** set `CSC_LINK` and `CSC_KEY_PASSWORD` env vars, then `npm run build:mac`.
  Notarization requires an Apple Developer ID and `notarize: true` in
  `electron-builder.yml` (add `afterSign` hook).
- **Windows:** set `CSC_LINK` to a `.pfx` and `CSC_KEY_PASSWORD`, then
  `npm run build:win`. Unsigned installers trigger SmartScreen warnings.
- **Linux:** AppImage needs no signing, but shipping a detached signature is
  recommended.

## Known limitations

- The model occasionally shifts a single word of a date or name. Every AI rewrite is
  verified for missing numbers, language flips, and length blow-ups; failures are
  surfaced in a review panel. Users should still proofread numbers.
- Text inside LaTeX commands (e.g. `\textbf{...}`) is not rewritten — that's
  deliberate, to prevent brace corruption.
- Python docstrings are not rewritten; only true comments (`#`, `//`, `/* */`,
  `<!-- -->`).
- DOCX footnotes, headers, and footers are not processed.
- Detector results vary by detector and by date. The model card reports 95%
  human-judged on Originality.ai at its strictest setting — treat that as a
  baseline, not a guarantee.

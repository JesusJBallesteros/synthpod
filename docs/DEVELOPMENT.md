# Developing SynthPod

The user manual is the [README](../README.md).

## Status

Everything planned is built. In the order it was done: parsing of all label patterns, file input, the analysis panel, Piper and Kokoro engines, per-speaker casting, the resumable chunk cache, output settings (modes, pauses, normalisation, loudness, MP3 options, ID3 tags, Info/Xing header), presets, the pronunciation dictionary, and the installable offline app.

Also done: light/dark/system appearance, an interface in English, Spanish and German, and a layout that uses two columns on wide screens.

Then: a tool to step through numbers and other items that may be read oddly, chapter markers in the MP3, captions export (`.srt`, `.vtt`), and in-browser translation with Opus-MT.

Most recently: on narrow screens the two columns become two stages (Text, Audio) with a switch under the title, and a finished translation is reviewed turn by turn, side by side with the original, in a dialog.

Then: PDF documents without speakers (papers, reports) are read as running text for one voice, with a chapter per section and a cue sheet export.

Latest (1.1.0): a check-for-updates button and legal notice in the footer, the size of the render cache beside its clear button, a reworked PDF reader (columns, side notes, figures, tables, boxes, references, headings by typeface), and the page logic split into modules.

Optional cloud speech engines were considered and dropped: the local engines are enough.

Considered and left out, on purpose or for lack of data:

- VBR encoding (the lamejs encoder is CBR only).
- A cover image in the MP3 (built, then removed as unnecessary).
- A spoken intro/outro and a jingle file.
- Loading your own Piper model files, for a fully offline first use.
- A toggle to keep speaker labels in the spoken text.
- Each Piper voice's licence in the picker (not in the catalogue file; needs each `MODEL_CARD`).
- Number expansion: left to the engines, which already read numbers in the right language.

**Service worker testing:** the development browser used to build this does not support service workers, so offline mode, install and the first-visit reload have to be checked by hand with `npm run preview:pages`. They were confirmed working in Brave.

## Run, test, build

```bash
npm install
npm run dev
```

```bash
npm test
```

```bash
npm run build
npm run preview:pages
```

`preview:pages` serves `dist/` at `http://localhost:4180/synthpod/` as plain static files with no special headers, like GitHub Pages. `npm run preview` (Vite's own) also works but sends the isolation headers itself, so it does not exercise the first-visit reload.

Opening `dist/index.html` from `file://` does not work, because browsers block ES modules, workers and WASM there.

## Deploying

Pushing to `main` runs [.github/workflows/deploy.yml](../.github/workflows/deploy.yml), which tests, builds and publishes `dist/` to GitHub Pages. In the repository settings, set **Pages → Source** to **GitHub Actions** once.

## Layout

| Folder | Contents |
|---|---|
| `src/parse/` | Label detection, clean-up, speaker edits, language detection, text normalisation, file input, and their tests |
| `src/engines/` | The `TTSEngine` interface, Piper and Kokoro adapters, the TTS worker and its client |
| `src/audio/` | Chunk planning and rendering, the chunk cache, PCM assembly, loudness and limiter, MP3 encoding, the Info frame, captions and chapter frames |
| `src/translate/` | Which Opus-MT models exist and how to route between languages, the translation worker and its client |
| `src/ui/` | The page logic (see below), the analysis panel, the review tool, settings and persistence, translations of the interface, service-worker registration |
| `src/pwa/sw.js` | Service worker template; `vite.config.ts` writes `dist/sw.js` from it with the build's file list |
| `public/` | Web app manifest and icons |
| `scripts/` | `serve-pages.mjs`, the GitHub Pages look-alike server |

## Screenshots for the manual

The README's pictures are in `docs/images/`. Each view is shown once, and between them they cover the wide, narrow and phone layouts, both themes and two interface languages, with an invented sample transcript. Retake the affected ones when the layout changes.

## Interface text and translations

No visible text is written in `index.html` or in the code. Every string lives in `src/ui/locales/en.ts` under a key, and `es.ts` and `de.ts` must define the same keys (TypeScript reports a missing one).

- Static markup uses `data-i18n="key"` (text), `data-i18n-html="key"` (trusted markup from our own files) and `data-i18n-attr="title:key placeholder:key"` (attributes).
- Code calls `t('key', { name })`, or `plural('key', n)` for keys that come as a `.one` / `.other` pair.
- To add a language: copy `en.ts`, translate the values, and register it in `MESSAGES` and `LOCALES` in `src/ui/i18n.ts`.

The theme is a `data-theme` attribute on `<html>` (absent = follow the system); colours are defined once in `style.css` with `light-dark()`.

The narrow-screen stage is a `data-stage` attribute on `<body>`; below 1100 px the stylesheet hides the column of the other stage.

## Things worth knowing

- **Piper phoneme ids** must come from each voice's own `phoneme_id_map`. Voices differ in which symbols they know, and an unknown id crashes inference.
- **The Piper phonemizer leaks memory** and aborts after about 70 calls, so the adapter recreates it every 25.
- **Multi-threading can fail to start.** onnxruntime runs its threads as workers created from inside our speech worker. Where a browser or embedded web view refuses those nested workers, creating a session never finishes. The worker reports when it starts the engine (`ProgressFn` stage `'engine'`); if nothing follows within 40 seconds, `src/engines/client.ts` restarts the worker in single-thread mode, re-sends the request and remembers the choice in `localStorage` (`synthpod.singleThread`; remove it to try threads again). Any other silence ends in an error message instead of a frozen page.
- **onnxruntime is loaded from its own file** at run time (`piper.ts`), not bundled into the worker, and on first use rather than with a top-level await, so no early message to the worker is lost.
- **Cross-origin isolation** gives multi-threaded WASM, which makes Piper several times faster. The dev and preview servers send the headers. On GitHub Pages the service worker adds them, which needs one reload on the first visit (`src/ui/pwa.ts`).
- **The page logic is split by step.** `main.ts` starts the page and owns `refresh`, which re-reads the transcript and redraws what depends on it. `dom.ts` holds the element references, `state.ts` the shared state (settings, casting, the parsed turns) and a `refresh` that any module can call without importing `main.ts`. `transcript.ts` covers steps 1 and 2 (loading, pasting, jumping to items), `translation.ts` the translation card and its review dialog, `voices.ts` languages, engines and the choice of voices, `cards.ts` the speaker cards and previews, `output.ts` rendering and saving, and `shell.ts` appearance, settings, presets and the footer. Imports go one way (`main` → the parts → `voices`/`shell` → `state`/`dom`); keep it so.
- **The render cache** (`src/audio/cache.ts`) is an IndexedDB database with two stores: the audio of each sentence, and its size in bytes under the same key. The sizes are what the page adds up to show the space in use, so that the audio itself need not be read. Version 2 of the database added the sizes and measures existing audio once when upgrading.
- **Version and updates.** `vite.config.ts` puts the version from `package.json` and the build date into the footer. A new deploy changes `sw.js`, so browsers install the new service worker on the next visit; the page itself is fetched network-first, so an online visit already gets the new version. `checkForUpdate` in `src/ui/pwa.ts` forces that check and reloads when a new worker has taken over. Raise the version in `package.json` for every release.
- **The published build leaves out onnxruntime's WebGPU runtime** (21 MB). The bundler copies it because transformers.js refers to it, but Kokoro loads its runtime from jsDelivr and never requests the local copy; `closeBundle` in `vite.config.ts` deletes it.
- **Long recordings.** Loudness is measured across a voice's sentences without joining them, and the transcript is re-read 200 ms after typing stops rather than on every key. Peak memory is still roughly three times the size of the decoded audio (about 300 MB per hour at 24 kHz): the sentences, the assembled track and the MP3 being built.
- **`npm audit`** reports issues in `sharp`, `onnxruntime-node` and `sprintf-js`. They come in through transformers.js and mammoth as Node-side code (image processing, the Node runtime, a command-line parser) and are not part of what the browser runs; none has a fix available upstream at the time of writing.
- **The service worker is only registered in production builds**, so it never interferes with `npm run dev`.
- **Loudness** is measured per voice (ITU-R BS.1770) so speakers are balanced, then a peak limiter keeps the result under −1 dBFS. Integrated loudness of the whole file lands slightly under the target because of the pauses.
- **MP3 at 24 kHz and below is MPEG-2**, which allows at most 160 kbps; `effectiveBitrate` picks the nearest valid rate.
- **Runtime downloads:** Piper voices come from `rhasspy/piper-voices` on Hugging Face (cached in OPFS) and Kokoro from `onnx-community/Kokoro-82M-v1.0-ONNX` (Cache Storage). Piper's onnxruntime WASM and the phonemizer are bundled with the app; Kokoro's runtime comes from jsDelivr and is cached by the service worker.
- **PDF extraction** (`src/parse/pdf.ts`, with pdf.js doing the reading in `pdf-read.ts`) works on positioned text runs. The body size and typeface are the most common ones by character count; everything is judged against them.
  - *Lines and order.* Runs are joined into lines in the order the file stores them, using the end-of-line flag pdf.js reports, because that order is normally the reading order (column by column). Only when a quarter of the lines sit side by side with the one before (a file written row by row) are lines re-sorted by position, left column first. On the first page, a title and summary stored after the column beside them are moved to the front.
  - *Dropped.* Lines in the top or bottom margin that repeat on at least half the pages, small print in those margins, lone page numbers (also as `[22]`), raised digits smaller than the words they follow (footnote and citation markers), small print wholly to the left or right of the body text (side notes), the small-print block below the last body line (footnotes), small print above the first body line of page one, and "insets": a stretch of lines that are not body text and contain a caption label (`Fig. 2 |`, `Table 1.`, `Box 3:`), which takes figure labels, captions, table rows and boxes with it. The text ends where the references begin: at a heading such as "References" or "Bibliografía", or at a numbered entry followed closely by at least three more that start with a surname and initials.
  - *Paragraphs.* Each line is assigned to a column by the left edges that many lines share; the column's right edge is where most of its lines end. Paragraphs break at first-line indents, extra vertical space, a change of size, a short last line, or a short line in another typeface (a heading). Words split across lines are rejoined at a hyphen. Some files leave that hyphen out: in a justified column, a line that stops a hyphen's width short of the edge is joined to the next, unless both halves are known words of the document or occur together inside a line ("higher order").
  - *Known gaps.* Tables and figures without a label, block quotes in smaller type at the foot of a page (taken for footnotes), pages with three or more columns of body text, and authors or affiliations under the title. `scripts/pdf-dump.mjs` prints how pdf.js sees a file, for tuning these rules.
- **Sections in text without speakers.** `pdf.ts` writes each section heading as a markdown `## Heading` line: the titles of the PDF outline when at least two of them match a paragraph, otherwise single short lines in capitals, in larger type, in a typeface other than the body's (pdf.js gives each font an identifier, which is enough to tell bold from regular) or starting with a section number. Several heading-like lines in a row count as one heading, and a heading with nothing after it is dropped. When the parser finds no speakers (or is told there are none), every `#` heading starts a new turn with a `title`; the renderer carries the title on its cues and `toChapters` uses it as the chapter name. With speakers present, `#` is ordinary markup and is ignored. Translation puts the `## ` back in front of each section.
- **Chapters** are ID3v2 `CHAP`/`CTOC` frames. The tag library cannot write them, so `captions.ts` builds them and inserts them into the tag it produced. A table of contents holds at most 255 entries, so longer transcripts get one chapter per several turns.
- **Cue sheet.** Many desktop players ignore `CHAP` frames in MP3 files, so the same chapters can be saved as a `.cue` file that names the MP3 beside it. It is written as UTF-8 with a byte-order mark and holds at most 99 tracks. `scripts/mp3-info.mjs` prints the tags and chapters an independent parser finds in a finished MP3.
- **Captions and chapters use real timings**: `assemble()` reports where each sentence landed in the output.
- **Translation models** are `Xenova/opus-mt-*` on Hugging Face, about 110 MB per pair (quantised). The list of pairs in `src/translate/pairs.ts` was checked against the repositories that exist; pairs without a direct model go through English. Multi-target models such as `en-ROMANCE` (needed for Portuguese and Catalan) are not used.
- **Stored in the browser:** settings, casting by speaker name, the dictionary and presets in `localStorage` (keys prefixed `synthpod.`); rendered sentences in IndexedDB (`synthpod`).

## Components and licences

| Component | Licence |
|---|---|
| [piper-wasm](https://github.com/diffusion-studio/piper-wasm) (espeak-ng phonemizer build) | MIT; espeak-ng itself is GPL-3.0 (see below) |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | MIT |
| [kokoro-js](https://github.com/hexgrad/kokoro) and the Kokoro-82M model | Apache-2.0 |
| [Opus-MT](https://github.com/Helsinki-NLP/Opus-MT) translation models | CC-BY-4.0 |
| [transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 |
| [@breezystack/lamejs](https://github.com/shijinyu/lamejs) (MP3 encoder) | LGPL-3.0 |
| [browser-id3-writer](https://github.com/egoroof/browser-id3-writer) (ID3 tags) | MIT |
| [mammoth](https://github.com/mwilliamson/mammoth.js) (`.docx` reading) | BSD-2-Clause |
| [pdf.js](https://github.com/mozilla/pdf.js) (`.pdf` reading) | Apache-2.0 |
| [franc-min](https://github.com/wooorm/franc) (language detection) | MIT |

**Keeping the app MIT.** The phonemizer contains espeak-ng, which is GPL-3.0. It is not compiled or linked into the app: it ships as its own unmodified WebAssembly file and data file, which the app starts as a separate program and exchanges text with. Keep it that way; do not copy its source into `src/`. The MP3 encoder (LGPL-3.0) is likewise used as an unmodified, replaceable library.

The development-only test dependency [music-metadata](https://github.com/Borewit/music-metadata) (MIT) reads finished MP3 files back to check tags, duration and chapters.

Piper voices are licensed individually. Check a voice's `MODEL_CARD` in [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices); some training datasets restrict use.

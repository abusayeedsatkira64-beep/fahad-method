# FAHAD METHOD

Preservation-first MP4/MOV container optimization, stream verification, and delivered-media inspection.

## Requirements

- Node.js 20+
- FFmpeg and FFprobe on `PATH`
- `yt-dlp` on `PATH` for the TikTok analyzer
- React, React DOM, TypeScript, and esbuild available to build the frontend

In the supplied workspace, React/React DOM/esbuild are preinstalled. To build:

```sh
npm run build
npm start
```

Open `http://localhost:4173`. Set `PORT` or `HOST` to override the defaults. The server binds to `127.0.0.1` by default and uses Node's built-in HTTP modules, so no Express package is required at runtime. Set `HOST=0.0.0.0` only when intentionally exposing it on a network. Frontend styles are self-contained responsive CSS; no Tailwind runtime is required.

## What the optimizer actually does

- Accepts `.mp4`, `.mov`, and `.m4v` uploads up to 1 GiB, streamed to a private temporary directory.
- Uses FFprobe and a bounded ISO BMFF box parser to inspect file/stream metadata and the `ftyp`, `moov`, `mdat`, track, media, sample-table, and related box hierarchy.
- Uses FFmpeg `-map 0 -c copy -map_metadata 0 -map_chapters 0 -movflags +faststart -f mp4`. It never chooses an encoder, quality preset, frame-rate conversion, or scaling filter. No claim is made that this reproduces proprietary Haze processing.
- Re-probes the output, compares stream parameters and SHA-256 stream hashes, checks that `moov` precedes `mdat`, then decodes output video/audio to validate playback before enabling download.
- The output may be slightly larger or smaller; this is container remuxing, not a compression promise. Unsupported or unsafe stream-copy cases fail rather than being silently re-encoded.
- Temporary jobs and their source/output files are removed after one hour.

## TikTok analyzer limits

The analyzer accepts HTTPS TikTok video URLs only and uses the installed `yt-dlp` extractor to retrieve accessible media. FFprobe inspects the actual retrieved copy; public counts are read from page metadata when present and otherwise shown as unavailable. Private, removed, region-restricted, or extractor-blocked videos cannot be analyzed. Reported media properties describe TikTok-delivered media, not the original upload; TikTok may transcode uploads on its own systems.

## Tests

`npm test` runs parser and HTTP integration tests. It creates and processes synthetic 1080p30, 1080p60, 4K60, 120 fps, MOV, and 10-bit HDR/PQ samples where the local encoder is available. Tests confirm stream and codec-extradata hashes, stream parameters, MP4 atom ordering, decode validation, and the actual downloaded bytes. No third-party video fixtures are included.

## Security notes

- No API keys, subscription flows, or external paid services.
- Child processes use fixed executable names, argument arrays, and `shell: false`.
- TikTok URLs are HTTPS and hostname/path allowlisted before the extractor is invoked.
- Upload size is enforced while streaming, not only by the browser.
- Temporary output download is available only after successful independent verification.

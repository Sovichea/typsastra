# Typsastra benchmark report

Generated: 2026-07-18T05:14:02.171Z<br>
Revision: `d235150` (working tree had uncommitted changes)

## Scope

The automated report measures CLI compiler process time, incremental
spellcheck-range calculation, and built frontend artifact size. A separate
manual observation below records desktop memory behavior; it is not produced by
the benchmark harness. The report does **not** claim automated end-to-end WebView
preview latency, gesture smoothness, or scrollbar-release timing.

## Machine and tools

| Item | Value |
|---|---|
| OS | Windows_NT 10.0.26200 (x64) |
| CPU | Intel(R) Core(TM) Ultra 7 155H (22 logical CPUs) |
| Installed memory | 15.37 GiB |
| Bun | 1.3.14 |
| Typst | typst 0.15.0 (3ae52774) |
| Tinymist npm package | 0.12.16 (managed runtime not exercised by this harness) |

## Results

Each warm compiler result contains five fresh Typst CLI processes after a fixture-specific warmup.

| Workload | Minimum | Median | p95 / maximum |
|---|---:|---:|---:|
| One-page compile | 297.24 ms | 298.27 ms | 313.11 ms |
| 20-page multilingual interaction fixture compile | 333.95 ms | 356.22 ms | 404.61 ms |
| 30-page compile | 350.87 ms | 378.95 ms | 402.24 ms |
| 100-page compile | 455.33 ms | 470.26 ms | 474.70 ms |
| 1,000 incremental range calculations | 15.16 ms | 18.29 ms | 35.80 ms |

- First-process one-page compile: **535.78 ms**. This does not clear OS filesystem caches.
- Largest submitted incremental spellcheck range: **32 UTF-16 units** from a 100,000-unit document.
- Built frontend `dist/` size: **3.91 MiB**. This is not installer size.
- The generated 20-page interaction PDF is **129.08 KiB**.

## Preview interaction qualification

The implementation now records these in-app metrics:

```text
preview.motion-handler
preview.motion-settle
preview.deceleration-prerender
preview.destination-final-commit
preview.render-cancel
preview.render-promote
```

The repository does not yet publish gesture-scroll or scrollbar-release numbers. Those measurements require actual input inside Windows/WebView2 and Linux/WebKitGTK. Developer diagnostics emit rolling p50, p95, and maximum summaries after every 20 samples.

The v1.0 targets remain:

| Interaction metric | Target |
|---|---:|
| Motion handler p95 | under 8 ms |
| Final destination page p95 | under 500 ms |
| Resident final canvases | 7 maximum |

Manual Windows/WebView2 A/B qualification selected PDF.js hardware acceleration with direct canvas ownership and browser FontFace rendering. It was materially faster than path-based embedded-glyph rendering. Gesture deceleration, split-page settle rendering, and native scrollbar-release fallback were then qualified interactively. This is observational qualification, not a published timing benchmark.

## Manual Draft Preview benchmark

Recorded on 2026-07-28 using the Windows/WebView2 development build at 79%
preview zoom. The two fixtures use private local photographs; neither the
images, their filenames, nor their contents are distributed with this report.

The optimized fixture contains 208 image calls and produces 208 pages. The
pathological fixture contains 10 unusually expensive raster images and produces
11 pages. Normal Preview uses the original images. Draft Preview replaces them
with ratio-preserving placeholders inside Typsastra's private render mirror.
PDF export remains unaffected and continues to use the originals.

The derived readiness estimate is:

```text
Draft preparation + compilation + PDF loading + first visible-page rendering
```

It does not add canvas, destination-commit, annotation, or geometry measurements
because those overlap the first-page path. Background thumbnail generation is
also excluded. “Cold” and “warm” are operator-recorded observations; operating
system caches were not explicitly flushed, and each case is a single run rather
than a distribution.

| Fixture | Mode | Run | Prepare | Compile | Load | First page | Derived readiness | Preview PDF |
|---|---|---|---:|---:|---:|---:|---:|---:|
| 208 optimized images | Normal | Cold | 185.5 ms | 1,069.5 ms | 575.6 ms | 82.7 ms | 1,913.3 ms | 75,718,695 B |
| 208 optimized images | Normal | Warm | 124.3 ms | 1,022.7 ms | 98.8 ms | 56.2 ms | 1,302.0 ms | 75,718,695 B |
| 208 optimized images | Draft | Cold | 335.8 ms | 379.8 ms | 650.5 ms | 26.7 ms | 1,392.8 ms | 328,954 B |
| 208 optimized images | Draft | Warm | 277.3 ms | 329.8 ms | 99.6 ms | 20.6 ms | 727.3 ms | 328,954 B |
| 10 pathological images | Normal | Cold | 170.1 ms | 2,289.7 ms | 860.2 ms | 2,034.7 ms | 5,354.7 ms | 513,684 B |
| 10 pathological images | Normal | Warm | 158.9 ms | 918.5 ms | 96.3 ms | 708.7 ms | 1,882.4 ms | 513,684 B |
| 10 pathological images | Draft | Cold | 505.0 ms | 538.2 ms | 913.3 ms | 24.0 ms | 1,980.5 ms | 21,382 B |
| 10 pathological images | Draft | Warm | 349.4 ms | 373.7 ms | 84.1 ms | 21.8 ms | 829.0 ms | 21,382 B |

### Findings

- For 208 optimized images, Draft reduced derived readiness by approximately
  27% cold and 44% warm. Normal Preview was already responsive after loading,
  so the difference is useful but not dramatic.
- For 10 pathological images, Draft reduced derived readiness by approximately
  63% cold and 56% warm.
- Pathological first-page rendering fell from 2,034.7 ms to 24.0 ms cold
  (about 85 times faster) and from 708.7 ms to 21.8 ms warm (about 33 times
  faster).
- Pathological canvas rendering fell from 1,991.5 ms to 17.3 ms cold and from
  703.4 ms to 17.8 ms warm. Normal Preview also spent 2,460.5 ms rendering the
  second page during the cold observation.
- The optimized Draft PDF was approximately 99.6% smaller than its Normal
  Preview counterpart. The pathological Draft PDF was approximately 95.8%
  smaller.
- The pathological Normal PDF was only about 0.5 MB despite its expensive
  rendering. Encoded PDF size alone therefore does not predict image decode or
  canvas-rendering cost.
- Reported JavaScript heap stayed between 17.7 MiB and 19.9 MiB. This is not
  total WebView, GPU, backend, or Tinymist process memory.
- The editor became usable after 744.4 ms in the recorded cold startup.
  Language-provider startup completed separately after 3,324.6 ms for three
  providers and is not included in preview readiness.

These results support treating Draft Preview as a latency stabilizer rather
than a universal faster mode. Its largest benefit is isolating authoring
responsiveness from individual images whose decode or rendering cost is
disproportionate to their encoded PDF size.

### Thumbnail cache observation

Thumbnail creation runs outside the readiness estimate.

| Fixture | Initial generation | Cached lookup | Cache output |
|---|---:|---:|---:|
| 208 optimized images | 23,612.1 ms | 71.2–81.7 ms | 9.34 MiB |
| 10 pathological images | 7,496.3 ms | 2.4–5.1 ms | 0.19 MiB |

The 208-image run spent 4,555.0 ms decoding, 10,378.8 ms resizing, and
8,047.4 ms encoding. The pathological run spent 3,151.7 ms decoding,
3,317.0 ms resizing, and 806.1 ms encoding. This one-time work is deliberately
asynchronous; subsequent cache lookup is inexpensive.

## Release PDF transport qualification

A Windows release-build comparison used the same 76.3 MiB, 46-page PDF in
both runs. The legacy path read the complete PDF through one Tauri IPC response.
The replacement path uses bounded local byte ranges and progressively prefetches
data into the PDF.js worker.

| Transport | Peak WebView during source transfer | WebView when viewer installed | JavaScript heap when viewer installed | Data read when viewer installed |
|---|---:|---:|---:|---:|
| Full IPC buffer | 2,920.8 MiB | 1,565.1 MiB | 857.1 MiB | 76.3 MiB |
| 1 MiB ranges with worker prefetch | no equivalent transfer spike | 656.0 MiB | 30.8 MiB | 3.3 MiB |

The full-buffer spike occurred before PDF.js opened the document or allocated a
visible canvas: WebView memory rose from 636.5 MiB to 2,920.8 MiB immediately
after the IPC read. This identifies production IPC/JavaScript representation
amplification as the cause rather than page rasterization. Bounded range
transport removed that spike while the larger one-MiB chunks and progressive
worker prefetch improved distant-page rendering after scrollbar release.

These are single-machine working-set observations rather than universal memory
figures. The full-buffer path remains available through an explicit developer
experiment for regression comparison; normal builds use range transport.

## Manual 200-page memory observation

On the same Windows development machine, the same approximately 200-page Typst
document was opened in the Typsastra development build and in the local Visual
Studio Code/Tinymist SVG-preview setup. Windows Task Manager working-set values
were recorded after compilation and during the following idle observation.

| Observation | Application / renderer | Tinymist | Development server | Approximate total |
|---|---:|---:|---:|---:|
| Typsastra peak capture | 613.8 MiB | 214.4 MiB | 433.4 MiB | 1,261.6 MiB |
| Typsastra later capture | 528.4 MiB | 214.2 MiB | 303.7 MiB | 1,046.3 MiB |
| Typsastra later capture, excluding dev server | 528.4 MiB | 214.2 MiB | — | 742.6 MiB |
| VS Code initial capture | 887.7 MiB | 423.7 MiB | included in VS Code group | 1,311.4 MiB |
| VS Code later capture | 4,227.8 MiB | 265.0 MiB | included in VS Code group | 4,492.8 MiB |
| VS Code final capture | 4,534.8 MiB | 263.0 MiB | included in VS Code group | 4,797.8 MiB |

Typsastra's application/WebView working set fell after its peak while Tinymist
remained close to 214 MiB. The observed VS Code process group continued growing
through the final capture and did not reach a stable idle value. Its final
combined observation was about 6.5 times Typsastra's later production-equivalent
total, which excludes the Vite/Node development server.

This comparison is evidence for the bounded PDF-canvas architecture on this
fixture and machine, not a universal VS Code claim. The VS Code process group
includes the user's installed extensions, Task Manager reports working set rather
than a controlled private-byte process tree, input timing was not automated, and
no raw sampling trace was captured. A separate 500-page stress attempt reached
approximately 7 GiB in the observed VS Code environment and crashed before it
settled; that attempt is recorded only as a stress observation, not a comparable
benchmark result.

## Comparison with the 2026-07-13 run

The current run is slower for the CLI fixtures and slightly faster for median incremental-range calculation. These are separate five-sample runs on a non-isolated development machine, so the differences should not be attributed to the preview scheduler implementation.

| Workload | 2026-07-13 median | 2026-07-18 median |
|---|---:|---:|
| One-page compile | 238.46 ms | 298.27 ms |
| 30-page compile | 273.26 ms | 378.95 ms |
| 100-page compile | 364.54 ms | 470.26 ms |
| 1,000 incremental range calculations | 21.15 ms | 18.29 ms |

## Limitations

- The first-process compile does not clear operating-system filesystem caches.
- Typst CLI process timings are not equivalent to in-app Tinymist preview latency.
- Frontend `dist/` size is not installer size.
- Desktop, WebView, PDF renderer, GPU, and Tinymist memory are not measured by
  the automated harness. The manual table above is a Task Manager observation.
- The working tree contained the preview interaction implementation being measured but had not yet been committed.

## Reproduce

From the repository root, with Typst available on `PATH`:

```sh
bun install --frozen-lockfile
bun run build
bun run benchmark:performance
```

The harness writes a Markdown report and raw JSON under the ignored `artifacts/performance/` directory. The raw data for this published run is committed at [`benchmarks/results/2026-07-18-windows.json`](https://github.com/Sovichea/typsastra/blob/main/benchmarks/results/2026-07-18-windows.json).

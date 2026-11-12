# Kick Extractor

Pull the kick out of a hardstyle track, right in the browser. Upload an MP3, get every kick variant as a WAV.
Static site, no server, no build step; the audio never leaves the device.

## How it works

Hardstyle is close to a best case for this: the kick is one sample, repeated hundreds of times on a
steady 4/4 grid, and it's the loudest thing in the mix. So:

1. **Find kicks**: spectral-flux onsets (30 Hz–10 kHz), then a precise tempo/phase fit
   (circular periodogram over onset times). Only hits on the beat grid are kept, which drops off-beat
   sounds. Hits with hardly any bass (e.g. chord changes in the breakdown) are dropped too.
   A bass-only onset detector does *not* work for rawstyle: the reverse bass swells up right before
   each kick, so the low end gets quieter when the kick hits.
2. **Group**: k-means on attack + tail spectra (fine 1/6-octave bands 30–250 Hz on the tail), so
   re-pitched kicks, kick + clap on 2 & 4, and melodic-section kicks become separate results.
   Auto mode over-clusters (up to 8) and merges groups whose averages correlate > 0.85.
3. **Align** within each group: cross-correlation against the group median, 3 passes.
4. **Average**: sample-wise median (and mean) over all level-matched hits per group. Everything that
   isn't locked to the kick (melody, vocals, screeches) cancels out. Groups are ranked by consistency
   x loudness (the drop kick is usually the loudest thing in a hardstyle track); inconsistent groups
   are tucked away as "noisy".
5. **Split**: if the averaged beat has a near-silent gap (rawstyle: kick, gap, reverse bass), the kick
   and the off-beat part are also exported separately. The page also ranks the individual hits
   closest to the average ("cleanest single hits").

Tested on a synthetic track (`test/`) and on Sickmode & Rooler – *Too Cold* (160 BPM rawstyle).

**Limits:** you get the kick as it sounds in the finished master, not the dry sample, and anything
that hits exactly with the kick every time (layered clap, a reverse bass right behind it) stays in.

## Downloads

Every result downloads as WAV (24-bit) or MP3 (320 kbps, encoded in the browser with
[lamejs](https://github.com/zhuker/lamejs), LGPL-3.0, vendored in `vendor/`). MP3 always adds ~25 ms of
silence at the start (encoder delay), so WAV is the better choice for putting kicks into a DAW.

## Files

```
index.html       UI
css/style.css
js/app.js        UI logic: decoding, drawing, playback, WAV download
js/worker.js     runs the analysis in a Web Worker
js/dsp.js        all signal processing (pure functions, also runs in Node)
vendor/          lamejs MP3 encoder (loaded only when an MP3 is requested)
test/synth-test.mjs   synthetic hardstyle track with known kicks -> checks the pipeline
```

## Run locally

ES modules and workers need http, not `file://`:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

Test:

```sh
node test/synth-test.mjs                       # PASS/FAIL
node test/synth-test.mjs --write synth.wav     # also writes the test track
```

## Hosting

Any static host works. On GitHub: Settings → Pages → Deploy from branch → `main` / root.

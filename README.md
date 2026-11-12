# Kick Extractor

Pull the kick out of a hardstyle track, right in the browser. Upload an MP3, get every kick variant as a WAV.
Static site, no server, no build step; the audio never leaves the device.

## How it works

Hardstyle is close to a best case for this: the kick is one sample, repeated hundreds of times on a
steady 4/4 grid, and it's the loudest thing in the mix. So:

1. **Find kicks**: onsets in the energy below 150 Hz, then a precise tempo/phase fit
   (circular periodogram over onset times). Only hits on the beat grid are kept, which drops off-beat
   reverse basses. Hits that aren't bass-heavy (e.g. chord changes in the breakdown) are dropped too.
2. **Align**: each hit is shifted by cross-correlation against the median hit.
3. **Group**: k-means on attack + tail spectra (fine 1/6-octave bands 30–250 Hz on the tail), so
   re-pitched kicks and kick + clap on 2 & 4 become separate results. The number of groups is picked
   by silhouette score, or set manually.
4. **Average**: sample-wise median (and mean) over all level-matched hits per group. Everything that
   isn't locked to the kick (melody, vocals, screeches) cancels out. The page also ranks the
   individual hits closest to the average ("cleanest single hits").

**Limits:** you get the kick as it sounds in the finished master, not the dry sample, and anything
that hits exactly with the kick every time (layered clap, a reverse bass right behind it) stays in.

## Files

```
index.html       UI
css/style.css
js/app.js        UI logic: decoding, drawing, playback, WAV download
js/worker.js     runs the analysis in a Web Worker
js/dsp.js        all signal processing (pure functions, also runs in Node)
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

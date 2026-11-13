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

6. **Song snippets**: every beat is labelled (drop kick / other kick / no kick); the downbeat is the
   beat phase where labels and loudness change most; bars are grouped into sections. The most typical
   2 bars of each section become a loop (drop, melodic part, break, second drop), and the drop's first
   2 beats and the 2 bars before it become transition sounds.

## Tabs

Bottom bar with four tabs: **Extract**, **Launchpad**, **Track**, **Library**.

## Launchpad, Track Builder and Library

Every sound has a **+LP** button: it saves the sound to the Library and puts it on a 4x4 pad grid (pick
the pad in a small window, or save it to the library only). The Library lists every saved sample,
whether or not it is on a pad; from there you can play, download, move it to another pad, take it off
its pad, or delete it.
Pads are grey until assigned, then coloured by category (kick, off-beat, full beat, single hit, loop,
break, transition). One-shots retrigger; loops toggle and start on the next beat of whatever is already
looping. Keys 1–4 / Q–R / A–F / Z–V (physical positions, so QWERTZ works too), Space stops everything.

The **Track** tab is a multi-lane beat/bar sequencer where you can build a track from Library samples,
sounds from the current Extract session, or imported WAV/MP3/FLAC files. Paint or drag hits on the
grid, use quick fill patterns (4/4 beats, off-beats, 2 & 4), shift individual kick pitches in
semitones, mix lane levels with Mute/Solo, and bounce the arrangement to WAV, MP3, or the Launchpad.
Library, pads, and the Track arrangement are stored in IndexedDB, so they survive a reload and can mix sounds from different songs.

## Design

PS2 system-menu blue-black, with one low-res synthwave scene in the masthead (rendered at about a fifth
of screen resolution with ordered dithering, scrolling one grid line per beat while loops play; pad
hits flash it). Michroma + Chakra Petch (self-hosted, OFL), panels with one notched "memory card"
corner, stepped (LED-like) animations, no gradients on UI, no purple.

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
js/app.js        Extraction tab: decoding, drawing, results
js/audio.js      playback + WAV/MP3 export
js/launchpad.js  Launchpad tab, "+LP" pad picker, pad engine
js/track.js      Track Builder tab, sequencer + offline bounce
js/library.js    Library tab
js/store.js      library, pads, and track arrangement (IndexedDB)
js/scene.js      the masthead scene
fonts/           Michroma, Chakra Petch (OFL)
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

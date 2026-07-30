# ASSET RELEASE TERMINAL

A static escape room. Five gated stages: four yield one code digit each, and
the fifth is a gate-only human authorization step that yields no digit. Passing
all five reveals the 4 digit combo that opens a physical lockbox. Phone first,
no backend, no dependencies.

## WARNING

`puzzles.src.json` and `COMBO.txt` hold the answers and the combo in plaintext.
**Never commit them. Never paste them anywhere.** Both are in `.gitignore`.
If either one lands in a commit, the game is over: rotate the combo, rebuild,
and rewrite history before pushing.

## How it works

`tools/build.mjs` compiles the plaintext source into `puzzles.js`, which holds
only salted SHA-256 hashes and AES-256-GCM ciphertext:

- an answer is checked as `SHA-256(salt + normalize(input))` against a hash list
- each stage's riddle, hints, and digit are encrypted with a key derived from
  the previous stage's canonical answer (PBKDF2-SHA256, 150000 iterations)
- stage 1 uses the literal string `boot`, so the first riddle opens on load
- the combo lives in `finalPayload`, keyed off the stage 5 answer
- a stage may list accepted aliases. Every key in the chain comes from the
  canonical answer, so each alias ships a small blob holding that canonical
  answer encrypted under the alias itself. Answering with any accepted alias
  chains identically, and none of it opens without a correct answer first

Nothing is readable in `view-source:` until it is earned. `grep` gives nothing.

## Rebuild

```sh
node tools/build.mjs
```

Reads `puzzles.src.json`, writes `puzzles.js` and `COMBO.txt`. It hard fails if
there are not exactly 5 stages, if there is not exactly 1 gate-only stage
(`"digit": null`) sitting last, if the 4 digit-carrying stages do not number 4,
if the combo is not 4 characters, or if the combo does not equal the non-null
stage digits concatenated in array order. It also greps its own output for every
answer and for the combo and refuses to write if it finds one.

Answers shorter than 4 characters cannot be verified that way, since short
strings turn up inside random base64 by chance, so those get a loud warning
instead. Keep answers at 4 characters or more.

To test the compiler without the real content:

```sh
node tools/build.mjs tools/fixture.example.json
```

## Run locally

```sh
python3 -m http.server 8765
# then open http://localhost:8765
```

`http://localhost` and `https://` are secure contexts, which Web Crypto
requires. Opening `index.html` as a `file://` URL will not work.

## Deploy

Commit `index.html`, `styles.css`, `app.js`, `puzzles.js`, `mastermind.js`, and
`tools/`, then serve the repo root from GitHub Pages. No build step runs on the
host: `puzzles.js` is committed pre-compiled.

## Player notes

- Hints unlock 10 minutes into each stage, three per stage, one per press.
- Stage 5 needs another person, so MERCY is promoted to a primary control there.
- MERCY in the footer opens a text message. The site never reveals the combo.
- Progress is saved in `localStorage`. Pressing `r` five times fast wipes it.

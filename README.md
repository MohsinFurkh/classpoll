# ClassPoll

Live polling for a room full of students, on a projector, with no accounts and
no app to install. Students scan a QR code, tap once, done.

**Zero dependencies.** No `npm install`, no CDN, no database. One file of Node
standard library, four static pages. It runs on a classroom laptop with the wifi
off the internet entirely.

```bash
node server.js
```

That prints something like:

```
  Teacher console : http://localhost:3000/host

  Students join from the classroom wifi at:
    http://192.168.1.20:3000
```

Use a different port with `node server.js 8080` or `PORT=8080 node server.js`.

## The three screens

| URL | Who | What |
| --- | --- | --- |
| `/host` | teacher, on the laptop | build the question, open/close voting, moderate |
| `/d/CODE` | the projector | question, QR code, live results |
| `/CODE` | students, on phones | one question, one tap |

Open `/host` first — it creates a room and shows the code. Click **Open
projector view** and drag that window to the projector, ideally fullscreen (F11).
Keep the host window on the laptop screen: it holds the answer key and the
controls, and neither belongs in front of the class.

### Choosing your own room code

`/host?code=MTBN` claims that specific code instead of being handed a random
one. Use it whenever the code is printed somewhere ahead of time — on a slide,
in a handout, on the whiteboard. Any four letters A–Z work.

If someone already has that room open you get a clear "already in use" message
rather than silently taking over a live lecture. Reloading your own console
reclaims it.

Rooms live in memory, so a restart wipes them. The console handles this: it
remembers the code it was using and claims it back, rather than picking a new
one and orphaning a room full of phones. Student pages and the projector retry
by themselves until the room reappears, so a host that sleeps and wakes
mid-lecture costs you a few seconds rather than asking sixty people to refresh.
Press **New room** when you actually want a different code.

## Question types

**Multiple choice** — 2 to 6 options, optional correct answer. Results are a bar
chart; the correct bar turns green on reveal.

**Single word** — students type one or two words. Results are a word cloud where
size means how many people said it. Answers are normalised, so `Fast!`, `fast`
and ` FAST ` are one word.

**Short sentence** — up to 140 characters. Results are a wall of cards, newest
first.

**Multi-part** — several sub-questions on one screen, answered together and sent
once. Use it when splitting them up would waste the room's time: six items to
sort into three buckets, a four-question checkpoint quiz, four statements to
critique. Each part is independently multiple choice or free text, and the
projector shows every part at once so the class can see the pattern across them —
which item split the room, which one everybody agreed on.

Multi-part questions are authored in a deck file rather than typed into the host
form; editing six sub-questions through a web form mid-lecture is not a real
workflow. The console shows the parts and their answer key read-only, on the
laptop, where the key belongs.

Two behaviours worth knowing. **Partial answers count** — Send is always live and
the phone shows "4 of 6", so a student stuck on one part is still counted on the
rest; sending again replaces the whole set, so they can come back and fill gaps.
And **tapping a chosen option again clears it**, because a misfire on a phone
should be recoverable.

For free-text questions the host panel grows a **Moderation** list. Click *hide*
next to anything you do not want on the projector and it disappears from the
display immediately. With 100 students and a text box, you will want this. On a
multi-part poll each answer is moderated separately, so hiding one clumsy
sentence never deletes that student's other five.

## Decks — a lecture's questions in running order

Typing a question into the host form while thirty people watch is the worst
moment in a live poll. A **deck** is a JSON file holding one lecture's questions
in slide order. Drop it in `public/decks/` and it appears in a dropdown at the
top of the host console, with the running order underneath it.

Clicking a row — or **Next** — loads that question into the form: type, wording,
options, correct answer. It does **not** push anything to the projector. That
stays a deliberate act, because when a question appears is a timing decision that
belongs to the person in the room. Review what loaded, then press *Set question &
open voting* as usual.

The console remembers which deck and which question you were on, so a browser
reload in the middle of a lecture comes back to the same place.

There is no index to maintain. The server reads the folder, so adding a file is
the whole installation step. A deck that will not parse is skipped rather than
being allowed to break the dropdown two minutes before class.

```json
{
  "title": "CSEG3060 · Unit I · L01 — Understanding the Research Problem",
  "questions": [
    {
      "slot": "Poll 1",
      "label": "Why did a 90%-accurate model fail?",
      "type": "choice",
      "question": "Why did a 90%-accurate model fail in the field?",
      "options": ["It was overfitted.", "Bad engineering.", "The problem was wrong."],
      "correct": 2,
      "liveResults": false
    }
  ]
}
```

| Field | | |
| --- | --- | --- |
| `title` | required | shown in the dropdown |
| `slot` | optional | short tag in the running order — `Poll 1`, `Quiz Q3`. Falls back to the position number |
| `label` | optional | one-line summary in the running order. Falls back to the question text |
| `type` | required | `choice`, `word`, `text` or `multi` |
| `question` | required | up to 300 characters |
| `options` | `choice` only | 2–6 options, up to 80 characters each |
| `correct` | optional | zero-based index into `options`, or `null` for an opinion poll |
| `parts` | `multi` only | 1–8 sub-questions, see below |
| `liveResults` | optional | omit it and the type's default applies — off for `choice`, on for `word` |

A `multi` question carries `parts` instead of `options`. Each part is a small
poll of its own:

```json
{
  "slot": "Quiz",
  "type": "multi",
  "question": "Answer all four. Commit before we reveal anything.",
  "parts": [
    {
      "label": "Q1",
      "prompt": "'Application of blockchain in healthcare.' This is:",
      "type": "choice",
      "options": ["A research problem", "A topic", "A hypothesis", "A methodology"],
      "correct": 1
    },
    { "label": "S1", "prompt": "Name the defect.", "type": "text" }
  ]
}
```

`label` is the short tag beside the part (`Q1`, `S3`, or just `4`); `prompt` is
the sub-question; `type` is `choice` or `text`. A `text` part takes no options
and has no right answer. Anything malformed is dropped rather than trusted, so a
typo in a deck costs you one part, not the lecture.

Two limits worth knowing when you write a deck: an option longer than 80
characters is silently truncated, and a student's `text` answer is capped at 140.
`decks/cseg3060-unit1-l01.json` is a worked example.

## Putting it on the internet

**GitHub Pages will not work.** Pages serves static files; it cannot run a Node
process, and this app is a server that holds the poll and pushes updates to every
connected phone. The repo can live on GitHub, but something has to run it.

Any host that runs a Node process works. [Render](https://render.com)'s free tier
is the least fuss: connect the GitHub repo, and `render.yaml` in this directory
configures the rest. There is no build step and nothing to install.

Hosting it is what makes the app work for students who are **not on your wifi**.
On a classroom laptop the join URL is a `192.168.x.x` address, which a phone on
mobile data — or on a college network that isolates clients — can never reach.
Hosted, everyone gets the same public HTTPS URL, and the QR code follows
automatically: the server reads the forwarded scheme so it never sends anyone to
`http://` on an `https://` site.

Three constraints that matter:

- **Keep it to one instance.** Poll state is in memory. A second instance would
  serve students a room the first has never heard of. `render.yaml` pins this.
- **Free tiers sleep.** Render idles a free service after ~15 minutes and takes
  most of a minute to wake. Open the host page a couple of minutes before class
  so the first student to scan does not meet a spinner. A restart no longer
  breaks a live lecture — the console reclaims its room code and the phones
  reconnect on their own — but it does clear the answers to the open question.
- **Set `HOST_KEY`.** See below. On a public URL this is the difference between
  a teacher console and a page your students can open.

### Locking the teacher console

Anyone with the URL can reach `/host`, and `/host` holds the answer key. On a
LAN that is a non-issue; on a public URL your students have the address.

Set a `HOST_KEY` environment variable in Render's dashboard and the console asks
for it once, then remembers it in that browser. `/host?key=...` works too, for a
bookmark — the key is stripped from the address bar immediately so it is not
sitting on screen in front of a class. Students need no key and never see a
prompt; nothing about voting changes.

Leave `HOST_KEY` unset and everything behaves exactly as before, which is what
you want when running on a classroom laptop.

### Walkthrough

1. Push this repo to GitHub.
2. On Render: **New → Blueprint**, pick the repo. `render.yaml` fills in the
   rest — no build command, `node server.js` to start.
3. Add an environment variable `HOST_KEY` with a secret only you know.
4. Open `https://<your-app>.onrender.com/host?code=MTBN&key=<your-key>` and
   bookmark it. That code is now stable across restarts, so you can print it on
   a slide.
5. A couple of minutes before class, open the bookmark to wake the service, then
   **Open projector view** onto the screen.

Hosted, students join over your public HTTPS URL instead of a LAN address, and
the QR code follows automatically — the server reads the forwarded scheme so it
never sends anyone to `http://` on an `https://` site.

## Things that were decided on purpose

**Results are hidden while a choice vote is open.** A visible leading bar makes
late voters follow the crowd. The projector shows a grid of dots filling in
instead, so the class can see participation without seeing the answer. The
checkbox on the host page overrides this, and it defaults to *on* for word
clouds, where watching the cloud fill up is the point.

**Re-voting overwrites.** Answers are keyed by a random id kept in the student's
`localStorage`, so a double-tap, a refresh, or a phone that locked its screen
does not produce a second vote. It is not anti-cheat — someone determined can
open a private window. This is a classroom, not an election.

**Broadcasts are coalesced to 4 per second.** When 100 students tap within three
seconds, a naive implementation sends 100 updates to 100 clients: ten thousand
messages for an animation nobody can perceive.

**SSE, not WebSockets.** Votes are one-shot HTTP POSTs, so nothing needs
client-to-server streaming. `EventSource` reconnects on its own and survives
proxies that mangle WebSocket upgrades.

**Nothing is persisted.** A poll's useful life is about ninety seconds. Rooms
live in memory and are dropped six hours after the last connection. Restarting
the server means new room codes.

## Before you stand in front of a class

1. Start the server, open `/host`, set a question, open voting.
2. Open the projector view and **scan the QR with your own phone.** Five seconds,
   and it confirms the address on screen is reachable from the wifi, not just
   from the laptop.
3. Simulate the room:

   ```bash
   node loadtest.js MKPQ
   ```

   Replace `MKPQ` with your room code. It opens 100 held-open connections and
   votes over ~4 seconds, then prints acceptance counts and latency percentiles.
   Watch the projector while it runs. `node loadtest.js MKPQ 250` for a lecture
   hall; add `192.168.1.20:3000` as a third argument to hit the server over the
   network rather than loopback.

The real bottleneck in a classroom is never the server — it is 100 phones on one
access point. Pages are a few KB with no external fonts or scripts so they load
on a congested network, and if the wifi dies mid-question the projector keeps
working and you can fall back to a show of hands.

## Development

`http://localhost:3000/selftest.html` runs the checks for the two pieces of
non-obvious client code:

- the QR encoder, by decoding its own output back to the original URL across
  versions 1–3 and EC levels L and M, plus structural checks on the finder,
  timing and alignment patterns;
- the word-cloud layout, checking every word is placed, none overlap, and
  nothing escapes the container.

The QR encoder is hand-written (byte mode, versions 1–10) so the projector page
pulls in no third-party library. If you change it, run the self-test, and scan
the result with a real phone.

## Layout

```
server.js              HTTP + SSE, all state in memory
loadtest.js            simulate N students
public/
  decks/*.json         lecture question sets, loaded from the host console
  index.html           enter a room code
  vote.html            student
  host.html            teacher console
  display.html         projector
  selftest.html        QR + word-cloud checks
  assets/
    app.css            shared styles, dark by default
    vote.js  host.js  display.js
    qr.js              QR encoder
    wordcloud.js       spiral layout
```

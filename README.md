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
in a handout, on the whiteboard. Rooms live in memory, so without this the code
changes every time the server restarts and anything printed in advance goes
stale. Any four letters A–Z work.

If someone already has that room open you get a clear "already in use" message
rather than silently taking over a live lecture. Reloading your own console
reclaims it.

## Question types

**Multiple choice** — 2 to 6 options, optional correct answer. Results are a bar
chart; the correct bar turns green on reveal.

**Single word** — students type one or two words. Results are a word cloud where
size means how many people said it. Answers are normalised, so `Fast!`, `fast`
and ` FAST ` are one word.

**Short sentence** — up to 140 characters. Results are a wall of cards, newest
first.

For free-text questions the host panel grows a **Moderation** list. Click *hide*
next to anything you do not want on the projector and it disappears from the
display immediately. With 100 students and a text box, you will want this.

## Putting it on the internet

**GitHub Pages will not work.** Pages serves static files; it cannot run a Node
process, and this app is a server that holds the poll and pushes updates to every
connected phone. The repo can live on GitHub, but something has to run it.

Any host that runs a Node process works. [Render](https://render.com)'s free tier
is the least fuss: connect the GitHub repo, and `render.yaml` in this directory
configures the rest. There is no build step and nothing to install.

Two constraints that matter:

- **Keep it to one instance.** Poll state is in memory. A second instance would
  serve students a room the first has never heard of. `render.yaml` pins this.
- **Free tiers sleep.** Render idles a free service after ~15 minutes and takes
  most of a minute to wake. Open the host page a couple of minutes before class
  so the first student to scan does not meet a spinner.

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
